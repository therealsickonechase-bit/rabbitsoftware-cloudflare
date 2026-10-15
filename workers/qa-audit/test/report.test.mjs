import assert from 'node:assert/strict'
import test from 'node:test'
import { SEEDS, analyze, crawl, siteChecks } from '../src/audit.mjs'
import { checkPlatform, PROBES } from '../src/platform.mjs'
import { platformMap, siteMap, mostLinked, esc } from '../src/maps.mjs'
import { renderReport } from '../src/report.mjs'
import { buildReport, summaryOf } from '../src/run.mjs'
import { uploadObject, validName } from '../src/gcs.mjs'

const EVIL = '<script>alert(1)</script>"><img src=x onerror=alert(2)>'
const html = (title, body = '') => `<html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width"></head><body><h1>x</h1>${body}<p>${'word '.repeat(60)}</p></body></html>`
function web() {
  const table = {
    'https://rabbitsoftware.io/': [200, 'text/html', html(EVIL, '<a href="/a">a</a><a href="/gone">g</a>')],
    'https://rabbitsoftware.io/a': [200, 'text/html', html('Page A')],
    'https://rabbitsoftware.io/gone': [404, 'text/html', 'nope'],
    'https://app.rabbitsoftware.io/dashboard': [200, 'text/html', html('Dashboard', '<a href="/guide">g</a>')],
    'https://app.rabbitsoftware.io/guide': [200, 'text/html', html('Guide')],
    'https://app.rabbitsoftware.io/api/health': [200, 'application/json', '{"status":"ok","checks":{"database":"ok"}}'],
    'https://app.rabbitsoftware.io/api/chain/head': [200, 'application/json', '{"length":2,"headHash":"abc"}'],
    'https://app.rabbitsoftware.io/api/data': [200, 'application/json', '{"datasets":[{"id":"research_records","rows":407},{"id":"agents","rows":4}]}'],
    'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/ledger/chain_head.json': [200, 'application/json', '{"length":2,"headHash":"abc"}'],
  }
  return async (url) => {
    const e = table[url]
    if (e) return new Response(e[2], { status: e[0], headers: { 'content-type': e[1] } })
    if (PROBES.some((p) => p[2] === url)) return new Response('RabbitSoftware ok {"ok":true} headHash', { status: 200 })
    return new Response('', { status: 404 })
  }
}

test('esc neutralises markup in every position', () => {
  assert.equal(esc(EVIL), '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(2)&gt;')
  assert.equal(esc(null), '')
})

test('platform checks report each service and whether the chain copies agree', async () => {
  const p = await checkPlatform({ fetchImpl: web() })
  assert.equal(p.total, PROBES.length)
  assert.equal(p.nodes.app.ok, true)
  assert.equal(p.chain.agree, true)
  assert.deepEqual(p.data, { datasets: 2, researchRows: 407, rows: 411 })
  const split = await checkPlatform({ fetchImpl: async (u) => (u.includes('storage.googleapis.com') ? new Response('{"length":3,"headHash":"zzz"}', { status: 200 }) : web()(u)) })
  assert.equal(split.chain.agree, false)
  const down = await checkPlatform({ fetchImpl: async () => { throw new TypeError('offline') } })
  assert.equal(down.up, 0)
  assert.equal(down.nodes.site.error, 'TypeError')
})

test('the platform map draws every node once, colors by status, and marks unchecked parts grey', async () => {
  const p = await checkPlatform({ fetchImpl: web() })
  const svg = platformMap(p)
  assert.match(svg, /^<svg[^>]+viewBox/)
  for (const label of ['rabbitsoftware.io', 'app.rabbitsoftware.io', 'Visitor shell', 'Hub MCP', 'Public ledger', 'Allowlist proxy', 'Supabase']) assert.ok(svg.includes(label), label)
  assert.ok(svg.includes('m-unk'))
  const broken = platformMap(await checkPlatform({ fetchImpl: async () => new Response('', { status: 500 }) }))
  assert.ok(broken.includes('m-bad') && !broken.includes('m-ok'))
  assert.ok(!/NaN|undefined/.test(svg))
})

test('the site map places every page, links parents to children and marks broken pages', async () => {
  const c = await crawl({ seeds: SEEDS, fetchImpl: web() })
  const svg = siteMap(c.pages, new Map([['https://rabbitsoftware.io/a', 'medium']]))
  assert.equal((svg.match(/<circle class="m-page"/g) ?? []).length, c.pages.length)
  assert.ok(svg.includes('m-warn') && svg.includes('m-bad') && svg.includes('×'))
  assert.ok(svg.includes('<line class="m-edge"'))
  assert.ok(!/NaN|undefined/.test(svg))
  assert.deepEqual(mostLinked({ 'https://x/a': ['1', '2'], 'https://x/b': ['1'] }), [{ url: 'https://x/a', count: 2 }, { url: 'https://x/b', count: 1 }])
})

test('the report is complete, themed, and a hostile page title cannot inject script', async () => {
  const data = await buildReport({ fetchImpl: web(), now: () => new Date('2026-10-15T14:00:00Z') })
  const page = renderReport(data, { standalone: true })
  assert.match(page, /^<!doctype html>/)
  assert.ok(page.includes('<title>RabbitWeb Audit</title>'))
  assert.ok(page.includes('prefers-color-scheme: dark') && page.includes('[data-theme="dark"]') && page.includes('body{margin:0;background:var(--bg)'))
  for (const id of ['id="fix"', 'id="platform"', 'id="site"', 'id="pages"', 'id="security"', 'id="method"']) assert.ok(page.includes(id), id)
  assert.ok(!page.includes('<script'), 'the report contains no script')
  assert.ok(!page.includes(EVIL) && page.includes('&lt;script&gt;alert(1)'))
  assert.ok(!/onerror=alert/.test(page.replace(/&lt;img src=x onerror=alert\(2\)&gt;/g, '')))
  assert.ok(page.includes('2026-10-15 14:00 UTC'))
  const fragment = renderReport(data, { standalone: false })
  assert.ok(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(fragment))
  assert.ok(fragment.startsWith('<title>RabbitWeb Audit</title>'))
})

test('the summary is small and carries what the workflow needs', async () => {
  const data = await buildReport({ fetchImpl: web() })
  const s = summaryOf(data)
  assert.equal(typeof s.score, 'number')
  assert.ok(['high', 'medium', 'low', 'servicesUp', 'servicesTotal', 'chainAgrees', 'top', 'pagesAudited'].every((k) => k in s))
  assert.ok(JSON.stringify(s).length < 2000)
  assert.ok(s.top.length <= 5)
})

test('uploads accept only sane bucket and object names and use the job identity token', async () => {
  assert.ok(validName('latest.json') && validName('2026/10/15/report.html'))
  for (const bad of ['../x', 'a/b', '2026/10/15/../x', '', 'x'.repeat(80), 'a b', null]) assert.equal(validName(bad), false, String(bad))
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('{"access_token":"tok"}', { status: 200 }) }
  assert.equal(await uploadObject({ bucket: 'my-reports', name: 'latest.json', body: '{}', contentType: 'application/json', fetchImpl }), true)
  assert.match(calls[0].url, /metadata\.google\.internal/)
  assert.match(calls[1].url, /\/upload\/storage\/v1\/b\/my-reports\/o\?uploadType=media&name=latest\.json$/)
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok')
  await assert.rejects(() => uploadObject({ bucket: 'Bad Bucket', name: 'x', body: '', contentType: 'a', fetchImpl }))
  await assert.rejects(() => uploadObject({ bucket: 'my-reports', name: '../x', body: '', contentType: 'a', fetchImpl }))
  await assert.rejects(() => uploadObject({ bucket: 'my-reports', name: 'x.json', body: '', contentType: 'a', token: 't', fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/)
})
