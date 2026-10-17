#!/usr/bin/env node
// Maxwell Core, phase 0: a read-only node for the Maxwell chain. One file next to witness.mjs, Node 22 or newer, no dependencies. See docs/maxwell-core.md.
//
//   node maxwell-core.mjs init [--datadir DIR]        make the data folder and a maxwell.conf
//   node maxwell-core.mjs sync [--datadir DIR]        download the public chain, verify it, store it (refuses a chain that contradicts the one already stored)
//   node maxwell-core.mjs serve [--datadir DIR]       JSON-RPC on 127.0.0.1 with cookie authentication; syncs on a timer
//   node maxwell-core.mjs cli <method> [params...]    call a running node (reads the cookie file)
//   node maxwell-core.mjs witness --name N [--datadir DIR]   sign the head this node verified (key: <datadir>/witness/N.key; made with witness.mjs keygen)
//
// Modelled on Bitcoin Core's shape (daemon + CLI + data directory + cookie + familiar method names), not on its code. It never writes outside its data folder.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHAIN_URL, cosign, parseChainText, verifyChain, witnessStep } from './witness.mjs'
import { createPrivateKey, createPublicKey } from 'node:crypto'

export const VERSION = '0.1.0'
export const DEFAULTS = Object.freeze({ source: CHAIN_URL, rpcport: 8645, syncinterval: 3600 })
const HEX64 = /^[0-9a-f]{64}$/
const MAX_BODY = 64 * 1024

export class RpcError extends Error { constructor(code, message) { super(message); this.code = code } }

// ------------------------------------------------------------------------------------------------ data folder and config
export const defaultDatadir = () => join(homedir(), '.maxwell')
export function parseConfig(text) {
  const out = { ...DEFAULTS }
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) throw new Error(`bad line in maxwell.conf: ${line.slice(0, 40)}`)
    const key = line.slice(0, i).trim(), value = line.slice(i + 1).trim()
    if (key === 'source') { if (!/^https:\/\/[^\s]+$/.test(value)) throw new Error('source must be an https address'); out.source = value }
    else if (key === 'rpcport') { const n = Number(value); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('rpcport must be 1024 to 65535'); out.rpcport = n }
    else if (key === 'syncinterval') { const n = Number(value); if (!Number.isInteger(n) || n < 60 || n > 86400) throw new Error('syncinterval must be 60 to 86400 seconds'); out.syncinterval = n }
    else throw new Error(`unknown setting in maxwell.conf: ${key.slice(0, 40)}`)
  }
  return out
}
export function initDatadir(dir) {
  mkdirSync(join(dir, 'witness'), { recursive: true })
  const conf = join(dir, 'maxwell.conf')
  if (!existsSync(conf)) writeFileSync(conf, `# Maxwell Core settings\nsource=${DEFAULTS.source}\nrpcport=${DEFAULTS.rpcport}\nsyncinterval=${DEFAULTS.syncinterval}\n`)
  return conf
}
const atomicWrite = (path, text, mode) => { const tmp = `${path}.tmp`; writeFileSync(tmp, text, mode ? { mode } : undefined); renameSync(tmp, path) }
const readState = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) } catch { return null } }

// ------------------------------------------------------------------------------------------------ the node
export class Node {
  constructor({ datadir, fetchImpl = fetch, now = () => new Date(), config } = {}) {
    this.dir = datadir
    this.fetchImpl = fetchImpl
    this.now = now
    this.config = config ?? parseConfig(existsSync(join(datadir, 'maxwell.conf')) ? readFileSync(join(datadir, 'maxwell.conf'), 'utf8') : '')
    this.startedAt = now()
    this.load()
  }

  load() {
    const file = join(this.dir, 'chain.json')
    this.text = existsSync(file) ? readFileSync(file, 'utf8') : null
    this.raw = this.text ? parseChainText(this.text) : null          // numbers keep their original text, for hashing exactly like Python
    this.plain = this.text ? JSON.parse(this.text) : null            // ordinary values, for answering questions
    this.check = this.raw ? verifyChain(this.raw) : null
  }

  /** Download the public chain and take it only if it verifies and does not contradict what is already stored. */
  async sync() {
    const url = `${this.config.source}${this.config.source.includes('?') ? '&' : '?'}cb=${Date.now()}`
    let text
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': `maxwell-core/${VERSION}` } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
      if (text.length > 5_000_000) throw new Error('too large')
    } catch (e) { return this.note({ ok: false, result: 'unreachable', detail: String(e.message).slice(0, 80) }) }
    let incoming, v
    try { incoming = parseChainText(text); v = verifyChain(incoming) } catch { return this.note({ ok: false, result: 'unreadable', detail: 'the downloaded file is not a chain' }) }
    if (!v.ok) return this.note({ ok: false, result: 'invalid', detail: v.problems.slice(0, 3).join('; ') })
    const mine = this.check?.ok ? this.raw.blocks : []
    if (mine.length) {
      if (v.size < mine.length) return this.note({ ok: false, result: 'shorter', detail: `the source has ${v.size} blocks; this node already holds ${mine.length}` })
      const at = incoming.blocks[mine.length - 1]
      if (at.hash !== mine.at(-1).hash) return this.note({ ok: false, result: 'conflict', detail: `block ${mine.length - 1} differs from the one this node holds`, conflict: true })
    }
    const grew = v.size - mine.length
    atomicWrite(join(this.dir, 'chain.json'), text)
    this.load()
    return this.note({ ok: true, result: grew > 0 ? 'updated' : 'unchanged', detail: `${v.size} blocks`, grew })
  }

  note(r) {
    const prev = readState(this.dir) ?? {}
    const state = { ...prev, lastSyncAt: this.now().toISOString(), lastResult: r.result, lastDetail: r.detail ?? '', conflict: r.conflict ? true : (r.ok ? false : (prev.conflict ?? false)) }
    if (r.ok && this.check?.ok) { state.size = this.check.size; state.hash = this.check.head.hash; state.lastOkAt = state.lastSyncAt }
    atomicWrite(join(this.dir, 'state.json'), JSON.stringify(state, null, 2) + '\n')
    return { ...r, state }
  }

  need() { if (!this.plain || !this.check?.ok) throw new RpcError(-32000, 'this node has no verified chain yet: run sync first'); return this.plain.blocks }
  blockAt(id) {
    const blocks = this.need()
    if (typeof id === 'number' || (typeof id === 'string' && /^\d{1,9}$/.test(id))) { const n = Number(id); if (!Number.isInteger(n) || n < 0 || n >= blocks.length) throw new RpcError(-8, 'block height out of range'); return blocks[n] }
    if (typeof id === 'string' && HEX64.test(id)) { const b = blocks.find((x) => x.hash === id); if (!b) throw new RpcError(-5, 'block not found'); return b }
    throw new RpcError(-32602, 'give a block height or a 64-character lowercase hex hash')
  }
  header(b, blocks) {
    return { hash: b.hash, height: b.index, confirmations: blocks.length - b.index, previousblockhash: b.index === 0 ? null : b.previous_hash, nextblockhash: blocks[b.index + 1]?.hash ?? null,
      time: b.timestamp, nonce: b.nonce, ntx: b.transactions.length, kind: b.transactions[0]?.sender ?? null }
  }

  // The RPC methods. Names follow Bitcoin Core where there is a close match.
  methods() {
    return {
      getblockcount: () => this.need().length - 1,
      getbestblockhash: () => this.need().at(-1).hash,
      getblockhash: ([height]) => this.blockAt(Number.isInteger(height) ? height : NaN).hash,
      getblockheader: ([id]) => { const blocks = this.need(); return this.header(this.blockAt(id), blocks) },
      getblock: ([id]) => { const blocks = this.need(); const b = this.blockAt(id); return { ...this.header(b, blocks), previous_hash: b.previous_hash, transactions: b.transactions } },
      getblockchaininfo: () => {
        const st = readState(this.dir) ?? {}
        const ok = !!this.check?.ok
        return { chain: 'maxwell', blocks: ok ? this.check.size - 1 : null, bestblockhash: ok ? this.check.head.hash : null, difficulty: ok ? Number(this.plain.difficulty ?? 2) : null,
          verified: ok, source: this.config.source, lastsync: st.lastSyncAt ?? null, lastsyncresult: st.lastResult ?? null, conflict: !!st.conflict }
      },
      verifychain: () => { const v = this.raw ? verifyChain(this.raw) : { ok: false, problems: ['no chain stored'], size: 0 }; return { ok: v.ok, blocks: v.size, problems: v.problems.slice(0, 10) } },
      getnodeinfo: () => ({ name: 'maxwell-core', version: VERSION, datadir: this.dir, uptimeSeconds: Math.round((this.now() - this.startedAt) / 1000), rpcbind: '127.0.0.1', rpcport: this.config.rpcport, syncinterval: this.config.syncinterval }),
      sync: async () => { const r = await this.sync(); return { result: r.result, detail: r.detail, ok: r.ok } },
      help: () => Object.keys(this.methods()).sort(),
    }
  }

  async call(method, params) {
    const fn = this.methods()[method]
    if (!fn) throw new RpcError(-32601, 'method not found')
    if (!Array.isArray(params)) throw new RpcError(-32602, 'params must be a list')
    return fn(params)
  }

  /** Sign the head this node verified, as a witness, using <datadir>/witness/<name>.key. Same rules and code as witness.mjs. */
  witness(name) {
    this.need()
    const keyFile = join(this.dir, 'witness', `${name}.key`)
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name) || !existsSync(keyFile)) throw new Error(`no key at ${keyFile}: make one with witness.mjs keygen --name ${name} and move the .key file there`)
    const pem = readFileSync(keyFile, 'utf8')
    const publicKey = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).toString('base64')
    const stateFile = join(this.dir, 'witness', `${name}.state.json`)
    const prev = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
    const step = witnessStep({ chain: this.raw, state: prev })
    if (!step.sign) return { signed: false, reason: step.reason, conflict: !!step.conflict }
    const c = cosign({ name, checkpoint: step.checkpoint, privateKeyPem: pem, publicKey, now: this.now() })
    atomicWrite(join(this.dir, 'witness', `${name}.cosignature.json`), JSON.stringify(c, null, 2) + '\n')
    atomicWrite(stateFile, JSON.stringify(step.state) + '\n')
    return { signed: true, cosignature: c }
  }
}

// ------------------------------------------------------------------------------------------------ the RPC server (loopback only, cookie required)
export function makeHandler(node, cookie, portOrFn) {
  const portOf = typeof portOrFn === 'function' ? portOrFn : () => portOrFn
  const want = Buffer.from(`__cookie__:${cookie}`)
  return async (req, res) => {
    const send = (status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' }); res.end(text) }
    const host = String(req.headers.host ?? ''), port = portOf()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'bad host' })            // DNS-rebinding defence
    if (req.headers.origin) return send(403, { error: 'browser requests are not accepted' })                             // a web page must not drive the node
    if (req.method !== 'POST') return send(405, { error: 'POST only' })
    const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''))
    const got = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0)
    if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { error: 'unauthorized' })
    let size = 0; const chunks = []
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, { error: 'request too large' }); chunks.push(c) }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') return send(200, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'invalid request' } })
    const id = body.id ?? null
    try {
      const result = await node.call(body.method, body.params ?? [])
      if (body.method === 'stop') return send(200, { jsonrpc: '2.0', id, result: 'stopping' })
      return send(200, { jsonrpc: '2.0', id, result })
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603
      return send(200, { jsonrpc: '2.0', id, error: { code, message: e instanceof RpcError ? e.message : 'internal error' } })
    }
  }
}

export async function serve({ datadir, fetchImpl, port, onStop = () => {} } = {}) {
  initDatadir(datadir)
  const node = new Node({ datadir, fetchImpl })
  const p = port ?? node.config.rpcport
  const cookie = randomBytes(32).toString('hex')
  const cookieFile = join(datadir, '.cookie')
  writeFileSync(cookieFile, `__cookie__:${cookie}\n`, { mode: 0o600 })
  try { chmodSync(cookieFile, 0o600) } catch { /* Windows: the folder is already per-user */ }
  let boundPort = p
  const handler = makeHandler(node, cookie, () => boundPort)
  let server
  node.methods = ((orig) => () => ({ ...orig.call(node), stop: () => { setTimeout(() => server.close(() => { rmSync(cookieFile, { force: true }); onStop() }), 50); return 'stopping' } }))(node.methods)
  server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', resolve) })
  boundPort = server.address().port
  const timer = setInterval(() => { node.sync().catch(() => {}) }, node.config.syncinterval * 1000)
  timer.unref()
  node.sync().catch(() => {})
  return { server, node, port: server.address().port, cookie, close: () => new Promise((r) => { clearInterval(timer); server.close(() => { rmSync(cookieFile, { force: true }); r() }) }) }
}

// ------------------------------------------------------------------------------------------------ command line
const args = (argv) => { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; else o._.push(argv[i]) } return o }

async function main(argv) {
  const [cmd, ...rest] = argv
  const a = args(rest)
  const datadir = typeof a.datadir === 'string' ? a.datadir : defaultDatadir()
  if (cmd === 'init') { console.log(`ready: ${initDatadir(datadir)}`); return 0 }
  if (cmd === 'sync') {
    initDatadir(datadir)
    const r = await new Node({ datadir }).sync()
    console.log(`${r.result}: ${r.detail}`)
    return r.ok ? 0 : r.conflict ? 3 : 1
  }
  if (cmd === 'serve') {
    const s = await serve({ datadir, onStop: () => process.exit(0) })
    console.log(`maxwell-core ${VERSION} listening on 127.0.0.1:${s.port} (data folder ${datadir}); stop it with: cli stop`)
    return new Promise(() => {})
  }
  if (cmd === 'cli') {
    const [method, ...params] = a._
    if (!method) { console.error('usage: cli <method> [params...]'); return 2 }
    const conf = parseConfig(existsSync(join(datadir, 'maxwell.conf')) ? readFileSync(join(datadir, 'maxwell.conf'), 'utf8') : '')
    const cookie = readFileSync(join(datadir, '.cookie'), 'utf8').trim()
    const res = await fetch(`http://127.0.0.1:${conf.rpcport}/`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params.map((p) => (/^\d+$/.test(p) ? Number(p) : p)) }) })
    const body = await res.json()
    if (body.error) { console.error(`error ${body.error.code}: ${body.error.message ?? body.error}`); return 1 }
    console.log(JSON.stringify(body.result, null, 2)); return 0
  }
  if (cmd === 'witness') {
    if (typeof a.name !== 'string') { console.error('give --name'); return 2 }
    const r = new Node({ datadir }).witness(a.name)
    if (!r.signed) { console.error(`NOT signed: ${r.reason}`); return r.conflict ? 3 : 2 }
    console.log(`signed head of ${r.cosignature.size} blocks (${r.cosignature.hash.slice(0, 16)}...) as ${a.name}`); return 0
  }
  console.log('usage: maxwell-core.mjs init | sync | serve | cli <method> [params] | witness --name N   (--datadir DIR)')
  return cmd ? 2 : 0
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`maxwell-core: ${e.message}`); process.exit(2) })
}
