import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPlatform, PROBES } from '../src/platform.mjs'
import { MAX_HISTORY, PUBLIC_KEYS, buildFeed, historyEntry, nextHistory, recordStatus } from '../src/status.mjs'
import { uploadObject, validName } from '../src/gcs.mjs'

const web = (down = []) => async (url) => {
  if (down.some((d) => url.includes(d))) return new Response('', { status: 503 })
  if (url.endsWith('/api/data')) return new Response('{"datasets":[{"id":"research_records","title":"Research records","rows":407,"columns":["id","title"]},{"id":"agents","rows":4,"columns":["id"]}]}', { status: 200 })
  if (url.endsWith('/api/chain/head') || url.includes('chain_head.json')) return new Response('{"length":2,"headHash":"2c8c40f2e436b2f0ba6ed46c0d760b2969eed2ce4aa4816caefb4edfc4cee41b"}', { status: 200 })
  if (url.includes('/status/history.json')) return new Response('', { status: 404 })
  return new Response('RabbitSoftware ok {"ok":true} "status":"ok" "database":"ok" headHash datasets', { status: 200 })
}

test('the feed holds only public-safe facts: no addresses, no private services, no audit findings', async () => {
  const feed = buildFeed(await checkPlatform({ fetchImpl: web() }), new Date('2026-10-15T14:00:00Z'))
  const text = JSON.stringify(feed)
  assert.equal(feed.total, PUBLIC_KEYS.length)
  assert.equal(feed.up, PUBLIC_KEYS.length)
  assert.deepEqual(feed.services.map((s) => s.key), [...PUBLIC_KEYS])
  assert.ok(!/https?:\/\//.test(text), 'no addresses in the feed')
  assert.ok(!/proxy|backup|squid|finding|score|secret|token/i.test(text))
  assert.equal(feed.chain.agree, true)
  assert.equal(feed.chain.app.head.length, 12)
  assert.deepEqual(feed.tree.map((d) => d.id), ['research_records', 'agents'])
  assert.deepEqual(feed.tree[0].columns, ['id', 'title'])
  assert.equal(feed.generatedAt, '2026-10-15T14:00:00.000Z')
})

test('a service that fails shows as down and is counted', async () => {
  const feed = buildFeed(await checkPlatform({ fetchImpl: web(['rabbit-site-standby']) }))
  assert.equal(feed.services.find((s) => s.key === 'standby').ok, false)
  assert.equal(feed.up, PUBLIC_KEYS.length - 1)
  assert.equal(historyEntry(feed).s.split('').filter((c) => c === '0').length, 1)
})

test('history keeps the last 288 entries and ignores damaged ones', async () => {
  const feed = buildFeed(await checkPlatform({ fetchImpl: web() }))
  const prev = Array.from({ length: 400 }, (_, i) => ({ t: `t${i}`, up: 11, total: 11, agree: true, s: '1'.repeat(11) }))
  const next = nextHistory(prev, feed)
  assert.equal(next.length, MAX_HISTORY)
  assert.equal(next.at(-1).t, feed.generatedAt)
  assert.equal(nextHistory([{ nope: 1 }, null, 'x'], feed).length, 1)
  assert.equal(nextHistory(undefined, feed).length, 1)
  assert.equal(nextHistory('garbage', feed).length, 1)
})

test('recording writes the feed and the history with a no-cache header and logs one status line', async () => {
  const uploads = [], lines = []
  const out = await recordStatus({ fetchImpl: web(['run.rabbitsoftware.io']), bucket: 'status-bucket', upload: async (u) => { uploads.push(u); return true }, log: (l) => lines.push(l), now: new Date('2026-10-15T14:00:00Z') })
  assert.deepEqual(uploads.map((u) => u.name), ['status/latest.json', 'status/history.json'])
  assert.ok(uploads.every((u) => u.cacheControl === 'no-cache' && u.contentType === 'application/json' && u.bucket === 'status-bucket'))
  assert.equal(JSON.parse(uploads[0].body).up, PUBLIC_KEYS.length - 1)
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), { event: 'status_check', up: PUBLIC_KEYS.length - 1, total: PUBLIC_KEYS.length, chain_agrees: true, down: 'mirror' })
  assert.equal(out.history.length, 1)
})

test('history already in the bucket is carried forward', async () => {
  const prior = [{ t: '2026-10-15T13:55:00.000Z', up: 11, total: 11, agree: true, s: '1'.repeat(11) }]
  const fetchImpl = async (url) => (url.includes('/status/history.json') ? new Response(JSON.stringify(prior), { status: 200 }) : web()(url))
  const out = await recordStatus({ fetchImpl, bucket: 'status-bucket', upload: async () => true, log: () => {} })
  assert.equal(out.history.length, 2)
  assert.equal(out.history[0].t, '2026-10-15T13:55:00.000Z')
})

test('status objects are allowed, and anything outside the layout is not', () => {
  assert.ok(validName('status/latest.json') && validName('status/history.json') && validName('latest.json') && validName('2026/10/15/report.html'))
  for (const bad of ['status/../x', 'status/a/b', 'other/latest.json', '/status/x.json']) assert.equal(validName(bad), false, bad)
})

test('a cache-controlled upload is sent as multipart with the cache header in its metadata', async () => {
  const calls = []
  await uploadObject({ bucket: 'status-bucket', name: 'status/latest.json', body: '{"a":1}', contentType: 'application/json', cacheControl: 'no-cache', token: 't', fetchImpl: async (u, i) => { calls.push({ u, i }); return new Response('{}', { status: 200 }) } })
  assert.match(calls[0].u, /uploadType=multipart$/)
  assert.match(calls[0].i.headers['Content-Type'], /^multipart\/related; boundary=/)
  assert.match(calls[0].i.body, /"cacheControl":"no-cache"/)
  assert.match(calls[0].i.body, /"name":"status\/latest.json"/)
  assert.ok(calls[0].i.body.includes('{"a":1}'))
})

test('the platform probe list still covers every public key', () => {
  const keys = PROBES.map((p) => p[0])
  for (const k of PUBLIC_KEYS) assert.ok(keys.includes(k), k)
})
