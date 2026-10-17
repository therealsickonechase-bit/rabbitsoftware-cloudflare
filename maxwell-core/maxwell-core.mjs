#!/usr/bin/env node
// Maxwell Core: a node for the Maxwell chain. One file next to witness.mjs, Node 22 or newer, no dependencies. See docs/maxwell-core.md.
//
//   node maxwell-core.mjs init [--datadir DIR]                 make the data folder and a maxwell.conf
//   node maxwell-core.mjs sync [--datadir DIR]                 download the public chain, verify it, store it (refuses a chain that contradicts the one already stored)
//   node maxwell-core.mjs serve [--datadir DIR]                private JSON-RPC on 127.0.0.1 with cookie authentication; syncs on a timer
//   node maxwell-core.mjs serve --public [--bind IP] [--port N]   PUBLIC read-only gateway (no secrets, no cookie): JSON-RPC and a REST interface, CORS open, rate-limited
//   node maxwell-core.mjs cli <method> [params...]             call a running private node (reads the cookie file)
//   node maxwell-core.mjs cli --url https://host <method> ...  call a public gateway
//   node maxwell-core.mjs witness --name N [--datadir DIR]     sign the head this node verified (key: <datadir>/witness/N.key; made with witness.mjs keygen)
//
// Modelled on Bitcoin Core's shape (daemon + CLI + data directory + cookie + familiar method names + a REST interface), not on its code. It never writes outside its data folder.
// The private RPC listens on the loopback address only, always. Only the public gateway can be bound elsewhere, and it serves public chain data and nothing else.
import { createPrivateKey, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHAIN_URL, DEFAULT_POLICY, cosign, evaluate, parseChainText, verifyChain, witnessStep } from './witness.mjs'

export const VERSION = '0.2.0'
export const REGISTRY_URL = 'https://rabbitsoftware.io/witness/registry.json'
export const ANCHORS_URL = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/index.json'
export const DEFAULTS = Object.freeze({ source: CHAIN_URL, rpcport: 8645, syncinterval: 3600, registry: REGISTRY_URL, anchors: ANCHORS_URL })
const HEX64 = /^[0-9a-f]{64}$/
const MAX_BODY = 64 * 1024
export const PUBLIC_METHODS = Object.freeze(['getblockcount', 'getbestblockhash', 'getblockhash', 'getblockheader', 'getblock', 'getblockchaininfo', 'getchaintips', 'getmininginfo',
  'getnetworkinfo', 'getpeerinfo', 'getwitnessinfo', 'getanchorinfo', 'getnodeinfo', 'verifychain', 'uptime', 'help'])
export const RATE = Object.freeze({ perMinute: 120 })

export class RpcError extends Error { constructor(code, message) { super(message); this.code = code } }

// ------------------------------------------------------------------------------------------------ data folder and config
export const defaultDatadir = () => process.env.MAXWELL_DATADIR || join(homedir(), '.maxwell')
const https = (name, value) => { if (!/^https:\/\/[^\s]+$/.test(value)) throw new Error(`${name} must be an https address`); return value }
export function parseConfig(text) {
  const out = { ...DEFAULTS }
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) throw new Error(`bad line in maxwell.conf: ${line.slice(0, 40)}`)
    const key = line.slice(0, i).trim(), value = line.slice(i + 1).trim()
    if (key === 'source' || key === 'registry' || key === 'anchors') out[key] = https(key, value)
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
  constructor({ datadir, fetchImpl = fetch, now = () => new Date(), config, publicMode = false } = {}) {
    this.dir = datadir
    this.fetchImpl = fetchImpl
    this.now = now
    this.publicMode = publicMode
    this.config = config ?? parseConfig(existsSync(join(datadir, 'maxwell.conf')) ? readFileSync(join(datadir, 'maxwell.conf'), 'utf8') : '')
    this.startedAt = now()
    this.cache = new Map()
    this.load()
  }

  load() {
    const file = join(this.dir, 'chain.json')
    this.text = existsSync(file) ? readFileSync(file, 'utf8') : null
    this.raw = this.text ? parseChainText(this.text) : null          // numbers keep their original text, for hashing exactly like Python
    this.plain = this.text ? JSON.parse(this.text) : null            // ordinary values, for answering questions
    this.check = this.raw ? verifyChain(this.raw) : null
  }

  async getText(url, maxBytes = 5_000_000) {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `maxwell-core/${VERSION}` } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > maxBytes) throw new Error('too large')
    return text
  }

  /** Remembers an answer for ttl seconds, so a busy public gateway does not hammer the sources behind it. */
  async cached(key, ttl, fn) {
    const hit = this.cache.get(key)
    const t = this.now().getTime()
    if (hit && t - hit.at < ttl * 1000) return hit.value
    const value = await fn()
    this.cache.set(key, { at: t, value })
    return value
  }

  /** Download the public chain and take it only if it verifies and does not contradict what is already stored. */
  async sync() {
    const url = `${this.config.source}${this.config.source.includes('?') ? '&' : '?'}cb=${Date.now()}`
    let text
    try { text = await this.getText(url) } catch (e) { return this.note({ ok: false, result: 'unreachable', detail: String(e.message).slice(0, 80) }) }
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
    this.cache.clear()
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

  async registryAndCosigs() {
    return this.cached('witnesses', 60, async () => {
      const registry = JSON.parse(await this.getText(this.config.registry, 200_000))
      if (!Array.isArray(registry?.witnesses)) throw new Error('not a registry')
      const witnesses = registry.witnesses.filter((w) => w && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(w.name)) && typeof w.publicKey === 'string' && typeof w.url === 'string').slice(0, 25)
      const cosigs = {}
      await Promise.all(witnesses.map(async (w) => { try { cosigs[w.name] = JSON.parse(await this.getText(w.url, 20_000)) } catch { cosigs[w.name] = null } }))
      const k = Number.isInteger(registry.k) && registry.k >= 1 && registry.k <= 10 ? registry.k : DEFAULT_POLICY.k
      return { witnesses, cosigs, k }
    })
  }
  async witnessResult() {
    this.need()
    const { witnesses, cosigs, k } = await this.registryAndCosigs()
    return evaluate({ registry: { witnesses }, cosigs, chain: this.raw, now: this.now(), policy: { ...DEFAULT_POLICY, k } })
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
      getchaintips: () => {
        const blocks = this.need()
        const st = readState(this.dir) ?? {}
        return [{ height: blocks.length - 1, hash: blocks.at(-1).hash, branchlen: 0, status: 'active' }, ...(st.conflict ? [{ height: null, hash: null, branchlen: null, status: 'conflict: the source offered a different history; it was not adopted' }] : [])]
      },
      getmininginfo: () => {
        const blocks = this.need()
        const kinds = {}
        for (const b of blocks) { const s = b.transactions[0]?.sender ?? 'unknown'; kinds[s] = (kinds[s] ?? 0) + 1 }
        const last = (sender) => { const b = [...blocks].reverse().find((x) => x.transactions[0]?.sender === sender); return b ? { height: b.index, time: b.timestamp, records: b.transactions[0].count ?? null } : null }
        return { chain: 'maxwell', blocks: blocks.length - 1, difficulty: Number(this.plain.difficulty ?? 2), proofofwork: 'light: a hash must start with that many zeros; tamper-evident, not a security claim', blocksbykind: kinds,
          lastresearchanchor: last('RESEARCH_ANCHOR'), lastwebsnapshot: last('RABBITWEB_MINER') ?? last('RABBITWEB_MINER_CLOUD'), pooledtx: 0 }
      },
      getnetworkinfo: () => ({ version: 200, subversion: `/MaxwellCore:${VERSION}/`, protocolversion: 1, localservices: this.publicMode ? ['public-gateway'] : ['node'], connections: null,
        networks: [{ name: 'https', reachable: true }], sources: { chain: this.config.source, registry: this.config.registry, anchors: this.config.anchors }, note: 'peers are the registered witnesses; see getpeerinfo' }),
      getpeerinfo: async () => {
        const r = await this.witnessResult()
        return r.rows.map((row, i) => ({ id: i, addr: row.name, subver: `witness (${row.kind})`, keyid: row.keyId, status: row.status, synced_blocks: row.size, lastsend: row.signedAt }))
      },
      getwitnessinfo: async () => { const r = await this.witnessResult(); return { head: r.head, rule: r.policy, agreeing: r.agreeing, conflicts: r.conflicts, trusted: r.trusted, summary: r.summary, witnesses: r.rows } },
      getanchorinfo: async () => {
        const list = await this.cached('anchors', 60, async () => JSON.parse(await this.getText(this.config.anchors, 500_000)))
        const rows = (Array.isArray(list) ? list : []).filter((a) => a && /^\d{4}-\d{2}-\d{2}T\d{6}Z$/.test(String(a.id))).slice(0, 12)
          .map((a) => ({ id: a.id, status: a.status === 'confirmed' ? 'confirmed' : 'pending', bitcoinheight: Number.isInteger(a.bitcoinHeight) ? a.bitcoinHeight : null, maxwelllength: a.maxwellLength ?? null, ledgerlength: a.ledgerLength ?? null, tsa: a.tsa === 'freetsa.org' }))
        return { anchors: rows, latestconfirmed: rows.find((a) => a.status === 'confirmed') ?? null, witnessedby: ['Bitcoin via OpenTimestamps', 'FreeTSA (RFC 3161)'] }
      },
      verifychain: () => { const v = this.raw ? verifyChain(this.raw) : { ok: false, problems: ['no chain stored'], size: 0 }; return { ok: v.ok, blocks: v.size, problems: v.problems.slice(0, 10) } },
      getnodeinfo: () => ({ name: 'maxwell-core', version: VERSION, mode: this.publicMode ? 'public read-only gateway' : 'private node', ...(this.publicMode ? {} : { datadir: this.dir, rpcbind: '127.0.0.1', rpcport: this.config.rpcport }), uptimeSeconds: Math.round((this.now() - this.startedAt) / 1000), syncinterval: this.config.syncinterval }),
      uptime: () => Math.round((this.now() - this.startedAt) / 1000),
      sync: async () => { const r = await this.sync(); return { result: r.result, detail: r.detail, ok: r.ok } },
      help: () => Object.keys(this.methods()).filter((m) => !this.publicMode || PUBLIC_METHODS.includes(m)).sort(),
    }
  }

  async call(method, params) {
    const fn = this.methods()[method]
    if (!fn || (this.publicMode && !PUBLIC_METHODS.includes(method))) throw new RpcError(-32601, this.publicMode && fn ? 'method not available on the public gateway' : 'method not found')
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

// ------------------------------------------------------------------------------------------------ the REST interface (like Bitcoin Core's /rest/...)
const REST = [
  [/^\/rest\/chaininfo\.json$/, () => ['getblockchaininfo', []]],
  [/^\/rest\/nodeinfo\.json$/, () => ['getnodeinfo', []]],
  [/^\/rest\/mininginfo\.json$/, () => ['getmininginfo', []]],
  [/^\/rest\/chaintips\.json$/, () => ['getchaintips', []]],
  [/^\/rest\/peers\.json$/, () => ['getpeerinfo', []]],
  [/^\/rest\/witnesses\.json$/, () => ['getwitnessinfo', []]],
  [/^\/rest\/anchors\.json$/, () => ['getanchorinfo', []]],
  [/^\/rest\/blockhashbyheight\/(\d{1,9})\.json$/, (m) => ['getblockhash', [Number(m[1])], (h) => ({ blockhash: h })]],
  [/^\/rest\/block\/(\d{1,9}|[0-9a-f]{64})\.json$/, (m) => ['getblock', [m[1]]]],
]
export const restRoute = (path) => { for (const [re, f] of REST) { const m = re.exec(path); if (m) return f(m) } return null }

// ------------------------------------------------------------------------------------------------ the servers
function makeSender(res, extra = {}) {
  return (status, body, headers = {}) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra, ...headers }); res.end(text) }
}
async function readBody(req, limit) {
  let size = 0; const chunks = []
  for await (const c of req) { size += c.length; if (size > limit) return null; chunks.push(c) }
  return Buffer.concat(chunks).toString('utf8')
}
async function runRpc(node, body, send) {
  let parsed
  try { parsed = JSON.parse(body) } catch { return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.method !== 'string') return send(200, { jsonrpc: '2.0', id: parsed?.id ?? null, error: { code: -32600, message: 'invalid request' } })
  const id = parsed.id ?? null
  try { return send(200, { jsonrpc: '2.0', id, result: await node.call(parsed.method, parsed.params ?? []) }) }
  catch (e) { return send(200, { jsonrpc: '2.0', id, error: { code: e instanceof RpcError ? e.code : -32603, message: e instanceof RpcError ? e.message : 'internal error' } }) }
}

/** Private: loopback, cookie, no browsers. */
export function makeHandler(node, cookie, portOrFn) {
  const portOf = typeof portOrFn === 'function' ? portOrFn : () => portOrFn
  const want = Buffer.from(`__cookie__:${cookie}`)
  return async (req, res) => {
    const send = makeSender(res)
    const host = String(req.headers.host ?? ''), port = portOf()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'bad host' })            // DNS-rebinding defence
    if (req.headers.origin) return send(403, { error: 'browser requests are not accepted' })                             // a web page must not drive the node
    const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''))
    const got = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0)
    if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { error: 'unauthorized' })
    if (req.method === 'GET') {
      const route = restRoute(new URL(req.url, 'http://x').pathname)
      if (!route) return send(404, { error: 'not found' })
      try { const r = await node.call(route[0], route[1]); return send(200, route[2] ? route[2](r) : r) } catch (e) { return send(e instanceof RpcError && e.code !== -32000 ? 404 : 503, { error: e instanceof RpcError ? e.message : 'internal error' }) }
    }
    if (req.method !== 'POST') return send(405, { error: 'GET or POST only' })
    const body = await readBody(req, MAX_BODY)
    if (body === null) return send(413, { error: 'request too large' })
    return runRpc(node, body, send)
  }
}

/** Public: read-only, no secrets, CORS open, rate-limited. Serves public chain data and nothing else. */
export function makePublicHandler(node, { perMinute = RATE.perMinute } = {}) {
  const hits = new Map()
  const allow = (ip, t) => {
    const w = hits.get(ip)?.filter((x) => t - x < 60_000) ?? []
    w.push(t); hits.set(ip, w)
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k)
    return w.length <= perMinute
  }
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }
  return async (req, res) => {
    const send = makeSender(res, cors)
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?'
    if (!allow(ip, Date.now())) return send(429, { error: 'slow down: at most ' + perMinute + ' requests a minute' }, { 'retry-after': '30' })
    const path = new URL(req.url, 'http://x').pathname
    if (req.method === 'GET') {
      if (path === '/health' || path === '/healthz' || path === '/') return send(200, { ok: true, name: 'maxwell-core', version: VERSION, mode: 'public read-only gateway', rpc: 'POST / with JSON-RPC 2.0', rest: '/rest/chaininfo.json' })
      const route = restRoute(path)
      if (!route) return send(404, { error: 'not found' })
      try { const r = await node.call(route[0], route[1]); return send(200, route[2] ? route[2](r) : r, { 'cache-control': 'public, max-age=15' }) }
      catch (e) { return send(e instanceof RpcError && e.code !== -32000 ? 404 : 503, { error: e instanceof RpcError ? e.message : 'unavailable right now' }) }
    }
    if (req.method !== 'POST') return send(405, { error: 'GET or POST only' })
    const body = await readBody(req, 16 * 1024)
    if (body === null) return send(413, { error: 'request too large' })
    return runRpc(node, body, send)
  }
}

export async function serve({ datadir, fetchImpl, port, bind = '127.0.0.1', publicMode = false, now, onStop = () => {} } = {}) {
  initDatadir(datadir)
  const node = new Node({ datadir, fetchImpl, publicMode, ...(now ? { now } : {}) })
  const p = port ?? node.config.rpcport
  if (!publicMode && bind !== '127.0.0.1') throw new Error('the private RPC listens on 127.0.0.1 only; use --public for a gateway others can reach')
  let server, boundPort = p, cookie = null, cookieFile = null
  if (publicMode) {
    if (!node.check?.ok) await node.sync()
    server = createServer(makePublicHandler(node))
  } else {
    cookie = randomBytes(32).toString('hex')
    cookieFile = join(datadir, '.cookie')
    writeFileSync(cookieFile, `__cookie__:${cookie}\n`, { mode: 0o600 })
    try { chmodSync(cookieFile, 0o600) } catch { /* Windows: the folder is already per-user */ }
    const handler = makeHandler(node, cookie, () => boundPort)
    node.methods = ((orig) => () => ({ ...orig.call(node), stop: () => { setTimeout(() => server.close(() => { rmSync(cookieFile, { force: true }); onStop() }), 50); return 'stopping' } }))(node.methods)
    server = createServer(handler)
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, bind, resolve) })
  boundPort = server.address().port
  const timer = setInterval(() => { node.sync().catch(() => {}) }, node.config.syncinterval * 1000)
  timer.unref()
  if (!publicMode) node.sync().catch(() => {})
  return { server, node, port: boundPort, cookie, close: () => new Promise((r) => { clearInterval(timer); server.close(() => { if (cookieFile) rmSync(cookieFile, { force: true }); r() }) }) }
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
    const pub = a.public === true
    const port = a.port !== undefined ? Number(a.port) : (pub && process.env.PORT ? Number(process.env.PORT) : undefined)
    if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new Error('bad --port')
    const s = await serve({ datadir, publicMode: pub, port, bind: typeof a.bind === 'string' ? a.bind : '127.0.0.1', onStop: () => process.exit(0) })
    console.log(`maxwell-core ${VERSION} ${pub ? 'PUBLIC read-only gateway' : 'private node'} listening on ${s.server.address().address}:${s.port} (data folder ${datadir})${pub ? '' : '; stop it with: cli stop'}`)
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => s.close().then(() => process.exit(0)))
    return new Promise(() => {})
  }
  if (cmd === 'cli') {
    const [method, ...params] = a._
    if (!method) { console.error('usage: cli [--url https://host] <method> [params...]'); return 2 }
    const conv = params.map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    let res
    if (typeof a.url === 'string') {
      if (!/^https?:\/\/[^\s]+$/.test(a.url)) throw new Error('--url must be an http(s) address')
      res = await fetch(a.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: conv }) })
    } else {
      const conf = parseConfig(existsSync(join(datadir, 'maxwell.conf')) ? readFileSync(join(datadir, 'maxwell.conf'), 'utf8') : '')
      const cookie = readFileSync(join(datadir, '.cookie'), 'utf8').trim()
      res = await fetch(`http://127.0.0.1:${conf.rpcport}/`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: conv }) })
    }
    const body = await res.json()
    if (body.error) { console.error(`error ${body.error.code ?? ''}: ${body.error.message ?? body.error}`); return 1 }
    console.log(JSON.stringify(body.result, null, 2)); return 0
  }
  if (cmd === 'witness') {
    if (typeof a.name !== 'string') { console.error('give --name'); return 2 }
    const r = new Node({ datadir }).witness(a.name)
    if (!r.signed) { console.error(`NOT signed: ${r.reason}`); return r.conflict ? 3 : 2 }
    console.log(`signed head of ${r.cosignature.size} blocks (${r.cosignature.hash.slice(0, 16)}...) as ${a.name}`); return 0
  }
  console.log('usage: maxwell-core.mjs init | sync | serve [--public --bind IP --port N] | cli [--url U] <method> [params] | witness --name N   (--datadir DIR)')
  return cmd ? 2 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`maxwell-core: ${e.message}`); process.exit(2) })
}
