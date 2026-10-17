#!/usr/bin/env node
// Maxwell witness: a peer that independently checks the public Maxwell chain and signs ("cosigns") the head it verified.
// One file, no dependencies, Node 22 or newer (it uses JSON.parse source text access and the built-in Ed25519). Modelled on the C2SP transparency-log witness idea:
//   a witness remembers the last head it checked, refuses anything that does not extend it, and signs only what it has fully verified itself.
// A reader then trusts a head only when enough DIFFERENT witnesses have signed it (k of n). See docs/peer-review.md.
//
//   node witness.mjs keygen --name alice                       -> alice.key (private, keep it) and alice.pub (publish it)
//   node witness.mjs run --name alice --key alice.key          -> checks the public chain, writes alice.cosignature.json (publish this file anywhere with an https address)
//   node witness.mjs check --registry registry.json            -> reads every listed witness and prints who agrees with the current head
//
// What a cosignature says: "I downloaded the chain myself, recomputed every hash, link and work target, and its head at this size is this hash, and it extends what I saw before."
// It does not say the research is true, and it does not make the signer an authority. Nothing secret or personal is involved: the chain is public.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const ORIGIN = 'rabbitsoftware.io/maxwell'
export const CHAIN_URL = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json'
export const HELLO_WORLD = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
const HEX64 = /^[0-9a-f]{64}$/

// ------------------------------------------------------------------------------------------------ hashing the way Python does it
// The chain's block hash is SHA-256 of Python's json.dumps(payload, sort_keys=True). To reproduce it exactly, numbers keep their original text and the output uses
// Python's separators (", " and ": ") and its ASCII escaping.
class Raw { constructor(source) { this.source = source } valueOf() { return Number(this.source) } }

export function parseChainText(text) {
  return JSON.parse(text, (key, value, context) => (typeof value === 'number' ? new Raw(context.source) : value))
}

const escape = (s) => {
  let out = '"'
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (c === 8) out += '\\b'
    else if (c === 12) out += '\\f'
    else if (c === 10) out += '\\n'
    else if (c === 13) out += '\\r'
    else if (c === 9) out += '\\t'
    else if (c < 0x20 || c > 0x7e) {
      if (c > 0xffff) { const x = c - 0x10000; out += '\\u' + (0xd800 + (x >> 10)).toString(16).padStart(4, '0') + '\\u' + (0xdc00 + (x & 0x3ff)).toString(16).padStart(4, '0') }
      else out += '\\u' + c.toString(16).padStart(4, '0')
    } else out += ch
  }
  return out + '"'
}

export function pythonJson(v) {
  if (v instanceof Raw) return v.source
  if (typeof v === 'string') return escape(v)
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (Array.isArray(v)) return '[' + v.map(pythonJson).join(', ') + ']'
  return '{' + Object.keys(v).sort().map((k) => escape(k) + ': ' + pythonJson(v[k])).join(', ') + '}'
}

export const sha256hex = (data) => createHash('sha256').update(data).digest('hex')

export function blockHash(b) {
  return sha256hex(Buffer.from(pythonJson({ index: b.index, timestamp: b.timestamp, transactions: b.transactions, previous_hash: b.previous_hash, nonce: b.nonce }), 'utf8'))
}

const whole = (v) => { const n = v instanceof Raw ? Number(v.source) : v; return Number.isInteger(n) && n >= 0 ? n : null }

// ------------------------------------------------------------------------------------------------ the checks a witness runs
/** Verifies the whole chain on its own terms. Returns { ok, problems, size, head } where head is { index, hash } of the last block. */
export function verifyChain(data) {
  const problems = []
  const blocks = Array.isArray(data?.blocks) ? data.blocks : []
  if (!blocks.length) return { ok: false, problems: ['the chain has no blocks'], size: 0, head: null }
  const difficulty = data.difficulty === undefined ? 2 : whole(data.difficulty)
  if (difficulty === null || difficulty > 5) problems.push('the difficulty is not a small whole number')
  if (sha256hex('hello world') !== HELLO_WORLD) problems.push('internal: reference hash wrong')
  if (blocks[0]?.transactions?.[0]?.immutable_anchor_sha !== HELLO_WORLD) problems.push('block 0 does not carry the sha256("hello world") anchor')
  blocks.forEach((b, i) => {
    const tag = `block ${i}`
    if (whole(b?.index) !== i) { problems.push(`${tag}: index should be ${i}`); return }
    if (!HEX64.test(String(b.hash)) || !HEX64.test(String(b.previous_hash))) { problems.push(`${tag}: hashes must be 64 lowercase hex characters`); return }
    if (blockHash(b) !== b.hash) problems.push(`${tag}: the stored hash does not match its contents`)
    if (i === 0 ? b.previous_hash !== '0'.repeat(64) : b.previous_hash !== blocks[i - 1].hash) problems.push(`${tag}: previous_hash does not link to the block before`)
    if (i > 0 && difficulty !== null && !b.hash.startsWith('0'.repeat(difficulty))) problems.push(`${tag}: the hash does not meet the work target (${difficulty} leading zeros)`)
  })
  const last = blocks[blocks.length - 1]
  return { ok: problems.length === 0, problems, size: blocks.length, head: { index: blocks.length - 1, hash: String(last.hash) } }
}

/**
 * One witnessing step. `state` is { size, hash } of the last head this witness verified, or null the first time.
 * It signs only a chain that fully verifies and that EXTENDS the remembered head: the block at that position must still have the same hash.
 * A different hash there means two histories exist (a "split view" or a rewrite), so it refuses and says so.
 */
export function witnessStep({ chain, state }) {
  const v = verifyChain(chain)
  if (!v.ok) return { sign: false, reason: 'the chain does not verify', problems: v.problems }
  if (state && Number.isInteger(state.size) && state.size > 0) {
    if (v.size < state.size) return { sign: false, reason: `the chain is shorter (${v.size}) than the head this witness already saw (${state.size})`, problems: [] }
    const seen = chain.blocks[state.size - 1]
    if (seen.hash !== state.hash) return { sign: false, reason: `CONFLICT: block ${state.size - 1} had hash ${state.hash.slice(0, 16)}... when last seen and now has ${String(seen.hash).slice(0, 16)}...`, problems: [], conflict: true }
  }
  return { sign: true, checkpoint: { origin: ORIGIN, size: v.size, hash: v.head.hash }, state: { size: v.size, hash: v.head.hash } }
}

// ------------------------------------------------------------------------------------------------ keys and cosignatures (Ed25519)
export function generateKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return { publicKey: spki.toString('base64'), keyId: sha256hex(spki).slice(0, 16), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

export const keyIdOf = (publicKeyB64) => sha256hex(Buffer.from(publicKeyB64, 'base64')).slice(0, 16)

const message = (c) => `rabbitos-cosignature/v1\nwitness ${c.witness}\nsigned ${c.signedAt}\n${c.origin}\n${c.size}\n${c.hash}\n`

export function cosign({ name, checkpoint, privateKeyPem, publicKey, now = new Date() }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name)) throw new Error('a witness name is 1 to 40 characters: lowercase letters, digits, dot, dash, underscore')
  const c = { v: 1, witness: name, keyId: keyIdOf(publicKey), origin: checkpoint.origin, size: checkpoint.size, hash: checkpoint.hash, signedAt: now.toISOString().replace(/\.\d+Z$/, 'Z') }
  c.signature = sign(null, Buffer.from(message(c)), createPrivateKey(privateKeyPem)).toString('base64')
  return c
}

export function verifyCosignature(c, publicKeyB64) {
  try {
    if (!c || c.v !== 1 || c.origin !== ORIGIN || !Number.isInteger(c.size) || c.size < 1 || !HEX64.test(String(c.hash)) || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(c.witness))) return false
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(c.signedAt))) return false
    if (c.keyId !== keyIdOf(publicKeyB64)) return false
    return verify(null, Buffer.from(message(c)), createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' }), Buffer.from(c.signature, 'base64'))
  } catch { return false }
}

// ------------------------------------------------------------------------------------------------ reading the witnesses
export const DEFAULT_POLICY = Object.freeze({ k: 2, maxAgeHours: 48 })

/**
 * Who agrees with the chain right now?
 *   registry  { witnesses: [{ name, publicKey, kind }] }          the witnesses this reader knows and trusts to exist
 *   cosigs    { [name]: cosignature | null }                       what each one published (null = could not be read)
 *   chain     the parsed chain (so an older head can be shown to be a prefix of it)
 * Status per witness: agrees (signed the current head, recently) | behind (signed an earlier head that is still part of this chain) | stale (too old)
 *                     | ahead (signed a LONGER chain than the copy read here: this copy may simply be old, e.g. a cached file, so it is neither counted nor an alarm)
 *                     | conflict (signed a hash that is NOT in this chain at a position this copy has: split view or rewrite) | invalid (bad signature) | missing
 * Quorum counts DISTINCT registered keys that agree. A name appearing twice, or two names sharing a key, count once.
 */
export function evaluate({ registry, cosigs, chain, now = new Date(), policy = DEFAULT_POLICY }) {
  const v = verifyChain(chain)
  const head = v.ok ? v.head : null
  const rows = []
  const countedKeys = new Set()
  let agreeing = 0
  for (const w of registry?.witnesses ?? []) {
    const c = cosigs?.[w.name] ?? null
    const row = { name: w.name, kind: w.kind ?? 'external', keyId: keyIdOf(w.publicKey), status: 'missing', size: null, signedAt: null }
    if (c) {
      row.size = Number.isInteger(c.size) ? c.size : null
      row.signedAt = typeof c.signedAt === 'string' ? c.signedAt : null
      if (!verifyCosignature(c, w.publicKey) || c.witness !== w.name) row.status = 'invalid'
      else if (!v.ok) row.status = 'invalid'
      else {
        const at = chain.blocks[c.size - 1]
        const age = (now - new Date(c.signedAt)) / 3_600_000
        if (c.size > v.size) row.status = 'ahead'
        else if (!at || at.hash !== c.hash) row.status = 'conflict'
        else if (age > policy.maxAgeHours || age < -1) row.status = 'stale'
        else if (c.size === v.size) { row.status = 'agrees'; if (!countedKeys.has(row.keyId)) { countedKeys.add(row.keyId); agreeing++ } }
        else row.status = 'behind'
      }
    }
    rows.push(row)
  }
  const n = rows.length
  const conflicts = rows.filter((r) => r.status === 'conflict').length
  return {
    head: head ? { size: v.size, hash: head.hash } : null, chainOk: v.ok, chainProblems: v.problems.slice(0, 5),
    policy: { k: policy.k, n, maxAgeHours: policy.maxAgeHours }, agreeing, conflicts, rows,
    trusted: v.ok && agreeing >= policy.k && conflicts === 0,
    summary: !v.ok ? 'The chain itself does not verify.' : conflicts ? `${conflicts} witness(es) signed a history that is not this chain: investigate before trusting the head.`
      : `${agreeing} of ${n} witnesses signed the current head${agreeing >= policy.k ? `, which meets the rule of ${policy.k}` : `; the rule needs ${policy.k}`}.`,
  }
}

// ------------------------------------------------------------------------------------------------ command line
async function getText(url, what, timeoutMs = 30_000, maxBytes = 5_000_000) {
  if (!/^https:\/\//.test(url)) throw new Error(`${what}: only https addresses are read`)
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'rabbitos-witness/1.0' } })
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > maxBytes) throw new Error(`${what}: too large`)
  return text
}

// The public chain file is cacheable for an hour; a changing query string makes every read a fresh one.
const fresh = (url) => url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now()

function args(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; else o._.push(argv[i]) }
  return o
}

async function main(argv) {
  const [cmd, ...rest] = argv
  const a = args(rest)
  if (cmd === 'keygen') {
    const name = a.name; if (typeof name !== 'string') throw new Error('give --name')
    const k = generateKey()
    writeFileSync(`${name}.key`, k.privateKeyPem, { mode: 0o600 })
    writeFileSync(`${name}.pub`, JSON.stringify({ name, publicKey: k.publicKey, keyId: k.keyId }, null, 2) + '\n')
    console.log(`wrote ${name}.key (private: never share) and ${name}.pub (publish this; it is your witness identity ${k.keyId})`)
    return 0
  }
  if (cmd === 'run') {
    const name = a.name, keyFile = a.key
    if (typeof name !== 'string' || typeof keyFile !== 'string') throw new Error('give --name and --key')
    const pem = readFileSync(keyFile, 'utf8')
    const publicKey = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).toString('base64')
    const stateFile = a.state ?? `${name}.state.json`
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
    const text = a.chain && !/^https:/.test(String(a.chain)) ? readFileSync(a.chain, 'utf8') : await getText(fresh(a.chain ?? CHAIN_URL), 'chain')
    const step = witnessStep({ chain: parseChainText(text), state })
    if (!step.sign) { console.error(`NOT signed: ${step.reason}`); for (const p of step.problems.slice(0, 10)) console.error(' -', p); return step.conflict ? 3 : 2 }
    const c = cosign({ name, checkpoint: step.checkpoint, privateKeyPem: pem, publicKey })
    const out = a.out ?? `${name}.cosignature.json`
    writeFileSync(out, JSON.stringify(c, null, 2) + '\n')
    writeFileSync(stateFile, JSON.stringify(step.state) + '\n')
    console.log(`signed head of ${c.size} blocks (${c.hash.slice(0, 16)}...) as ${name}; wrote ${out}`)
    return 0
  }
  if (cmd === 'check') {
    const registry = JSON.parse(a.registry && !/^https:/.test(String(a.registry)) ? readFileSync(a.registry, 'utf8') : await getText(a.registry, 'registry'))
    const chain = parseChainText(await getText(fresh(a.chain ?? CHAIN_URL), 'chain'))
    const cosigs = {}
    for (const w of registry.witnesses ?? []) { try { cosigs[w.name] = JSON.parse(await getText(w.url, `witness ${w.name}`, 15_000, 20_000)) } catch (e) { cosigs[w.name] = null; console.error(`${w.name}: ${e.message}`) } }
    const r = evaluate({ registry, cosigs, chain, policy: { ...DEFAULT_POLICY, k: Number(registry.k) || DEFAULT_POLICY.k } })
    console.log(r.summary)
    for (const row of r.rows) console.log(`  ${row.name.padEnd(18)} ${row.status.padEnd(9)} ${row.size ?? '-'} ${row.signedAt ?? ''}`)
    return r.trusted ? 0 : 1
  }
  console.log('usage: node witness.mjs keygen --name N | run --name N --key N.key [--chain url|file] | check --registry file|url')
  return cmd ? 2 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`witness: ${e.message}`); process.exit(2) })
}
