import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { esc, publicPlatformMap } from '../../../site/status-map.mjs'
import { LATE_AFTER_MIN, STALE_AFTER_MIN, ageText, ageMinutes, freshness, overall, strip, uptimePercent } from '../../../site/status-view.mjs'
import { PUBLIC_KEYS } from '../src/status.mjs'

const NOW = Date.parse('2026-10-15T14:00:00Z')
const svc = (key, ok = true, ms = 120) => ({ key, label: key, ok, ms })
const feed = (over = {}) => ({ generatedAt: '2026-10-15T13:58:00Z', up: 11, total: 11, services: PUBLIC_KEYS.map((k) => svc(k)), chain: { agree: true }, ...over })

test('the public map draws only public services and no private part', () => {
  const svg = publicPlatformMap(feed()).replace(' xmlns="http://www.w3.org/2000/svg"', '')      // the standard SVG namespace is the only address allowed
  for (const label of ['rabbitsoftware.io', 'app.rabbitsoftware.io', 'Guest shell gate', 'Database', 'Guest shell', 'Hub for AI assistants', 'Standby website', 'App mirror', 'Public chain copy', 'Visitors']) assert.ok(svg.includes(label), label)
  for (const secret of [/proxy/i, /backup/i, /squid/i, /bigquery/i, /owner/i, /vault/i, /R2/, /Maxwell/i, /service.?role/i, /https?:\/\//]) assert.ok(!secret.test(svg), String(secret))
  assert.ok(!/NaN|undefined|null/.test(svg))
})

test('the map colors a node by its service and shows a missing report as unknown', () => {
  const down = publicPlatformMap(feed({ services: PUBLIC_KEYS.map((k) => svc(k, k !== 'hub')) }))
  assert.ok(down.includes('m-bad') && down.includes('Hub for AI assistants: not answering'))
  const partial = publicPlatformMap(feed({ services: [svc('site')] }))
  assert.ok(partial.includes('m-unk') && partial.includes('m-ok'))
  assert.ok(publicPlatformMap(null).includes('m-unk'))
})

test('a hostile feed cannot inject markup into the map', () => {
  const evil = '"><script>alert(1)</script>'
  const svg = publicPlatformMap(feed({ services: [{ key: 'site', label: evil, ok: true, ms: evil }] }))
  assert.ok(!svg.includes('<script') && !svg.includes(evil))
  assert.equal(esc(evil), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('freshness: live, late, stale', () => {
  const at = (min) => new Date(NOW - min * 60000).toISOString()
  assert.equal(freshness(at(2), NOW), 'live')
  assert.equal(freshness(at(LATE_AFTER_MIN), NOW), 'live')
  assert.equal(freshness(at(LATE_AFTER_MIN + 1), NOW), 'late')
  assert.equal(freshness(at(STALE_AFTER_MIN + 1), NOW), 'stale')
  assert.equal(freshness('garbage', NOW), 'stale')
  assert.equal(ageMinutes('2099-01-01T00:00:00Z', NOW), 0)               // a clock in the future never gives a negative age
  assert.deepEqual(['2026-10-15T13:59:50Z', '2026-10-15T13:55:00Z', '2026-10-15T12:00:00Z', '2026-10-12T14:00:00Z', 'x'].map((t) => ageText(t, NOW)), ['just now', '5 minutes ago', '2 hours ago', '3 days ago', 'unknown'])
})

test('the headline: all answering, some down, all down, feed too old', () => {
  assert.deepEqual(overall(feed(), NOW), { state: 'ok', text: 'All 11 services are answering.' })
  const some = overall(feed({ services: PUBLIC_KEYS.map((k) => svc(k, k !== 'hub' && k !== 'mirror')) }), NOW)
  assert.equal(some.state, 'degraded'); assert.match(some.text, /2 of 11 services not answering: hub, mirror/)
  assert.equal(overall(feed({ services: PUBLIC_KEYS.map((k) => svc(k, false)) }), NOW).state, 'down')
  assert.equal(overall(feed({ generatedAt: '2026-10-15T12:00:00Z' }), NOW).state, 'stale')       // an old report must not read "all answering"
  assert.equal(overall(null, NOW).state, 'unknown')
})

test('the 24 hour strip marks answering, not answering and silent slots', () => {
  const entry = (minAgo, s) => ({ t: new Date(NOW - minAgo * 60000).toISOString(), s })
  const history = [entry(10, '111'), entry(11, '101'), entry(300, '111'), entry(1500, '000')]   // the last one is older than 24 h and ignored
  const s0 = strip(history, 0, 48, NOW), s1 = strip(history, 1, 48, NOW)
  assert.equal(s0.length, 48)
  assert.equal(s0[47], 'up'); assert.equal(s1[47], 'down')               // one failed report in the slot makes it down
  assert.equal(s0.filter((x) => x === 'none').length, 46)
  assert.deepEqual(strip(undefined, 0, 48, NOW), Array(48).fill('none'))
  assert.deepEqual(strip([{ t: 'x', s: '1' }, null, { t: entry(5, '1').t }], 0, 48, NOW), Array(48).fill('none'))
  assert.deepEqual(strip(history, 9, 48, NOW), Array(48).fill('none'))   // an index beyond the entry
})

test('uptime percent counts answering reports and says nothing without data', () => {
  assert.equal(uptimePercent([{ t: 'a', s: '1' }, { t: 'b', s: '1' }, { t: 'c', s: '0' }, { t: 'd', s: '1' }], 0), 75)
  assert.equal(uptimePercent([], 0), null)
  assert.equal(uptimePercent(undefined, 0), null)
  assert.equal(uptimePercent([{ t: 'a', s: '1' }], 3), null)
})

test('the page and its headers fit together', () => {
  const html = readFileSync(new URL('../../../site/status.html', import.meta.url), 'utf8')
  const headers = readFileSync(new URL('../../../site/_headers', import.meta.url), 'utf8')
  const js = readFileSync(new URL('../../../site/status.js', import.meta.url), 'utf8')
  const host = /BASE = 'https:\/\/([^/']+)/.exec(js)[1]
  assert.match(headers, new RegExp(`connect-src [^;]*https://${host.replaceAll('.', '\\.')}`))             // the page may read exactly this host
  assert.ok(!/connect-src [^;]*\*/.test(headers))
  for (const file of ['/status-map.mjs', '/status-view.mjs']) assert.match(headers, new RegExp(`${file.replace('.', '\\.')}\\r?\\n\\s+Content-Type: application/javascript`))
  assert.match(html, /<script type="module" src="status\.js">/)
  for (const id of ['headline', 'when', 'error', 'services', 'map', 'chain', 'tree', 'check', 'direct']) assert.ok(html.includes(`id="${id}"`), id)
  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(html), 'no inline script: the CSP allows it, but the page does not need it')
  assert.ok(!/innerHTML\s*=/.test(js.replace("$('map').innerHTML = publicPlatformMap(feed)", '')), 'innerHTML is used only for the escaped map')
})

import { heartbeatView } from '../../../site/status-view.mjs'
const beat = (over = {}) => ({ cells: '0'.repeat(280) + '12212120', mutualPct: 3.1, sentence: 'In the last 24 hours the PC and the cloud heard each other in 3.1% of 5-minute slots.', lastCloudStep: '2026-10-15T13:58:00Z', lastPcStep: '2026-10-15T13:55:00Z', lastHeard: { pc: '2026-10-15T13:58:00Z', cloud: '2026-10-15T13:55:00Z' }, ...over })

test('the heartbeat maps cells to three states and says when each side last heard the other', () => {
  const v = heartbeatView(beat(), NOW)
  assert.equal(v.cells.length, 288)
  assert.deepEqual([...new Set(v.cells)].sort(), ['mutual', 'none', 'partial'])
  assert.equal(v.state, 'ok')
  assert.ok(v.detail.includes('2 minutes ago') && v.detail.includes('5 minutes ago'))
})

test('a quiet PC is not an outage, but a silent cloud side makes the chart stale', () => {
  const quiet = heartbeatView(beat({ lastHeard: { pc: '2026-10-15T09:00:00Z', cloud: '2026-10-15T09:00:00Z' } }), NOW)
  assert.equal(quiet.state, 'quiet')
  assert.ok(quiet.detail.includes('not an outage'))
  assert.equal(heartbeatView(beat({ lastCloudStep: '2026-10-15T10:00:00Z' }), NOW).state, 'stale')
})

test('an unreadable heartbeat is shown as unknown, and it holds nothing but times and counts', () => {
  assert.equal(heartbeatView(null, NOW).state, 'unknown')
  assert.equal(heartbeatView({ cells: 5 }, NOW).state, 'unknown')
  const html = readFileSync(new URL('../../../site/status.html', import.meta.url), 'utf8')
  assert.ok(html.includes('id="beat"') && html.includes('Heartbeat: PC and cloud'))
})
