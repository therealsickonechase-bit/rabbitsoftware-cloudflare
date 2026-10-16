// Cloud Run entry for the hub MCP: POST /mcp (JSON-RPC), GET /health. Stateless; each request is checked on its own.
// Two tiers (see access.mjs): anonymous callers get the public read-only tools at a low rate; a hub key (or an existing RabbitOS key) gets more.
import http from 'node:http'
import { ALLOWED_ORIGINS_FOR_BROWSERS, checkKey, handleRpc } from './hub.mjs'
import { RATE, classify, clientIp, hubKeyName, makeLimiter, parseKeyHashes, sha256 } from './access.mjs'
import { makeCatalog } from './catalog.mjs'
import { readFileSync } from 'node:fs'

// The command catalog is exported from rabbit-web (scripts/export-command-catalog.mjs) and baked into the image. If it is missing, the command tools say so.
let catalog = null
let toolbox = null
try { toolbox = JSON.parse(readFileSync(new URL('../data/toolbox.json', import.meta.url), 'utf8')) } catch { console.log(JSON.stringify({ event: 'toolbox_missing' })) }
try { catalog = makeCatalog(JSON.parse(readFileSync(new URL('../data/commands.json', import.meta.url), 'utf8')), toolbox) } catch { console.log(JSON.stringify({ event: 'catalog_missing' })) }

const PORT = Number(process.env.PORT) || 8080
const MAX_BODY = 32 * 1024
const HASHES = parseKeyHashes(process.env.HUB_KEY_HASHES)   // "name:sha256hex,..." set by New-HubKey.ps1; the keys themselves are never stored
const VALID_FOR_MS = 60_000                                 // an rbk_ key that the app accepted is trusted for a minute
const rbkSeen = new Map()                                   // sha256(key) -> expiresAt
const limiter = makeLimiter()

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra })
  res.end(JSON.stringify(body))
}
const tooMany = (res) => json(res, 429, { error: 'rate limit' }, { 'Retry-After': '30' })

async function readBody(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return null; chunks.push(chunk) }
  return Buffer.concat(chunks).toString('utf8')
}

/** @returns {Promise<{tier: 'public' | 'key', id: string} | {status: number, body: object, headers?: object}>} */
async function authenticate(req) {
  const who = classify(req.headers.authorization)
  if (who.kind === 'none') return { tier: 'public', id: `ip:${clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress)}` }
  if (who.kind === 'bad') return { status: 401, body: { error: 'malformed API key' }, headers: { 'WWW-Authenticate': 'Bearer realm="rabbitos-hub"' } }
  if (who.kind === 'hub') {
    const name = hubKeyName(HASHES, who.key)
    return name ? { tier: 'key', id: `key:${name}` } : { status: 401, body: { error: 'invalid or revoked API key' }, headers: { 'WWW-Authenticate': 'Bearer realm="rabbitos-hub", error="invalid_token"' } }
  }
  const hash = sha256(who.key)                               // an existing RabbitOS key: ask the app, and remember the answer briefly
  if ((rbkSeen.get(hash) ?? 0) < Date.now()) {
    const verdict = await checkKey(fetch, who.key)
    if (verdict === 'invalid') return { status: 401, body: { error: 'invalid, expired or revoked API key' }, headers: { 'WWW-Authenticate': 'Bearer realm="rabbitos-hub", error="invalid_token"' } }
    if (verdict === 'rate') return { status: 429, body: { error: 'rate limit' }, headers: { 'Retry-After': '30' } }
    if (verdict !== 'ok') return { status: 503, body: { error: 'key check unavailable' } }
    rbkSeen.set(hash, Date.now() + VALID_FOR_MS)
    if (rbkSeen.size > 500) for (const [k, v] of rbkSeen) if (v < Date.now()) rbkSeen.delete(k)
  }
  return { tier: 'key', id: `key:${hash.slice(0, 12)}` }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok') }
    if (req.url !== '/mcp') return json(res, 404, { error: 'not found' })
    if (req.method === 'GET') return json(res, 405, { error: 'Use POST with a JSON-RPC body.' }, { Allow: 'POST' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' })
    const origin = req.headers.origin
    if (origin && !ALLOWED_ORIGINS_FOR_BROWSERS.includes(origin)) return json(res, 403, { error: 'origin not allowed' })   // DNS-rebinding guard

    const who = await authenticate(req)
    if ('status' in who) return json(res, who.status, who.body, who.headers)
    if (limiter.hit(who.id, who.tier === 'key' ? RATE.keyPerKey : RATE.publicPerIp)) return tooMany(res)

    const text = await readBody(req)
    if (text === null) return json(res, 413, { error: 'request too large' })
    let body
    try { body = JSON.parse(text) } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    if (Array.isArray(body)) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } })
    const out = await handleRpc(body, { fetchImpl: fetch, now: () => Date.now(), tier: who.tier, catalog })
    if (out === null) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end() }
    return json(res, 200, out)
  } catch (error) {
    console.log(JSON.stringify({ event: 'error', reason: error instanceof Error ? error.name : 'error' }))
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
  }
})
server.listen(PORT, () => console.log(JSON.stringify({ event: 'listening', port: PORT, hubKeys: HASHES.size })))
