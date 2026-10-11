// Checks that everything the site's pages load or connect to is allowed by the Content-Security-Policy in site/_headers.
//   npm run check:csp        (exit code 1 if something would be blocked, or a required directive is missing)
//
// Static check of what is IN the files: script/link/img/iframe/source/form tags, inline scripts and styles, inline event handlers, and
// https:// strings in JavaScript (treated as connections). Cloudflare adds a few things when it serves a page (email-protection scripts from
// the same origin, optionally the Web Analytics beacon); those hosts are listed in the policy and covered here by the 'self' and
// cloudflareinsights entries. A real-browser check of the published pages is still the final test (see DEVELOPMENT.md).
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// default: the site folder; pass another folder to check it (used to prove the checker fails on bad input)
const SITE = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + '/') : new URL('../site/', import.meta.url)
const headers = readFileSync(new URL('_headers', SITE), 'utf8')
const line = headers.split(/\r?\n/).find((l) => l.trim().startsWith('Content-Security-Policy:'))
if (!line) { console.error('FAIL no Content-Security-Policy in site/_headers'); process.exit(1) }
const policy = Object.fromEntries(line.trim().slice('Content-Security-Policy:'.length).split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v] }))

const problems = []
for (const need of ['default-src', 'script-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) if (!policy[need]) problems.push(`missing directive ${need}`)
if (policy['script-src']?.includes('*') || policy['script-src']?.includes('https:')) problems.push('script-src must not allow a wildcard or all https')
if (!policy['object-src']?.includes("'none'")) problems.push("object-src should be 'none'")
if (!policy['frame-ancestors']?.includes("'none'")) problems.push("frame-ancestors should be 'none'")

const sources = (directive) => policy[directive] ?? policy['default-src'] ?? []
function allowed(directive, url) {
  const list = sources(directive)
  if (url.startsWith('data:')) return list.includes('data:')
  if (!/^(https?:)?\/\//i.test(url)) return list.includes("'self'")                // a relative URL: same origin
  const u = new URL(url.startsWith('//') ? 'https:' + url : url)
  return list.some((s) => {
    if (s === 'https:') return u.protocol === 'https:'
    if (!s.includes('://')) return false
    const o = new URL(s.replace('*.', 'wildcard.'))
    if (s.includes('*.')) return u.protocol === o.protocol && u.hostname.endsWith('.' + o.hostname.replace('wildcard.', ''))
    return u.origin === o.origin
  })
}

const files = readdirSync(SITE).filter((f) => /\.(html|js|mjs)$/.test(f))
let checked = 0
for (const f of files) {
  const text = readFileSync(new URL(f, SITE), 'utf8')
  const note = (what) => problems.push(`${f}: ${what}`)
  if (f.endsWith('.html')) {
    for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /src="([^"]+)"/i.exec(m[1])?.[1]
      const type = /type="([^"]+)"/i.exec(m[1])?.[1] ?? ''
      checked++
      if (src) { if (!allowed('script-src', src)) note(`script ${src} is not allowed by script-src`) }
      else if (m[2].trim() && !/json|ld\+json/.test(type) && !sources('script-src').includes("'unsafe-inline'")) note('an inline <script> needs script-src \'unsafe-inline\' (or a hash)')
    }
    for (const m of text.matchAll(/<link\b([^>]*)>/gi)) {
      const rel = /rel="([^"]+)"/i.exec(m[1])?.[1] ?? ''; const href = /href="([^"]+)"/i.exec(m[1])?.[1]
      if (!href || /canonical|alternate|author|license/.test(rel)) continue
      checked++
      const dir = /stylesheet/.test(rel) ? 'style-src' : /icon/.test(rel) ? 'img-src' : /font|preload/.test(rel) ? 'font-src' : 'default-src'
      if (!allowed(dir, href)) note(`link ${href} is not allowed by ${dir}`)
    }
    for (const m of text.matchAll(/<(img|source|video|audio|iframe|embed|object)\b[^>]*?\b(?:src|data)="([^"]+)"/gi)) {
      checked++
      const dir = m[1] === 'iframe' ? 'frame-src' : m[1] === 'img' ? 'img-src' : m[1] === 'source' ? 'media-src' : m[1] === 'embed' || m[1] === 'object' ? 'object-src' : 'media-src'
      if (!allowed(dir, m[2])) note(`<${m[1]} src="${m[2].slice(0, 70)}"> is not allowed by ${dir}`)
    }
    for (const m of text.matchAll(/<form\b[^>]*\baction="([^"]+)"/gi)) { checked++; if (!allowed('form-action', m[1])) note(`form action ${m[1]} is not allowed by form-action`) }
    if (/<style\b/i.test(text) || /\sstyle="/i.test(text)) { if (!sources('style-src').includes("'unsafe-inline'")) note("inline styles need style-src 'unsafe-inline'") }
    if (/\son[a-z]+="/i.test(text) && !sources('script-src').includes("'unsafe-inline'")) note("inline event handlers need script-src 'unsafe-inline'")
  }
  // https:// strings in scripts (and in the inline scripts of pages) are connections
  const scripts = f.endsWith('.html') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n') : text
  for (const m of scripts.matchAll(/["'`](https?:\/\/[^"'`\s)]+)["'`]/g)) {
    const around = scripts.slice(Math.max(0, m.index - 80), m.index)
    if (!/(fetch\(|import\(|WebSocket\(|EventSource\(|sendBeacon\(|gateway\s*=|url\s*[:=]|endpoint\s*[:=])/i.test(around)) continue     // a link shown to the reader, not a connection
    checked++
    if (!allowed('connect-src', m[1])) note(`connects to ${m[1].slice(0, 80)} which connect-src does not allow`)
  }
}
if (problems.length) { console.error('FAIL\n- ' + problems.join('\n- ')); process.exit(1) }
console.log(`OK  ${checked} resources and connections in ${files.length} files are allowed by the site's Content-Security-Policy`)
