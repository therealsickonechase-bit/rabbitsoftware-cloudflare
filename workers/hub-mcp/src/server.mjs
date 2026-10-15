// Cloud Run entry for the hub MCP: POST /mcp (JSON-RPC), GET /healthz. Stateless; each request is checked on its own.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { ALLOWED_ORIGINS_FOR_BROWSERS, bearerFrom, checkKey, handleRpc } from './hub.mjs'

const PORT = Number(process.env.PORT) || 8080
const MAX_BODY = 32 * 1024
const VALID_FOR_MS = 60_000                    // a key that passed is trusted for a minute, so the app is not asked on every call
const seen = new Map()                         // sha256(key) -> expiresAt; the key itself is never stored
const RATE = { windowMs: 60_000, perKey: 60 }
const calls = new Map()                        // sha256(key) -> [timestamps]

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra })
  res.end(JSON.stringify(body))
}

function limited(hash) {
  const now = Date.now()
  const list = (calls.get(hash) ?? []).filter((t) => now - t < RATE.windowMs)
  list.push(now); calls.set(hash, list)
  if (calls.size > 500) for (const [k, v] of calls) if (!v.some((t) => now - t < RATE.windowMs)) calls.delete(k)
  return list.length > RATE.perKey
}

async function readBody(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return null; chunks.push(chunk) }
  return Buffer.concat(chunks).toString('utf8')
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok') }
    if (req.url !== '/mcp') return json(res, 404, { error: 'not found' })
    if (req.method === 'GET') return json(res, 405, { error: 'Use POST with a JSON-RPC body.' }, { Allow: 'POST' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' })
    const origin = req.headers.origin
    if (origin && !ALLOWED_ORIGINS_FOR_BROWSERS.includes(origin)) return json(res, 403, { error: 'origin not allowed' })   // DNS-rebinding guard

    const key = bearerFrom(req.headers.authorization)
    if (!key) return json(res, 401, { error: 'missing or malformed API key' }, { 'WWW-Authenticate': 'Bearer realm="rabbitos-hub"' })
    const hash = createHash('sha256').update(key).digest('hex')
    if ((seen.get(hash) ?? 0) < Date.now()) {
      const verdict = await checkKey(fetch, key)
      if (verdict === 'invalid') return json(res, 401, { error: 'invalid, expired or revoked API key' }, { 'WWW-Authenticate': 'Bearer realm="rabbitos-hub", error="invalid_token"' })
      if (verdict === 'rate') return json(res, 429, { error: 'rate limit' }, { 'Retry-After': '30' })
      if (verdict !== 'ok') return json(res, 503, { error: 'key check unavailable' })
      seen.set(hash, Date.now() + VALID_FOR_MS)
      if (seen.size > 500) for (const [k, v] of seen) if (v < Date.now()) seen.delete(k)
    }
    if (limited(hash)) return json(res, 429, { error: 'rate limit: 60 calls per minute' }, { 'Retry-After': '30' })

    const text = await readBody(req)
    if (text === null) return json(res, 413, { error: 'request too large' })
    let body
    try { body = JSON.parse(text) } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    if (Array.isArray(body)) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported' } })
    const out = await handleRpc(body, { fetchImpl: fetch, now: () => Date.now() })
    if (out === null) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end() }
    return json(res, 200, out)
  } catch (error) {
    console.log(JSON.stringify({ event: 'error', reason: error instanceof Error ? error.name : 'error' }))
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
  }
})
server.listen(PORT, () => console.log(JSON.stringify({ event: 'listening', port: PORT })))
