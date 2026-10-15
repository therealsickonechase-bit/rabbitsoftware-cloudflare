// Site audit for rabbitsoftware.io and the RabbitOS app (app.rabbitsoftware.io). Crawls the PUBLIC pages, checks what a visitor and a search engine would meet,
// and turns the results into findings with a plain fix for each. Pure apart from the injected `fetchImpl`: no credentials, no writes to the sites.
// Limits (stated in the report too): HTML is read with simple patterns, not a browser; scripts are not run; only public pages are visited.

export const SITE = 'https://rabbitsoftware.io'
export const APP = 'https://app.rabbitsoftware.io'
export const SCOPE = Object.freeze([SITE, APP])
export const SEEDS = Object.freeze([`${SITE}/`, `${APP}/dashboard`])
export const SEVERITY = Object.freeze(['high', 'medium', 'low'])
const DEDUCT = { high: 10, medium: 5, low: 2 }

// ---------------------------------------------------------------- reading one HTML page

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null
}
/** Attribute values as a browser reads them: &amp; is &, so a link written ?a=1&amp;b=2 is requested as ?a=1&b=2. */
const unescapeAttr = (s) => String(s).replace(/&#0*38;|&amp;/gi, '&').replace(/&quot;|&#0*34;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()

/** Facts about one HTML document. `url` is the final address (relative links are resolved against it). */
export function parsePage(html, url) {
  const text = String(html)
  const metas = [...text.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0])
  const meta = (key) => { for (const t of metas) { const k = attr(t, 'name') ?? attr(t, 'property'); if (k && k.toLowerCase() === key) return attr(t, 'content') } return null }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)
  const imgs = [...text.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0])
  const links = []
  for (const m of text.matchAll(/<a\b[^>]*>/gi)) {
    const raw = attr(m[0], 'href')
    const href = raw === null ? null : unescapeAttr(raw)
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue
    try {
      const u = new URL(href, url)
      // /cdn-cgi/ addresses belong to Cloudflare's own tooling (for example e-mail obfuscation) and only work with their fragment: not pages.
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.pathname.startsWith('/cdn-cgi/')) { u.hash = ''; links.push(u.toString()) }
    } catch { /* not a URL */ }
  }
  const anchors = [...text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
  const emptyLinks = anchors.filter(([, a, inner]) => attr(a, 'href') && !decode(inner.replace(/<[^>]+>/g, ' ')) && !/<img\b[^>]*\balt=["'][^"']+/i.test(inner) && !attr(a, 'aria-label') && !attr(a, 'title')).length
  const insecure = []
  if (new URL(url).protocol === 'https:') {
    for (const m of text.matchAll(/<(?:img|script|iframe|source|link)\b[^>]*>/gi)) { const s = attr(m[0], 'src') ?? (/rel=["']?stylesheet/i.test(m[0]) ? attr(m[0], 'href') : null); if (s && /^http:\/\//i.test(s)) insecure.push(s) }
  }
  return {
    title: titleMatch ? decode(titleMatch[1]) : '',
    description: meta('description'),
    lang: (/<html\b[^>]*\blang\s*=\s*["']?([A-Za-z-]+)/i.exec(text) ?? [])[1] ?? null,
    viewport: meta('viewport') !== null,
    canonical: (() => { for (const m of text.matchAll(/<link\b[^>]*>/gi)) if (/rel=["']?canonical/i.test(m[0])) return attr(m[0], 'href'); return null })(),
    og: { title: meta('og:title') !== null, description: meta('og:description') !== null, image: meta('og:image') !== null },
    h1: (text.match(/<h1[\s>]/gi) ?? []).length,
    images: imgs.length,
    imagesNoAlt: imgs.filter((t) => attr(t, 'alt') === null).length,
    scriptsExternal: [...text.matchAll(/<script\b[^>]*\bsrc\s*=/gi)].length,
    scriptsInline: [...text.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi)].length,
    stylesheets: [...text.matchAll(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi)].length,
    links: [...new Set(links)],
    emptyLinks,
    insecure: [...new Set(insecure)],
    words: decode(text.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).split(' ').filter(Boolean).length,
    bytes: Buffer.byteLength(text),
  }
}

export function securityHeaders(headers) {
  const get = (n) => headers.get(n)
  const csp = get('content-security-policy')
  const cspRo = get('content-security-policy-report-only')
  return {
    hsts: !!get('strict-transport-security'),
    csp: csp ? 'enforced' : cspRo ? 'report-only' : 'none',
    contentTypeOptions: /nosniff/i.test(get('x-content-type-options') ?? ''),
    referrerPolicy: !!get('referrer-policy'),
    frameProtection: !!get('x-frame-options') || /frame-ancestors/i.test(csp ?? cspRo ?? ''),
    permissionsPolicy: !!get('permissions-policy'),
  }
}

// ---------------------------------------------------------------- fetching

async function fetchOnce(fetchImpl, url, timeoutMs) {
  const hops = []
  let current = url
  const t0 = Date.now()
  for (let i = 0; i < 6; i++) {
    const res = await fetchImpl(current, { redirect: 'manual', headers: { 'user-agent': 'rabbitweb-audit/1.0 (+https://rabbitsoftware.io)', accept: 'text/html,application/json;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      hops.push({ from: current, status: res.status })
      current = new URL(res.headers.get('location'), current).toString()
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    const type = res.headers.get('content-type') ?? ''
    const body = /html/i.test(type) ? (await res.text()).slice(0, 1_500_000) : (await res.body?.cancel().catch(() => undefined), '')
    return { status: res.status, finalUrl: current, hops, type, headers: res.headers, body, ms: Date.now() - t0 }
  }
  return { status: 0, finalUrl: current, hops, type: '', headers: new Headers(), body: '', ms: Date.now() - t0, error: 'too many redirects' }
}

const inScope = (u) => SCOPE.some((o) => u === o || u.startsWith(o + '/'))
const crawlable = (u) => inScope(u) && !/\/api\//.test(u) && !/\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|pdf|zip|exe|msi|gz|tar|woff2?|txt|xml|md)(\?|$)/i.test(u)

/** Visits pages from the seeds, breadth first, inside the two sites. Returns {pages, checks}. */
export async function crawl({ seeds = SEEDS, fetchImpl = fetch, maxPages = 60, concurrency = 4, timeoutMs = 15_000 } = {}) {
  const pages = new Map()                     // url -> page record (HTML pages)
  const queue = seeds.map((url) => ({ url, depth: 0, from: null }))
  const seen = new Set(seeds)
  const discoveredBy = new Map()
  const linkTargets = new Map()               // every internal link target -> pages linking to it
  while (queue.length && pages.size < maxPages) {
    const batch = queue.splice(0, Math.min(concurrency, maxPages - pages.size))   // never start more pages than the limit allows
    await Promise.all(batch.map(async ({ url, depth, from }) => {
      let r
      try { r = await fetchOnce(fetchImpl, url, timeoutMs) } catch (error) { pages.set(url, { url, depth, from, status: 0, error: error instanceof Error ? error.name : 'error', ms: timeoutMs, finalUrl: url, hops: [], isHtml: false }); return }
      const isHtml = /html/i.test(r.type) && r.status === 200
      const page = { url, depth, from, status: r.status, finalUrl: r.finalUrl, hops: r.hops, ms: r.ms, type: r.type, isHtml, security: securityHeaders(r.headers),
        encoding: r.headers.get('content-encoding') ?? '', cache: r.headers.get('cache-control') ?? '', server: r.headers.get('server') ?? '' }
      if (isHtml) Object.assign(page, parsePage(r.body, r.finalUrl))
      pages.set(url, page)
      for (const link of page.links ?? []) {
        if (!inScope(link)) continue
        if (!linkTargets.has(link)) linkTargets.set(link, new Set())
        linkTargets.get(link).add(url)
        if (!seen.has(link) && crawlable(link) && seen.size < maxPages * 3) { seen.add(link); discoveredBy.set(link, url); queue.push({ url: link, depth: depth + 1, from: url }) }
      }
    }))
  }
  return { pages: [...pages.values()], linkTargets: Object.fromEntries([...linkTargets].map(([k, v]) => [k, [...v]])) }
}

/** Things that are not pages: robots, sitemaps, the 404 behaviour, and internal API/file links that pages point at. */
export async function siteChecks({ crawlResult, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const out = { origins: {}, brokenLinks: [] }
  for (const origin of SCOPE) {
    const o = { robots: null, sitemap: null, sitemapUrls: [], sitemapDead: [], bogus: null }
    for (const [key, path] of [['robots', '/robots.txt'], ['sitemap', '/sitemap.xml']]) {
      try { const r = await fetchOnce(fetchImpl, origin + path, timeoutMs); o[key] = r.status; if (key === 'sitemap' && r.status === 200) { const t = await (await fetchImpl(origin + path)).text(); o.sitemapUrls = [...t.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]).slice(0, 60) } } catch { o[key] = 0 }
    }
    for (const u of o.sitemapUrls.slice(0, 40)) { try { const r = await fetchOnce(fetchImpl, u, timeoutMs); if (r.status >= 400 || r.status === 0) o.sitemapDead.push({ url: u, status: r.status }) } catch { o.sitemapDead.push({ url: u, status: 0 }) } }
    try { const r = await fetchOnce(fetchImpl, `${origin}/__audit-404-check-${Date.now().toString(36)}`, timeoutMs); o.bogus = { status: r.status, bytes: r.body.length } } catch { o.bogus = { status: 0, bytes: 0 } }
    out.origins[origin] = o
  }
  // Internal links the crawl did not visit as pages (API endpoints, files): check that they answer.
  const visited = new Set(crawlResult.pages.flatMap((p) => [p.url, p.finalUrl]))
  const extra = Object.keys(crawlResult.linkTargets).filter((u) => !visited.has(u)).slice(0, 40)
  await Promise.all(extra.map(async (u) => { try { const r = await fetchOnce(fetchImpl, u, timeoutMs); if (r.status >= 400 || r.status === 0) out.brokenLinks.push({ url: u, status: r.status, from: crawlResult.linkTargets[u] }) } catch { out.brokenLinks.push({ url: u, status: 0, from: crawlResult.linkTargets[u] }) } }))
  for (const p of crawlResult.pages) if (p.status >= 400 || p.status === 0) out.brokenLinks.push({ url: p.url, status: p.status, from: crawlResult.linkTargets[p.url] ?? (p.from ? [p.from] : []) })
  return out
}

// ---------------------------------------------------------------- findings

const F = (id, severity, title, why, fix) => ({ id, severity, title, why, fix, pages: [] })
const RULES = [
  [(p) => !p.title, F('missing-title', 'high', 'Pages without a title', 'The title is the headline in search results and the browser tab.', 'Give every page a unique, descriptive <title> of 10 to 65 characters.')],
  [(p) => p.title && p.title.length > 65, F('long-title', 'low', 'Titles that search results will cut off', 'Titles over about 65 characters are truncated.', 'Shorten the title and put the name first.')],
  [(p) => p.title && p.title.length < 10, F('short-title', 'low', 'Very short titles', 'A one-word title says little in search results and tabs.', 'Use a short noun phrase that names the page.')],
  [(p) => p.description === null || p.description === '', F('missing-description', 'medium', 'Pages without a meta description', 'Search results and link previews use it as the summary.', 'Add <meta name="description"> of 50 to 160 characters.')],
  [(p) => p.h1 === 0, F('missing-h1', 'medium', 'Pages without a main heading', 'Screen readers and search engines use the h1 to find the topic.', 'Add one <h1> that names the page.')],
  [(p) => p.h1 > 1, F('multiple-h1', 'low', 'Pages with more than one main heading', 'Several h1 elements blur the topic of the page.', 'Keep one h1 and use h2/h3 for the rest.')],
  [(p) => !p.lang, F('missing-lang', 'medium', 'Pages that do not declare a language', 'Screen readers pick the voice from it; browsers use it for translation.', 'Add lang="en" (or the right code) to <html>.')],
  [(p) => !p.viewport, F('missing-viewport', 'high', 'Pages without a mobile viewport', 'Without it phones show a shrunken desktop page.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.')],
  [(p) => p.imagesNoAlt > 0, F('images-no-alt', 'medium', 'Images without alt text', 'Screen readers skip or read the file name; search engines learn nothing.', 'Add alt text, or alt="" for purely decorative images.')],
  [(p) => p.emptyLinks > 0, F('empty-links', 'low', 'Links with no readable text', 'A screen reader announces just "link".', 'Add visible text, an aria-label, or an image with alt text.')],
  [(p) => !p.canonical, F('missing-canonical', 'low', 'Pages without a canonical address', 'Duplicates (with or without parameters) can split search ranking.', 'Add <link rel="canonical"> with the preferred address.')],
  [(p) => !(p.og?.title && p.og?.description && p.og?.image), F('missing-social-preview', 'low', 'Pages without a complete link preview', 'Shared links show a bare URL instead of a title, summary and image.', 'Add og:title, og:description and og:image.')],
  [(p) => p.insecure?.length > 0, F('mixed-content', 'high', 'Secure pages that load insecure resources', 'Browsers block or warn about http:// resources on https pages.', 'Change those resource addresses to https://.')],
  [(p) => p.ms > 3000, F('very-slow', 'high', 'Very slow pages (over 3 seconds)', 'Visitors leave; search engines rank slow pages lower.', 'Check server work, caching and page weight for these pages.')],
  [(p) => p.ms > 1500 && p.ms <= 3000, F('slow', 'medium', 'Slow pages (1.5 to 3 seconds)', 'Noticeable delay before the page appears.', 'Cache what you can at the edge; trim server-side work.')],
  [(p) => p.bytes > 400_000, F('heavy-html', 'medium', 'Very large HTML (over 400 KB)', 'Big documents are slow on phones and slow connections.', 'Move repeated data out of the page; load detail on demand.')],
  [(p) => p.bytes > 20_000 && !p.encoding, F('no-compression', 'medium', 'Text sent uncompressed', 'Compression typically cuts HTML size by 70 percent or more.', 'Turn on gzip or brotli for HTML at the edge.')],
  [(p) => p.scriptsExternal > 25, F('many-scripts', 'low', 'Pages loading many separate scripts (over 25)', 'Each script is another request and another thing that can fail.', 'Bundle or defer scripts that are not needed right away.')],
  [(p) => p.hops?.length > 1, F('redirect-chain', 'low', 'Redirect chains (more than one hop)', 'Every hop adds a round trip.', 'Link directly to the final address.')],
  [(p) => p.words !== undefined && p.words < 40, F('thin-page', 'low', 'Pages with very little text', 'Little for a visitor or a search engine to work with.', 'Add a short description of what the page is for, or mark it as an app screen.')],
]
const SECURITY_RULES = [
  [(s) => !s.hsts, F('no-hsts', 'medium', 'No HTTPS-only header (HSTS)', 'Browsers may first try plain http and be redirected, which can be intercepted.', 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains.')],
  [(s) => s.csp === 'none', F('no-csp', 'high', 'No Content Security Policy', 'A CSP limits what a compromised or injected script can do.', 'Add a Content-Security-Policy header; start in report-only, then enforce.')],
  [(s) => s.csp === 'report-only', F('csp-report-only', 'medium', 'Content Security Policy is report-only, not enforced', 'The policy is written but blocks nothing.', 'Review the reports, then switch the header to Content-Security-Policy.')],
  [(s) => !s.contentTypeOptions, F('no-nosniff', 'low', 'No X-Content-Type-Options: nosniff', 'Browsers may guess a file type and run something unexpected.', 'Send X-Content-Type-Options: nosniff.')],
  [(s) => !s.referrerPolicy, F('no-referrer-policy', 'low', 'No Referrer-Policy', 'Full addresses may leak to other sites in the Referer header.', 'Send Referrer-Policy: strict-origin-when-cross-origin.')],
  [(s) => !s.frameProtection, F('no-frame-protection', 'medium', 'Pages can be framed by other sites', 'Allows clickjacking.', 'Send X-Frame-Options: DENY or CSP frame-ancestors.')],
  [(s) => !s.permissionsPolicy, F('no-permissions-policy', 'low', 'No Permissions-Policy', 'Pages keep access to camera, microphone and location features they do not use.', 'Send a Permissions-Policy that turns off unused features.')],
]

/** Findings grouped by rule, each listing the pages it affects. */
export function analyze(crawlResult, checks) {
  const html = crawlResult.pages.filter((p) => p.isHtml)
  const found = new Map()
  const add = (f, where, detail) => { if (!found.has(f.id)) found.set(f.id, { ...f, pages: [], details: [] }); const g = found.get(f.id); if (!g.pages.includes(where)) g.pages.push(where); if (detail) g.details.push(detail) }
  for (const p of html) for (const [test, f] of RULES) { try { if (test(p)) add(f, p.url) } catch { /* a rule never breaks the audit */ } }
  const byOrigin = new Map()
  for (const p of html) { const o = new URL(p.finalUrl).origin; if (!byOrigin.has(o)) byOrigin.set(o, p) }
  for (const [origin, p] of byOrigin) for (const [test, f] of SECURITY_RULES) if (test(p.security)) add(f, origin, null)
  // duplicate titles
  const titles = new Map()
  for (const p of html) if (p.title) { if (!titles.has(p.title)) titles.set(p.title, []); titles.get(p.title).push(p.url) }
  for (const [title, urls] of titles) if (urls.length > 1) for (const u of urls) add(F('duplicate-title', 'medium', 'Several pages share one title', 'Search results and tabs cannot tell them apart.', 'Give each page its own title.'), u, title)
  // links, robots, sitemap, 404 behaviour
  for (const b of checks.brokenLinks) add(F('broken-link', 'high', 'Links and pages that return an error', 'Visitors and crawlers hit a dead end.', 'Fix the link, restore the page, or redirect it.'), b.url, `HTTP ${b.status}${b.from?.length ? ` (linked from ${b.from.slice(0, 2).join(', ')})` : ''}`)
  for (const [origin, o] of Object.entries(checks.origins)) {
    if (o.robots !== 200) add(F('no-robots', 'medium', 'No robots.txt', 'Crawlers have no instructions and no pointer to the sitemap.', 'Publish /robots.txt that names the sitemap.'), origin)
    if (o.sitemap !== 200) add(F('no-sitemap', 'medium', 'No sitemap.xml', 'Search engines find pages more slowly and less completely.', 'Publish /sitemap.xml listing the public pages.'), origin)
    for (const d of o.sitemapDead) add(F('sitemap-dead-url', 'medium', 'Sitemap lists addresses that fail', 'Search engines trust a sitemap less when it contains errors.', 'Remove or fix those entries.'), d.url, `HTTP ${d.status}`)
    if (o.bogus?.status === 200) add(F('soft-404', 'high', 'Unknown addresses answer 200 instead of 404', 'Search engines index empty pages; broken links go unnoticed.', 'Return status 404 for pages that do not exist.'), origin)
    else if (o.bogus && o.bogus.status === 404 && o.bogus.bytes < 200) add(F('bare-404', 'low', 'The 404 page has almost no content', 'A visitor who hits a dead end gets no way out.', 'Show a short message with links to the home page and search.'), origin)
  }
  const findings = [...found.values()].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || b.pages.length - a.pages.length)
  const count = (sev) => findings.filter((f) => f.severity === sev).length
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + DEDUCT[f.severity], 0))
  return { findings, counts: { high: count('high'), medium: count('medium'), low: count('low') }, score, pagesAudited: html.length, pagesTotal: crawlResult.pages.length }
}

/** Worst severity on each page, for coloring the site map. */
export function pageSeverity(findings) {
  const worst = new Map()
  for (const f of findings) for (const u of f.pages) { const cur = worst.get(u); if (!cur || SEVERITY.indexOf(f.severity) < SEVERITY.indexOf(cur)) worst.set(u, f.severity) }
  return worst
}
