// Failover for the public static site. Tries the primary (Cloudflare Pages); if it cannot answer, serves the same path from the standby (GCP Cloud Run).
// Pure functions: the Worker passes in fetch, so tests need no network. Only GET and HEAD are ever forwarded; anything else is refused.

const FORWARD_HEADERS = ['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'user-agent']

/** Same path and query on another origin. The origin must be an https URL; the request's own host is never reused. */
export function targetUrl(origin, requestUrl) {
  const base = new URL(origin)
  if (base.protocol !== 'https:') throw new Error('origin must be https')
  const incoming = new URL(requestUrl)
  // Build the string on the origin, never resolve it: a path like //evil.example/x would otherwise be read as another host.
  const target = new URL(base.origin + incoming.pathname + incoming.search)
  if (target.origin !== base.origin) throw new Error('target left the origin')
  return target.toString()
}

/** Only a few plain headers go upstream: no cookies, no Cloudflare or forwarding headers, no Host. */
export function forwardHeaders(headers) {
  const out = new Headers()
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name)
    if (value) out.set(name, value)
  }
  return out
}

/** A server error or a gateway failure means "try the standby". A 404 or other client error is a real answer and is returned as is. */
export const shouldFailOver = (status) => status >= 500

async function attempt(fetchImpl, origin, request, timeoutMs) {
  const response = await fetchImpl(targetUrl(origin, request.url), {
    method: request.method,
    headers: forwardHeaders(request.headers),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  return response
}

/** Redirects from an upstream name that upstream by its own host; send the visitor back to the public host instead. */
function publicLocation(location, upstreamOrigin, publicOrigin) {
  try {
    const url = new URL(location, upstreamOrigin)
    return url.origin === new URL(upstreamOrigin).origin ? publicOrigin + url.pathname + url.search + url.hash : location
  } catch {
    return location
  }
}

function tag(response, servedBy, upstreamOrigin, publicOrigin) {
  const out = new Response(response.body, response)
  out.headers.set('X-Served-By', servedBy)
  if (response.status >= 500) out.headers.set('Cache-Control', 'no-store')   // never let an error page be cached
  const location = response.headers.get('Location')
  if (location) out.headers.set('Location', publicLocation(location, upstreamOrigin, publicOrigin))
  return out
}

/**
 * @param {Request} request
 * @param {{primary: string, standby: string, fetchImpl: typeof fetch, timeoutMs?: number}} options
 */
export async function serve(request, { primary, standby, fetchImpl, timeoutMs = 5000 }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  const publicOrigin = new URL(request.url).origin
  let primaryResponse = null
  try {
    primaryResponse = await attempt(fetchImpl, primary, request, timeoutMs)
    if (!shouldFailOver(primaryResponse.status)) return tag(primaryResponse, 'pages', primary, publicOrigin)
  } catch {
    // network error or timeout: fall through to the standby
  }
  try {
    const standbyResponse = await attempt(fetchImpl, standby, request, timeoutMs)
    if (!shouldFailOver(standbyResponse.status)) {
      await primaryResponse?.body?.cancel().catch(() => undefined)   // do not leave the failed response open
      return tag(standbyResponse, 'gcp-standby', standby, publicOrigin)
    }
    await standbyResponse.body?.cancel().catch(() => undefined)
  } catch {
    // standby also failed
  }
  // Both failed. Show the primary's own error page if it gave one, otherwise a plain 503.
  if (primaryResponse) return tag(primaryResponse, 'pages-error', primary, publicOrigin)
  return new Response('The site is temporarily unavailable.', { status: 503, headers: { 'Retry-After': '60', 'X-Served-By': 'failover-none' } })
}
