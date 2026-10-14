// Random session ids and HMAC-signed session tokens (WebCrypto only). The token carries no secret and no key material.
const enc = new TextEncoder()

const b64u = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64u = (text) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

/** 128 bits from the platform CSPRNG, lower-case hex (also a valid Sandbox id). */
export function newSessionId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const validSessionId = (sid) => typeof sid === 'string' && /^[0-9a-f]{32}$/.test(sid)

const hmacKey = (secret, usage) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage)

export const secretUsable = (secret) => typeof secret === 'string' && secret.length >= 32

/** token = base64url(JSON {sid, exp}) "." base64url(HMAC-SHA256) */
export async function signToken(secret, { sid, exp }) {
  if (!secretUsable(secret)) throw new Error('signing secret missing or too short')
  const body = b64u(enc.encode(JSON.stringify({ sid, exp })))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(body)))
  return `${body}.${b64u(sig)}`
}

/** Returns {sid, exp} or null. Constant-time signature check through subtle.verify. */
export async function verifyToken(secret, token, now = Date.now()) {
  if (!secretUsable(secret) || typeof token !== 'string' || token.length > 512) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), fromB64u(parts[1]), enc.encode(parts[0]))
    if (!ok) return null
    const payload = JSON.parse(new TextDecoder().decode(fromB64u(parts[0])))
    if (!validSessionId(payload.sid) || !Number.isFinite(payload.exp) || payload.exp <= now) return null
    return { sid: payload.sid, exp: payload.exp }
  } catch {
    return null
  }
}

/** Opaque per-address key so no raw IP is stored: HMAC(secret, ip) truncated to 128 bits. */
export async function ipKey(secret, ip) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(`ip:${ip}`)))
  return b64u(sig.slice(0, 16))
}
