import assert from 'node:assert/strict'
import test from 'node:test'
import { buildResearchLive, latestResearchAnchor } from '../src/research-live.mjs'
import { checkPlatform } from '../src/platform.mjs'
import { recordStatus } from '../src/status.mjs'
import { validName } from '../src/gcs.mjs'

const feed = (over = {}) => ({
  generated_at: '2026-10-16T20:00:44Z',
  counts: { pubmed: 268, europepmc: 279, trial: 164, clinvar: 211, 'bad key!': 5, neg: -3 },
  topics: { explored: 42, queued: 7 },
  chain: { audit_head_time: '2026-10-16T19:55:00Z', private: 'x' },
  crispr: [{ secret: 'no' }],
  recent: [
    { id: 'article:1', source: 'pubmed', title: 'A paper\n with   odd\u0000 spacing', url: 'https://pubmed.ncbi.nlm.nih.gov/1/', first_seen_at: '2026-10-16T19:42:56Z', meta: { journal: 'J', secret: 's' } },
    { id: 'variant:2', source: 'clinvar', title: 'NM_000546.6(TP53):c.742C>T', url: 'javascript:alert(1)', first_seen_at: 'not a date' },
    { id: '', source: 'pubmed', title: 'no id' },
    { id: 'x:3', source: 'Bad Source!', title: 'bad source' },
  ],
  ...over,
})

test('the live file keeps counts, topics and the newest records, and nothing else from the feed', () => {
  const live = buildResearchLive(feed(), new Date('2026-10-16T20:01:00Z'))
  assert.equal(live.generatedAt, '2026-10-16T20:01:00.000Z')
  assert.equal(live.lastReportAt, '2026-10-16T19:55:00.000Z')
  assert.deepEqual(live.bySource, { pubmed: 268, europepmc: 279, trial: 164, clinvar: 211 })       // a bad key and a negative count are dropped
  assert.equal(live.total, 922)
  assert.deepEqual(live.topics, { explored: 42, queued: 7 })
  assert.deepEqual(live.recent.map((r) => r.id), ['article:1', 'variant:2'])
  const text = JSON.stringify(live)
  for (const hidden of ['secret', 'journal', 'private', 'meta', 'crispr']) assert.ok(!text.includes(hidden), hidden)
})

test('titles are cleaned and only https links are passed on', () => {
  const live = buildResearchLive(feed())
  assert.equal(live.recent[0].title, 'A paper with odd spacing')
  assert.equal(live.recent[0].url, 'https://pubmed.ncbi.nlm.nih.gov/1/')
  assert.equal(live.recent[1].url, null)                                       // javascript: is never passed on
  assert.equal(live.recent[1].seenAt, null)
  const long = buildResearchLive(feed({ recent: [{ id: 'a', source: 'pubmed', title: 'x'.repeat(900), url: 'http://insecure.example.com/x' }] }))
  assert.equal(long.recent[0].title.length, 220)
  assert.equal(long.recent[0].url, null)                                       // plain http is not passed on either
})

test('at most 12 records are listed and a missing or broken feed gives no file', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `a:${i}`, source: 'pubmed', title: `t${i}`, url: 'https://pubmed.ncbi.nlm.nih.gov/1/' }))
  assert.equal(buildResearchLive(feed({ recent: many })).recent.length, 12)
  assert.equal(buildResearchLive(null), null)
  assert.equal(buildResearchLive('nope'), null)
  assert.deepEqual(buildResearchLive({}).recent, [])
})

const serve = (body) => async (url) => {
  if (String(url).includes('/api/public/research-feed')) return new Response(JSON.stringify(body), { status: 200 })
  if (String(url).includes('/status/history.json')) return new Response('', { status: 404 })
  if (String(url).endsWith('/api/data')) return new Response('{"datasets":[]}', { status: 200 })
  return new Response('RabbitSoftware ok {"ok":true} "status":"ok" "database":"ok" headHash datasets', { status: 200 })
}

test('the platform check carries the live file, and the latest feed keeps its old shape without it', async () => {
  const p = await checkPlatform({ fetchImpl: serve(feed()) })
  assert.equal(p.researchLive.recent.length, 2)
  assert.equal(p.research.records, 924)                                          // the old summary is unchanged: it sums every numeric count; the live file is stricter (922)
  const down = await checkPlatform({ fetchImpl: async (u) => (String(u).includes('research-feed') ? new Response('', { status: 503 }) : serve(feed())(u)) })
  assert.equal(down.researchLive, null)
  assert.equal(down.research, null)
})

test('recording writes the live research file with a no-cache header, and a failed write never stops the status feed', async () => {
  const uploads = []
  const out = await recordStatus({ fetchImpl: serve(feed()), bucket: 'status-bucket', upload: async (u) => { uploads.push(u); return true }, log: () => {}, now: new Date('2026-10-16T20:00:00Z') })
  assert.deepEqual(uploads.map((u) => u.name), ['status/latest.json', 'status/history.json', 'status/research-live.json'])
  assert.ok(uploads.every((u) => u.cacheControl === 'no-cache'))
  assert.equal(JSON.parse(uploads[2].body).recent[0].id, 'article:1')
  assert.ok(out.feed)
  const survived = await recordStatus({ fetchImpl: serve(feed()), bucket: 'status-bucket', upload: async (u) => { if (u.name.endsWith('research-live.json')) throw new Error('write refused'); return true }, log: () => {} })
  assert.ok(survived.feed)
  const none = []
  await recordStatus({ fetchImpl: async (u) => (String(u).includes('research-feed') ? new Response('', { status: 503 }) : serve(feed())(u)), bucket: 'status-bucket', upload: async (u) => { none.push(u.name); return true }, log: () => {} })
  assert.deepEqual(none, ['status/latest.json', 'status/history.json'])         // no feed, no live file (the last good one stays in the bucket)
  assert.ok(validName('status/research-live.json'))
})

const H = (c) => c.repeat(64)
const chain = (blocks) => ({ blocks })
const block = (index, sender, extra = {}) => ({ index, timestamp: 1792169012.3, hash: `00${String(index).repeat(62)}`.slice(0, 64), transactions: [{ sender, root: H('a'), count: 918, ...extra }] })

test('the newest research anchor of the Maxwell chain is found, and other blocks and odd shapes are ignored', () => {
  const a = latestResearchAnchor(chain([block(4, 'RESEARCH_ANCHOR', { count: 597 }), block(5, 'RABBITWEB_MINER'), block(7, 'RESEARCH_ANCHOR'), block(8, 'RABBITWEB_MINER')]))
  assert.deepEqual([a.block, a.count, a.root, a.chainLength], [7, 918, H('a'), 4])
  assert.equal(a.time, new Date(1792169012.3 * 1000).toISOString())
  assert.equal(a.hash.length, 16)
  for (const bad of [null, {}, { blocks: 'x' }, chain([]), chain([block(1, 'RABBITWEB_MINER')]), chain([block(1, 'RESEARCH_ANCHOR', { root: 'short' })]), chain([block(1, 'RESEARCH_ANCHOR', { count: 'many' })])]) assert.equal(latestResearchAnchor(bad), null)
})

test('the anchor rides along in the live file, and a missing anchor is null, not an error', () => {
  const a = latestResearchAnchor(chain([block(7, 'RESEARCH_ANCHOR')]))
  assert.equal(buildResearchLive(feed(), new Date('2026-10-16T20:01:00Z'), a).maxwell.block, 7)
  assert.equal(buildResearchLive(feed(), new Date('2026-10-16T20:01:00Z')).maxwell, null)
})

test('the platform check reads the Maxwell mirror, and a broken mirror only means no anchor', async () => {
  const body = JSON.stringify(chain([block(7, 'RESEARCH_ANCHOR')]))
  const fetchOk = async (u) => (String(u).includes('/maxwell/maxwell_chain.json') ? new Response(body, { status: 200 }) : serve(feed())(u))
  assert.equal((await checkPlatform({ fetchImpl: fetchOk })).researchLive.maxwell.block, 7)
  const fetchBad = async (u) => (String(u).includes('/maxwell/maxwell_chain.json') ? new Response('not json', { status: 200 }) : serve(feed())(u))
  const p = await checkPlatform({ fetchImpl: fetchBad })
  assert.equal(p.researchLive.maxwell, null)
  assert.equal(p.researchLive.recent.length, 2)
})
