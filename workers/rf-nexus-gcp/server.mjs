// RF Nexus static export preview for Cloud Run. Same rules as tools/rf-nexus-preview/index.mjs (the Cloudflare Worker), as a plain Node server.
// Serves only the three reviewed files from ./public. No backend: API, port and WebSocket requests answer 503, writes 405, everything else 404.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('./public/', import.meta.url))
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/index-drmRIFDg.js', ['assets/index-drmRIFDg.js', 'text/javascript; charset=utf-8']],
  ['/assets/index--vzZ5AZu.css', ['assets/index--vzZ5AZu.css', 'text/css; charset=utf-8']],
])
export const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
}
const BANNER = '<aside role="status" style="position:relative;z-index:2147483647;padding:16px;background:#fff3cd;color:#332701;font:16px sans-serif">RF Nexus static export preview only. Backend, sign-in, live data, wallet actions and recording are unavailable. Do not enter credentials or personal data. This is not the RabbitOS production console.</aside>'

export function prepareHtml(html) {
  return html.replace(/<script data-pplx-inline-edit>[\s\S]*?<\/script>/, '').replace(/<body([^>]*)>/, (m) => m + BANNER)
}

export async function handle(method, rawUrl, headers = {}, read = (f) => readFile(ROOT + f)) {
  const path = new URL(rawUrl, 'http://x').pathname
  const send = (status, body, extra = {}) => ({ status, body, headers: { ...HEADERS, ...extra } })
  if (path === '/health') return send(200, 'ok', { 'Content-Type': 'text/plain' })
  if (path.startsWith('/api/') || path.startsWith('/port/') || String(headers.upgrade || '').toLowerCase() === 'websocket') {
    return send(503, JSON.stringify({ error: 'Static RF Nexus preview only. The original backend is not available; no data or credentials are accepted.' }), { 'Content-Type': 'application/json' })
  }
  if (method !== 'GET' && method !== 'HEAD') return send(405, 'Read-only static preview.', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' })
  const entry = FILES.get(path)
  if (!entry) return send(404, 'Not included in the static export.', { 'Content-Type': 'text/plain' })
  const data = await read(entry[0])
  const body = entry[1].startsWith('text/html') ? prepareHtml(data.toString('utf8')) : data
  return send(200, body, { 'Content-Type': entry[1] })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer(async (req, res) => {
    try {
      const r = await handle(req.method, req.url, req.headers)
      res.writeHead(r.status, r.headers)
      res.end(req.method === 'HEAD' ? undefined : r.body)
    } catch { res.writeHead(500, HEADERS); res.end('error') }
  }).listen(Number(process.env.PORT) || 8080)
}
