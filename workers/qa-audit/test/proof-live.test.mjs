import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildDigest, buildProofLive, parseOts, verifyAnchor } from '../src/proof-live.mjs'

const anchor = readFileSync(new URL('./fixtures/anchor.json', import.meta.url))
const ots = readFileSync(new URL('./fixtures/anchor.json.ots', import.meta.url))
// Merkle roots of the real Bitcoin blocks named in the fixture proof (read from mempool.space on 2026-10-17).
const ROOTS = {
  971827: 'b28b23d27cb385e272f879e016897b76ae2a2997cbaf6fdf98f6a0bf161f8095',
  971838: '7d6b40fe5dc0903ebad9cf5fad9a7948d73fbb705b15be4dff083a125273cf6d',
  971845: '9fee538410ff346b0d0625efef9cf9639c76437bdc78426e6f7a06fe864401b5',
}
const answer = (root) => [{ source: 'mempool.space', root }, { source: 'blockstream.info', root }]      // two independent public sources
const lookup = async (h) => { if (!ROOTS[h]) throw new Error('unknown block'); return answer(ROOTS[h]) }
const NOW = new Date('2026-10-17T15:00:00Z')

test('a real anchor proof is parsed and checks out against the real Bitcoin block roots', async () => {
  const { leaves } = parseOts(ots)
  assert.deepEqual(leaves.filter((l) => l.kind === 'bitcoin').map((l) => l.height).sort(), [971827, 971838, 971845])
  const r = await verifyAnchor(anchor, ots, lookup)
  assert.equal(r.verified, true)
  assert.match(r.reason, /3 Bitcoin blocks/)
})

test('one Bitcoin source is not enough, two that disagree are a red flag, and a single source can be allowed on purpose', async () => {
  const one = await verifyAnchor(anchor, ots, async (h) => answer(ROOTS[h]).slice(0, 1))
  assert.equal(one.verified, null)                                              // it matches, but is not counted: never a failure
  assert.match(one.reason, /only one Bitcoin source answered/)
  assert.equal((await verifyAnchor(anchor, ots, async (h) => answer(ROOTS[h]).slice(0, 1), 1)).verified, true)
  const split = await verifyAnchor(anchor, ots, async (h) => [{ source: 'mempool.space', root: ROOTS[h] }, { source: 'blockstream.info', root: 'f'.repeat(64) }])
  assert.equal(split.verified, false)
  assert.match(split.reason, /sources disagree/)
  assert.equal((await verifyAnchor(anchor, ots, async () => [])).verified, null)        // nobody answered: unknown, not failed
  assert.equal((await verifyAnchor(anchor, ots, async (h) => [{ source: 'a', root: ROOTS[h] }, { source: 'a', root: ROOTS[h] }])).verified, null)   // the same source twice is still one source
})

test('the real lookup asks every source, leaves out the ones that fail, and reports which sources answered', async () => {
  const { bitcoinLookup } = await import('../src/proof-live.mjs')
  const root = 'ab'.repeat(32), hash = 'cd'.repeat(32)
  const fake = (down) => async (url) => {
    if (String(url).includes(down)) throw new Error('offline')
    return String(url).includes('/block-height/') ? new Response(hash) : new Response(JSON.stringify({ merkle_root: root }))
  }
  assert.deepEqual(await bitcoinLookup(fake('nothing'))(1), [{ source: 'mempool.space', root }, { source: 'blockstream.info', root }])
  assert.deepEqual(await bitcoinLookup(fake('blockstream'))(1), [{ source: 'mempool.space', root }])
  assert.deepEqual(await bitcoinLookup(async () => new Response('not a hash'))(1), [])
})

test('a changed anchor, a wrong block root, garbage, and an unreachable Bitcoin API are told apart', async () => {
  assert.equal((await verifyAnchor(Buffer.concat([anchor, Buffer.from(' ')]), ots, lookup)).verified, false)       // the anchor file was altered
  const wrong = await verifyAnchor(anchor, ots, async () => answer('0'.repeat(64)))
  assert.equal(wrong.verified, false)
  assert.match(wrong.reason, /Merkle root of Bitcoin block/)
  for (const bad of [Buffer.alloc(0), Buffer.from('not a proof'), ots.subarray(0, 60)]) assert.equal((await verifyAnchor(anchor, bad, lookup)).verified, false)
  const down = await verifyAnchor(anchor, ots, async () => { throw new Error('offline') })
  assert.equal(down.verified, null)                                                                                // could not check: never reported as a failure
  assert.match(down.reason, /could not be reached/)
})

const index = [
  { id: '2026-10-17T070013Z', digest: 'a'.repeat(64), status: 'confirmed', bitcoinHeight: 971827, ledgerLength: 16, maxwellLength: 13, tsa: 'freetsa.org' },
  { id: '2026-10-17T130014Z', digest: 'b'.repeat(64), status: 'pending', bitcoinHeight: null, ledgerLength: 18, maxwellLength: 14 },
  { id: 'bad id', digest: 'c'.repeat(64), status: 'confirmed' },
  null,
]
const serve = (over = {}) => async (url) => {
  const u = String(url)
  if (over[u]) return over[u]()
  if (u.includes('/anchors/index.json')) return new Response(JSON.stringify(index))
  if (u.endsWith('2026-10-17T070013Z/anchor.json')) return new Response(anchor)
  if (u.endsWith('2026-10-17T070013Z/anchor.json.ots')) return new Response(ots)
  if (u.endsWith('2026-10-17T130014Z/anchor.json')) return new Response(JSON.stringify({ ledger: { headHash: 'f'.repeat(64), length: 18 }, maxwell: { headHash: 'e'.repeat(64), headIndex: 13, length: 14 } }))
  return new Response('', { status: 404 })
}

test('the proof file checks new confirmed anchors, keeps pending ones pending, and drops malformed index rows', async () => {
  // the fixture anchor's digest is its own sha256; make the index agree so the real files are used
  const { createHash } = await import('node:crypto')
  index[0].digest = createHash('sha256').update(anchor).digest('hex')
  const p = await buildProofLive({ fetchImpl: serve(), now: NOW, lookup })
  assert.equal(p.version, 1)
  assert.deepEqual(p.anchors.map((a) => a.id), ['2026-10-17T070013Z', '2026-10-17T130014Z'])
  assert.equal(p.anchors[0].verified, true)
  assert.equal(p.anchors[0].checkedAt, NOW.toISOString())
  assert.equal(p.anchors[1].verified, null)
  assert.match(p.anchors[1].reason, /waiting for a Bitcoin block/)
  assert.deepEqual([p.summary.anchors, p.summary.confirmed, p.summary.pending, p.summary.verified, p.summary.failed], [2, 1, 1, 1, 0])
  assert.deepEqual(p.summary.witnesses, ['Bitcoin via OpenTimestamps', 'FreeTSA (RFC 3161)'])
  assert.equal(p.heads.maxwellHeadIndex, 12)            // the head named inside the real fixture anchor (Maxwell block 12)
  assert.deepEqual(p.notYetOn, ['Ethereum', 'XRP Ledger'])
})

test('an anchor that already checked out is not checked again, and a failed lookup does not erase it', async () => {
  const first = await buildProofLive({ fetchImpl: serve(), now: NOW, lookup })
  let calls = 0
  const second = await buildProofLive({ fetchImpl: serve(), now: new Date(NOW.getTime() + 300_000), previous: first, lookup: async () => { calls++; throw new Error('offline') } })
  assert.equal(calls, 0)
  assert.equal(second.anchors[0].verified, true)
  assert.equal(second.anchors[0].checkedAt, NOW.toISOString())
})

test('a failing check is published as failed, an unreadable index gives null, and the per-run budget is respected', async () => {
  const bad = await buildProofLive({ fetchImpl: serve(), now: NOW, lookup: async () => answer('0'.repeat(64)) })
  assert.equal(bad.anchors[0].verified, false)
  assert.equal(bad.summary.failed, 1)
  const indexUrl = `https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/index.json?cb=${Math.floor(NOW / 60_000)}`
  assert.equal(await buildProofLive({ fetchImpl: serve({ [indexUrl]: () => new Response('', { status: 500 }) }), now: NOW, lookup }), null)
  const none = await buildProofLive({ fetchImpl: serve(), now: NOW, lookup, maxVerify: 0 })
  assert.equal(none.anchors[0].verified, null)
  assert.match(none.anchors[0].reason, /not checked yet/)
})

const live = (over = {}) => ({ version: 1, generatedAt: '2026-10-17T14:55:00Z', total: 1565, bySource: { pubmed: 300, europepmc: 280, physics_paper: 37 }, topics: { explored: 55, queued: 0 },
  recent: [{ title: 'Do We Live in an Antigravity Universe?', source: 'Physics preprints', url: 'https://arxiv.org/abs/2409.18145', seenAt: '2026-10-17T00:18:45Z' }, { title: '', source: 'x' }],
  maxwell: { block: 12, count: 1512, time: '2026-10-17T02:17:21Z' }, ...over })

test('the digest is plain language, keeps a weekly baseline, and says only what the numbers support', async () => {
  const proof = await buildProofLive({ fetchImpl: serve(), now: NOW, lookup })
  const d1 = buildDigest({ researchLive: live(), proofLive: proof, now: NOW })
  assert.equal(d1.total, 1565)
  assert.equal(d1.baseline.total, 1565)
  assert.equal(d1.lastWeek, null)
  assert.match(d1.text, /1,565 public records from 55 explored topics/)
  assert.match(d1.text, /Maxwell research block is number 12, covering 1,512 records/)
  assert.match(d1.text, /anchor \(2026-10-17T070013Z\) is witnessed by Bitcoin block 971827 and was re-checked/)
  assert.match(d1.text, /not endorsements/)
  assert.equal(d1.newest.length, 1)                                                                                 // the title-less row is dropped
  assert.deepEqual(d1.sources[0], { key: 'pubmed', count: 300 })
  // two days later: same baseline, growth counted since it
  const d2 = buildDigest({ researchLive: live({ total: 1600 }), proofLive: proof, previous: d1, now: new Date(NOW.getTime() + 2 * 86_400_000) })
  assert.equal(d2.baseline.total, 1565)
  assert.match(d2.text, /35 were added since 2026-10-17/)
  // eight days later: a full period is reported and a new baseline starts
  const d3 = buildDigest({ researchLive: live({ total: 1700 }), proofLive: proof, previous: d1, now: new Date(NOW.getTime() + 8 * 86_400_000) })
  assert.equal(d3.lastWeek.added, 135)
  assert.equal(d3.baseline.total, 1700)
  assert.equal(buildDigest({ researchLive: null, proofLive: proof, now: NOW }), null)
})
