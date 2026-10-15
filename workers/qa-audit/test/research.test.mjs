import assert from 'node:assert/strict'
import test from 'node:test'
import { researchLine } from '../../../site/status-view.mjs'
import { checkPlatform, readResearch } from '../src/platform.mjs'
import { buildFeed } from '../src/status.mjs'

const NOW = Date.parse('2026-10-15T14:00:00Z')
const feedBody = { generated_at: '2026-10-15T13:00:00Z', counts: { pubmed: 34, clinvar: 111, junk: 'x' }, topics: { explored: 9, queued: 8 }, chain: { audit_head_time: '2026-10-15T12:30:00+00:00', audit_head_hash: 'h' }, recent: [{ title: 'private-looking title' }] }
const serve = (body, status = 200) => async () => new Response(JSON.stringify(body), { status })

test('readResearch keeps only the last report time and counts', async () => {
  const r = await readResearch(serve(feedBody))
  assert.deepEqual(r, { lastReportAt: '2026-10-15T12:30:00.000Z', records: 145, topicsExplored: 9, topicsQueued: 8 })
  assert.ok(!JSON.stringify(r).includes('private-looking'))
})

test('readResearch gives null when the feed is down, broken or offline, and null time when there is no audit entry', async () => {
  assert.equal(await readResearch(serve({}, 503)), null)
  assert.equal(await readResearch(async () => new Response('not json')), null)
  assert.equal(await readResearch(async () => { throw new TypeError('offline') }), null)
  const none = await readResearch(serve({ counts: { a: 1 } }))
  assert.equal(none.lastReportAt, null)
})

test('the research block reaches the public feed and does not change the service counts', async () => {
  const fetchImpl = async (url) => (url.endsWith('/api/public/research-feed') ? new Response(JSON.stringify(feedBody)) : new Response('{"status":"ok","database":"ok","headHash":"h","length":2,"datasets":[],"ok":true} RabbitSoftware ok'))
  const p = await checkPlatform({ fetchImpl })
  const feed = buildFeed(p, new Date(NOW))
  assert.equal(feed.research.records, 145)
  assert.equal(feed.total, 11)
  const offline = buildFeed(await checkPlatform({ fetchImpl: async () => { throw new TypeError('offline') } }), new Date(NOW))
  assert.equal(offline.research, null)
})

test('researchLine: recent, quiet after a day, unknown without data; a quiet day is never an outage', () => {
  const recent = researchLine({ lastReportAt: '2026-10-15T12:30:00Z', records: 145, topicsExplored: 9, topicsQueued: 8 }, NOW)
  assert.equal(recent.state, 'ok')
  assert.match(recent.text, /1 hour ago.*145 public records.*9 topics explored, 8 queued/)
  const quiet = researchLine({ lastReportAt: '2026-10-10T16:41:06Z', records: 145 }, NOW)
  assert.equal(quiet.state, 'quiet')
  assert.match(quiet.text, /private computer/)
  assert.equal(researchLine(null, NOW).state, 'unknown')
  assert.equal(researchLine({ lastReportAt: null, records: 3 }, NOW).state, 'unknown')
})
