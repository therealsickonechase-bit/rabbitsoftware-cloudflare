// Server-side Turnstile Siteverify. Fails closed: any missing piece, network error or odd answer denies.
import { LIMITS } from './limits.mjs'

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * @param {{token: unknown, secret: unknown, ip?: string, expectedHostnames?: string[]}} input
 * @param {typeof fetch} fetchImpl
 */
export async function verifyTurnstile({ token, secret, ip, expectedHostnames }, fetchImpl = fetch) {
  if (typeof secret !== 'string' || secret.length < 8) return { ok: false, reason: 'not_configured' }
  if (typeof token !== 'string' || token.length === 0 || new TextEncoder().encode(token).length > LIMITS.maxTurnstileTokenBytes) {
    return { ok: false, reason: 'missing_token' }
  }
  const body = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() })
  if (ip) body.set('remoteip', ip)
  let result
  try {
    const response = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(8000) })
    if (!response.ok) return { ok: false, reason: 'siteverify_http' }
    result = await response.json()
  } catch {
    return { ok: false, reason: 'siteverify_unreachable' }
  }
  if (result?.success !== true) return { ok: false, reason: 'rejected' }
  if (expectedHostnames?.length && !expectedHostnames.includes(result.hostname)) return { ok: false, reason: 'hostname' }
  return { ok: true }
}
