// Proof for rabbitsoftware.io: status/proof-live.json and status/digest.json in the public status bucket, rewritten by the status job.
//
// proof-live.json   every recent anchor with its Bitcoin block and whether THIS job checked it: it replays the OpenTimestamps proof (sha256 / append / prepend steps) from the digest
//                   and compares the result with the Merkle root of that Bitcoin block, read from a public Bitcoin API. No funds, keys or accounts are involved. "verified" is true or
//                   false only when the check really ran; if a Bitcoin API cannot be reached it stays null (unknown), never "failed".
// digest.json       a plain-language summary of the research in the shared store, built only from numbers and public titles already in research-live.json, with the newest anchor.
// Everything here is public data. Nothing is written except those two files.
import { createHash } from 'node:crypto'

const LEDGER_BUCKET = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com'
const MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex')
const BITCOIN = '0588960d73d71901'
const PENDING = '83dfe30d2ef90c8e'
const HASH_OPS = { 0x02: 'sha1', 0x03: 'ripemd160', 0x08: 'sha256' }
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/
const HEX64 = /^[0-9a-f]{64}$/
export const MAX_ANCHORS = 12
export const MAX_VERIFY_PER_RUN = 3

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0 }
  byte() { if (this.pos >= this.buf.length) throw new Error('proof ends unexpectedly'); return this.buf[this.pos++] }
  take(n) { if (this.pos + n > this.buf.length) throw new Error('proof ends unexpectedly'); this.pos += n; return this.buf.subarray(this.pos - n, this.pos) }
  varuint() { let v = 0, shift = 0; for (;;) { const b = this.byte(); v += (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return v; shift += 7; if (shift > 49) throw new Error('number too large') } }
  varbytes() { return this.take(this.varuint()) }
  get done() { return this.pos >= this.buf.length }
}

function walk(r, msg, leaves, depth = 0) {
  if (depth > 200) throw new Error('proof is nested too deeply')
  for (;;) {
    const tag = r.byte()
    if (tag === 0xff) { walk(r, msg, leaves, depth + 1); continue }              // a fork: this branch, then the next
    if (tag === 0x00) {                                                          // an attestation
      const kind = r.take(8).toString('hex'), payload = new Reader(r.varbytes())
      if (kind === BITCOIN) leaves.push({ kind: 'bitcoin', msg, height: payload.varuint() })
      else if (kind === PENDING) leaves.push({ kind: 'pending', msg })
      else leaves.push({ kind: 'unknown', msg })
      return
    }
    if (HASH_OPS[tag]) msg = createHash(HASH_OPS[tag]).update(msg).digest()
    else if (tag === 0xf0) msg = Buffer.concat([msg, r.varbytes()])
    else if (tag === 0xf1) msg = Buffer.concat([r.varbytes(), msg])
    else if (tag === 0xf2) msg = Buffer.from(msg).reverse()
    else if (tag === 0xf3) msg = Buffer.from(msg.toString('hex'))
    else throw new Error(`unknown operation 0x${tag.toString(16)}`)
    if (r.done) return
  }
}

/** @returns {{digest: Buffer, leaves: {kind: string, msg: Buffer, height?: number}[]}} */
export function parseOts(bytes) {
  const r = new Reader(Buffer.from(bytes))
  if (!r.take(MAGIC.length).equals(MAGIC)) throw new Error('not an OpenTimestamps proof')
  if (r.varuint() !== 1) throw new Error('unsupported proof version')
  if (r.byte() !== 0x08) throw new Error('proof is not for a sha256 digest')
  const digest = Buffer.from(r.take(32))
  const leaves = []
  walk(r, digest, leaves)
  return { digest, leaves }
}

/** Looks up the Merkle root of a Bitcoin block (hex, display order) in public APIs. Throws if none answers. */
export function bitcoinLookup(fetchImpl = fetch, timeoutMs = 12_000) {
  return async (height) => {
    let last
    for (const api of ['https://mempool.space/api', 'https://blockstream.info/api']) {
      try {
        const hash = (await (await fetchImpl(`${api}/block-height/${height}`, { signal: AbortSignal.timeout(timeoutMs) })).text()).trim()
        if (!HEX64.test(hash)) throw new Error('unexpected block hash')
        const block = await (await fetchImpl(`${api}/block/${hash}`, { signal: AbortSignal.timeout(timeoutMs) })).json()
        if (!HEX64.test(block.merkle_root)) throw new Error('unexpected merkle root')
        return block.merkle_root
      } catch (e) { last = e }
    }
    throw new Error(`no Bitcoin API answered: ${last?.message ?? 'unknown'}`)
  }
}

/** @returns {Promise<{verified: boolean|null, reason: string, heights: number[]}>} verified is null when the check could not run. */
export async function verifyAnchor(anchorBytes, otsBytes, lookup) {
  let parsed
  try { parsed = parseOts(otsBytes) } catch (e) { return { verified: false, reason: `the proof file is not readable: ${e.message}`, heights: [] } }
  if (!createHash('sha256').update(anchorBytes).digest().equals(parsed.digest)) return { verified: false, reason: 'the anchor file does not match the digest in the proof', heights: [] }
  const bitcoin = parsed.leaves.filter((l) => l.kind === 'bitcoin')
  if (!bitcoin.length) return { verified: null, reason: 'the proof is still waiting for a Bitcoin block', heights: [] }
  let matched = 0, unknown = 0
  for (const leaf of bitcoin) {
    let root
    try { root = await lookup(leaf.height) } catch { unknown++; continue }
    if (Buffer.from(leaf.msg).reverse().toString('hex') !== root) return { verified: false, reason: `the proof does not match the Merkle root of Bitcoin block ${leaf.height}`, heights: bitcoin.map((l) => l.height) }
    matched++
  }
  const heights = bitcoin.map((l) => l.height)
  if (matched) return { verified: true, reason: `matches the Merkle root of ${matched} Bitcoin block${matched === 1 ? '' : 's'}`, heights }
  return { verified: null, reason: 'a Bitcoin API could not be reached, so this was not checked', heights }
}

const iso = (v) => (Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null)

async function getBytes(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * previous: the last proof-live.json (so a proof that already checked out is not re-checked every five minutes). Returns null when the anchor index cannot be read.
 */
export async function buildProofLive({ fetchImpl = fetch, now = new Date(), previous = null, ledgerUrl = LEDGER_BUCKET, lookup = bitcoinLookup(fetchImpl), timeoutMs = 12_000, maxVerify = MAX_VERIFY_PER_RUN } = {}) {
  let index
  try { index = JSON.parse((await getBytes(fetchImpl, `${ledgerUrl}/anchors/index.json?cb=${Math.floor(now / 60_000)}`, timeoutMs)).toString('utf8')) } catch { return null }
  if (!Array.isArray(index)) return null
  const known = new Map((previous?.anchors ?? []).map((a) => [`${a.id}:${a.digest}`, a]))
  const anchors = []
  let budget = maxVerify
  for (const e of index.filter((x) => x && ID_RE.test(String(x.id)) && HEX64.test(String(x.digest))).slice(0, MAX_ANCHORS)) {
    const old = known.get(`${e.id}:${e.digest}`)
    const row = { id: e.id, digest: e.digest, status: e.status === 'confirmed' ? 'confirmed' : 'pending', bitcoinHeight: Number.isInteger(e.bitcoinHeight) ? e.bitcoinHeight : null,
      ledgerLength: Number.isInteger(e.ledgerLength) ? e.ledgerLength : null, maxwellLength: Number.isInteger(e.maxwellLength) ? e.maxwellLength : null, tsa: e.tsa === 'freetsa.org' ? 'freetsa.org' : null,
      verified: null, reason: row0(e), checkedAt: null }
    if (old?.verified === true && old.status === row.status) Object.assign(row, { verified: true, reason: old.reason, checkedAt: old.checkedAt, heights: old.heights })
    else if (row.status === 'confirmed' && budget > 0) {
      budget--
      try {
        const [anchor, ots] = await Promise.all([getBytes(fetchImpl, `${ledgerUrl}/anchors/${e.id}/anchor.json`, timeoutMs), getBytes(fetchImpl, `${ledgerUrl}/anchors/${e.id}/anchor.json.ots`, timeoutMs)])
        Object.assign(row, await verifyAnchor(anchor, ots, lookup), { checkedAt: now.toISOString() })
      } catch (err) { Object.assign(row, { verified: null, reason: 'the anchor files could not be read just now', checkedAt: now.toISOString() }) }
    } else if (old && old.verified !== null && old.status === row.status) Object.assign(row, { verified: old.verified, reason: old.reason, checkedAt: old.checkedAt, heights: old.heights })
    anchors.push(row)
  }
  let heads = null
  const newest = anchors[0]
  if (newest) {
    try {
      const doc = JSON.parse((await getBytes(fetchImpl, `${ledgerUrl}/anchors/${newest.id}/anchor.json`, timeoutMs)).toString('utf8'))
      heads = { ledgerLength: doc.ledger?.length ?? null, ledgerHead: String(doc.ledger?.headHash ?? '').slice(0, 16), maxwellLength: doc.maxwell?.length ?? null, maxwellHeadIndex: doc.maxwell?.headIndex ?? null, maxwellHead: String(doc.maxwell?.headHash ?? '').slice(0, 16) }
    } catch { /* the heads are a nicety */ }
  }
  const confirmed = anchors.filter((a) => a.status === 'confirmed')
  const firstVerified = anchors.find((a) => a.verified === true)
  return {
    version: 1, generatedAt: now.toISOString(),
    summary: {
      anchors: anchors.length, confirmed: confirmed.length, pending: anchors.length - confirmed.length, verified: anchors.filter((a) => a.verified === true).length, failed: anchors.filter((a) => a.verified === false).length,
      latestBitcoinHeight: confirmed.find((a) => a.bitcoinHeight)?.bitcoinHeight ?? null, latestVerifiedId: firstVerified?.id ?? null, witnesses: ['Bitcoin via OpenTimestamps', ...(anchors.some((a) => a.tsa) ? ['FreeTSA (RFC 3161)'] : [])],
    },
    heads, anchors,
    notYetOn: ['Ethereum', 'XRP Ledger'],
  }
}
function row0(e) { return e.status === 'confirmed' ? 'not checked yet' : 'waiting for a Bitcoin block' }

/**
 * A plain-language digest. `previous` is the last digest.json: it carries the baseline for "added this week" (a new baseline every 7 days).
 */
export function buildDigest({ researchLive, proofLive, previous = null, now = new Date() }) {
  if (!researchLive || researchLive.version !== 1) return null
  const total = Number.isFinite(researchLive.total) ? researchLive.total : null
  const t = researchLive.topics ?? {}
  let baseline = previous?.baseline && Number.isFinite(Date.parse(previous.baseline.at)) ? previous.baseline : null
  let lastWeek = previous?.lastWeek ?? null
  if (total !== null && (!baseline || now - Date.parse(baseline.at) >= 7 * 86_400_000)) {
    if (baseline && Number.isFinite(baseline.total)) lastWeek = { from: baseline.at, to: now.toISOString(), added: Math.max(0, total - baseline.total) }
    baseline = { at: now.toISOString(), total }
  }
  const sinceBaseline = baseline && total !== null ? Math.max(0, total - baseline.total) : null
  const sources = Object.entries(researchLive.bySource ?? {}).filter(([, n]) => Number.isFinite(n)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, count]) => ({ key, count }))
  const newest = (researchLive.recent ?? []).slice(0, 8).map((r) => ({ title: String(r.title ?? '').slice(0, 200), source: String(r.source ?? ''), url: typeof r.url === 'string' ? r.url : null, seenAt: iso(r.seenAt) })).filter((r) => r.title)
  const a = proofLive?.anchors?.find((x) => x.verified === true) ?? proofLive?.anchors?.find((x) => x.status === 'confirmed') ?? null
  const lines = []
  if (total !== null) lines.push(`The shared research store holds ${total.toLocaleString('en-US')} public records${Number.isFinite(t.explored) ? ` from ${t.explored} explored topics` : ''}.`)
  if (sinceBaseline) lines.push(`${sinceBaseline.toLocaleString('en-US')} were added since ${baseline.at.slice(0, 10)}.`)
  if (lastWeek) lines.push(`In the last full period (${lastWeek.from.slice(0, 10)} to ${lastWeek.to.slice(0, 10)}) ${lastWeek.added.toLocaleString('en-US')} were added.`)
  if (researchLive.maxwell) lines.push(`The newest Maxwell research block is number ${researchLive.maxwell.block}, covering ${researchLive.maxwell.count.toLocaleString('en-US')} records.`)
  if (a) lines.push(`The newest checked anchor (${a.id}) is witnessed by Bitcoin block ${a.bitcoinHeight}${a.verified === true ? ' and was re-checked by our status job against the real block' : ''}.`)
  lines.push('These are pointers to public records, not endorsements, and a timestamp shows when something existed, not that it is true.')
  return { version: 1, generatedAt: now.toISOString(), total, topics: { explored: t.explored ?? null, queued: t.queued ?? null }, sources, newest, baseline, lastWeek, anchor: a ? { id: a.id, bitcoinHeight: a.bitcoinHeight, verified: a.verified } : null, text: lines.join(' ') }
}
