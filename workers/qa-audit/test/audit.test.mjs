import assert from 'node:assert/strict'
import test from 'node:test'
import { SEEDS, analyze, crawl, pageSeverity, parsePage, securityHeaders, siteChecks } from '../src/audit.mjs'

const GOOD_HEAD = '<title>RabbitSoftware research tools</title><meta name="description" content="Public research tools and a verifiable chain of records, read-only and open to everyone."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://rabbitsoftware.io/"><meta property="og:title" content="x"><meta property="og:description" content="y"><meta property="og:image" content="z">'
const filler = ' lorem'.repeat(80)
const page = (head, body) => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`
const SECURE = { 'strict-transport-security': 'max-age=1', 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=()' }

/** A small fake web. Each entry: [status, headers, body]. */
function fakeWeb(extra = {}) {
  const web = {
    'https://rabbitsoftware.io/': [200, { 'content-type': 'text/html', 'content-encoding': 'br', ...SECURE }, page(GOOD_HEAD, `<h1>Home</h1><a href="/chain">Chain</a><a href="/missing">Gone</a><a href="https://app.rabbitsoftware.io/api/health">health</a><p>${filler}</p>`)],
    'https://rabbitsoftware.io/chain': [200, { 'content-type': 'text/html', 'content-encoding': 'br', ...SECURE }, page(GOOD_HEAD.replace('RabbitSoftware research tools', 'Chain'), `<h1>Chain</h1><a href="/">Home</a><p>${filler}</p>`)],
    'https://rabbitsoftware.io/missing': [404, { 'content-type': 'text/html' }, '<h1>Not found</h1>'],
    'https://rabbitsoftware.io/robots.txt': [200, { 'content-type': 'text/plain' }, 'Sitemap: https://rabbitsoftware.io/sitemap.xml'],
    'https://rabbitsoftware.io/sitemap.xml': [200, { 'content-type': 'application/xml' }, '<urlset><url><loc>https://rabbitsoftware.io/</loc></url><url><loc>https://rabbitsoftware.io/old</loc></url></urlset>'],
    'https://rabbitsoftware.io/old': [404, { 'content-type': 'text/html' }, 'gone'],
    'https://app.rabbitsoftware.io/dashboard': [200, { 'content-type': 'text/html', 'content-security-policy-report-only': "default-src 'self'" }, '<html><head></head><body><a href="/guide"></a><img src="a.png"><img src="b.png" alt=""><img src="http://insecure.example/c.png" alt="c"></body></html>'],
    'https://app.rabbitsoftware.io/guide': [200, { 'content-type': 'text/html', 'content-encoding': 'br' }, page('<title>Guide</title>', `<h1>Guide</h1><h1>Again</h1><p>${filler}</p>`)],
    'https://app.rabbitsoftware.io/api/health': [200, { 'content-type': 'application/json' }, '{"status":"ok"}'],
    'https://app.rabbitsoftware.io/robots.txt': [404, {}, ''],
    'https://app.rabbitsoftware.io/sitemap.xml': [404, {}, ''],
    ...extra,
  }
  const fetchImpl = async (url) => {
    const entry = web[url] ?? (/__audit-404-check/.test(url) ? [url.startsWith('https://rabbitsoftware.io') ? 404 : 200, { 'content-type': 'text/html' }, url.startsWith('https://rabbitsoftware.io') ? 'x'.repeat(400) : 'app shell'] : [404, {}, ''])
    return new Response(entry[2], { status: entry[0], headers: entry[1] })
  }
  return fetchImpl
}

test('parsePage reads title, description, language, headings, images, links and mixed content', () => {
  const p = parsePage(page(GOOD_HEAD, '<h1>A</h1><img src="a"><img src="b" alt="ok"><img src="http://x.example/c.png" alt=""><a href="/x#frag">x</a><a href="mailto:a@b.c">mail</a><a href="https://other.example/">o</a><a href="/empty"></a>'), 'https://rabbitsoftware.io/')
  assert.equal(p.title, 'RabbitSoftware research tools')
  assert.match(p.description, /^Public research tools/)
  assert.equal(p.lang, 'en'); assert.equal(p.viewport, true); assert.equal(p.h1, 1)
  assert.equal(p.images, 3); assert.equal(p.imagesNoAlt, 1)
  assert.deepEqual(p.og, { title: true, description: true, image: true })
  assert.deepEqual(p.insecure, ['http://x.example/c.png'])
  assert.ok(p.links.includes('https://rabbitsoftware.io/x') && !p.links.some((l) => l.startsWith('mailto')))
  assert.equal(p.emptyLinks, 1)
  assert.equal(p.canonical, 'https://rabbitsoftware.io/')
})

test('links are read the way a browser reads them: &amp; becomes &, and Cloudflare tool addresses are not pages', () => {
  const p = parsePage(page(GOOD_HEAD, '<a href="/data?limit=25&amp;format=csv&amp;download=1">csv</a><a href="/cdn-cgi/l/email-protection#abc123">mail</a><a href="/real">r</a>'), 'https://rabbitsoftware.io/')
  assert.ok(p.links.includes('https://rabbitsoftware.io/data?limit=25&format=csv&download=1'))
  assert.ok(!p.links.some((l) => l.includes('&amp;')))
  assert.ok(!p.links.some((l) => l.includes('/cdn-cgi/')))
  assert.ok(p.links.includes('https://rabbitsoftware.io/real'))
})

test('parsePage on a bare page reports what is missing, not a crash', () => {
  const p = parsePage('<html><body>hi</body></html>', 'https://x.example/')
  assert.equal(p.title, ''); assert.equal(p.description, null); assert.equal(p.lang, null); assert.equal(p.viewport, false); assert.equal(p.h1, 0)
})

test('securityHeaders distinguishes enforced, report-only and none', () => {
  assert.equal(securityHeaders(new Headers(SECURE)).csp, 'enforced')
  assert.equal(securityHeaders(new Headers({ 'content-security-policy-report-only': "default-src 'self'" })).csp, 'report-only')
  assert.deepEqual(securityHeaders(new Headers()), { hsts: false, csp: 'none', contentTypeOptions: false, referrerPolicy: false, frameProtection: false, permissionsPolicy: false })
  assert.equal(securityHeaders(new Headers({ 'content-security-policy': "frame-ancestors 'none'" })).frameProtection, true)
})

test('the crawl stays inside the two sites, follows links, and records redirects and errors', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://rabbitsoftware.io/') return new Response(null, { status: 301, headers: { location: '/home' } })
    return fakeWeb({ 'https://rabbitsoftware.io/home': [200, { 'content-type': 'text/html' }, page(GOOD_HEAD, `<h1>Home</h1><a href="https://other.example/">out</a><a href="/chain">c</a><p>${filler}</p>`)] })(url)
  }
  const c = await crawl({ seeds: ['https://rabbitsoftware.io/'], fetchImpl })
  const urls = c.pages.map((p) => p.url)
  assert.ok(urls.includes('https://rabbitsoftware.io/') && urls.includes('https://rabbitsoftware.io/chain'))
  assert.ok(!urls.some((u) => u.includes('other.example')))
  assert.equal(c.pages.find((p) => p.url === 'https://rabbitsoftware.io/').hops.length, 1)
  assert.equal(c.pages.find((p) => p.url === 'https://rabbitsoftware.io/chain').depth, 1)
})

test('a slow page is measured again and the better reading is kept; fast pages are fetched once', async () => {
  const calls = {}
  const slowFirst = async (url) => {
    calls[url] = (calls[url] ?? 0) + 1
    if (url === 'https://rabbitsoftware.io/' && calls[url] === 1) await new Promise((r) => setTimeout(r, 60))      // the first reading is slow
    return fakeWeb()(url)
  }
  const c = await crawl({ seeds: ['https://rabbitsoftware.io/'], fetchImpl: slowFirst, maxPages: 1, remeasureAboveMs: 30 })
  assert.equal(calls['https://rabbitsoftware.io/'], 2)
  assert.ok(c.pages[0].ms < 60, `kept the faster reading, got ${c.pages[0].ms}`)
  const once = {}
  await crawl({ seeds: ['https://rabbitsoftware.io/'], fetchImpl: async (u) => { once[u] = (once[u] ?? 0) + 1; return fakeWeb()(u) }, maxPages: 1 })
  assert.equal(once['https://rabbitsoftware.io/'], 1)
})

test('the crawl honours the page limit and survives a failing fetch', async () => {
  let n = 0
  const fetchImpl = async (url) => { n++; if (url.endsWith('/chain')) throw new Error('boom'); return fakeWeb()(url) }
  const c = await crawl({ seeds: SEEDS, fetchImpl, maxPages: 3 })
  assert.equal(c.pages.length, 3)                              // exactly the limit: never more
  const chain = c.pages.find((p) => p.url.endsWith('/chain'))
  if (chain) assert.equal(chain.status, 0)
})

test('analysis finds the planted problems and not the absent ones', async () => {
  const fetchImpl = fakeWeb()
  const c = await crawl({ seeds: SEEDS, fetchImpl })
  const checks = await siteChecks({ crawlResult: c, fetchImpl })
  const a = analyze(c, checks)
  const ids = a.findings.map((f) => f.id)
  for (const expected of ['broken-link', 'missing-title', 'missing-description', 'missing-h1', 'multiple-h1', 'images-no-alt', 'mixed-content', 'missing-viewport', 'csp-report-only', 'no-hsts', 'no-robots', 'no-sitemap', 'sitemap-dead-url', 'soft-404', 'empty-links']) {
    assert.ok(ids.includes(expected), `${expected} should be found; got ${ids.join(', ')}`)
  }
  const missingTitle = a.findings.find((f) => f.id === 'missing-title')
  assert.ok(missingTitle.pages.includes('https://app.rabbitsoftware.io/dashboard') && !missingTitle.pages.includes('https://rabbitsoftware.io/'))
  assert.ok(a.findings.find((f) => f.id === 'soft-404').pages.includes('https://app.rabbitsoftware.io'))
  assert.ok(!ids.includes('bare-404'))                          // the site's 404 page has 400 bytes of content
  assert.ok(!ids.includes('no-compression'))                    // the pages are small or sent with br
})

test('a clean page produces no page-level findings', async () => {
  const good = { 'content-type': 'text/html', 'content-encoding': 'br', ...SECURE }
  const body = page(GOOD_HEAD, `<h1>Home</h1><img src="a" alt="a"><p>${filler}</p>`)
  const appBody = page(GOOD_HEAD.replace('RabbitSoftware research tools', 'RabbitOS console dashboard'), `<h1>Dashboard</h1><img src="a" alt="a"><p>${filler}</p>`)
  const fetchImpl = fakeWeb({ 'https://rabbitsoftware.io/': [200, good, body], 'https://app.rabbitsoftware.io/dashboard': [200, good, appBody] })
  const c = await crawl({ seeds: SEEDS, fetchImpl, maxPages: 2 })
  const a = analyze(c, { origins: {}, brokenLinks: [] })
  assert.deepEqual(a.findings.map((f) => f.id), [])
  assert.equal(a.score, 100)
})

test('the score is 100 minus 10, 5 and 2 per distinct high, medium and low finding, never below 0', async () => {
  const c = await crawl({ seeds: SEEDS, fetchImpl: fakeWeb() })
  const a = analyze(c, await siteChecks({ crawlResult: c, fetchImpl: fakeWeb() }))
  assert.equal(a.score, Math.max(0, 100 - a.counts.high * 10 - a.counts.medium * 5 - a.counts.low * 2))
  assert.ok(a.findings.every((f, i, arr) => i === 0 || ['high', 'medium', 'low'].indexOf(arr[i - 1].severity) <= ['high', 'medium', 'low'].indexOf(f.severity)))
})

test('pageSeverity gives each page its worst finding', () => {
  const sev = pageSeverity([{ severity: 'low', pages: ['a', 'b'] }, { severity: 'high', pages: ['b'] }, { severity: 'medium', pages: ['c'] }])
  assert.equal(sev.get('a'), 'low'); assert.equal(sev.get('b'), 'high'); assert.equal(sev.get('c'), 'medium')
})
