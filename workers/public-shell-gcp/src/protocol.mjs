// Wire format between the Cloudflare gate Worker and the Cloud Run terminal server. Pure functions; no I/O, so tests need no network.
// The Worker signs a short-lived token for one session id; this server only runs a terminal for a valid token, once, and then exits.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const PTY_PROTOCOL = 'rabbit-pty.v1'
export const SIZE = Object.freeze({ minCols: 20, maxCols: 300, minRows: 5, maxRows: 120 })
export const MAX_FRAME_BYTES = 16 * 1024
export const MAX_START_BYTES = 8 * 1024

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** Token = v1.<sid>.<expiresAtMs>.<hmac>. The secret is shared with the Worker (PTY_BRIDGE_SECRET) and is at least 32 characters. */
export function signBridgeToken(secret, sid, expiresAtMs) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('secret too short')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) throw new Error('bad session id')
  const body = `v1.${sid}.${Math.floor(expiresAtMs)}`
  return `${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`
}

/** @returns {{sid: string, expiresAt: number} | null} */
export function verifyBridgeToken(secret, token, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof token !== 'string' || token.length > 256) return null
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  const [, sid, exp, mac] = parts
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid) || !/^\d{10,16}$/.test(exp)) return null
  const expected = createHmac('sha256', secret).update(`v1.${sid}.${exp}`).digest()
  let given
  try { given = Buffer.from(mac, 'base64url') } catch { return null }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const expiresAt = Number(exp)
  if (!(expiresAt > now)) return null
  return { sid, expiresAt }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)))
export const clampSize = (cols, rows) => ({ cols: clamp(cols, SIZE.minCols, SIZE.maxCols), rows: clamp(rows, SIZE.minRows, SIZE.maxRows) })

/** First frame from the Worker: {t:'start', cols, rows, keys?}. `keys` is validated later by env.mjs. */
export function parseStartFrame(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_START_BYTES) return { ok: false, error: 'start frame too large' }
  let frame
  try { frame = JSON.parse(text) } catch { return { ok: false, error: 'bad json' } }
  if (!frame || typeof frame !== 'object' || frame.t !== 'start') return { ok: false, error: 'expected start' }
  return { ok: true, ...clampSize(Number(frame.cols), Number(frame.rows)), keys: frame.keys }
}

/** Later frames: {t:'i', d} input, {t:'r', cols, rows} resize. Anything else closes the session. */
export function parseClientFrame(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FRAME_BYTES) return { ok: false, error: 'frame too large' }
  let frame
  try { frame = JSON.parse(text) } catch { return { ok: false, error: 'bad json' } }
  if (!frame || typeof frame !== 'object') return { ok: false, error: 'bad frame' }
  if (frame.t === 'i') return typeof frame.d === 'string' ? { ok: true, t: 'i', d: frame.d } : { ok: false, error: 'bad input' }
  if (frame.t === 'r') return { ok: true, t: 'r', ...clampSize(Number(frame.cols), Number(frame.rows)) }
  return { ok: false, error: 'unknown frame' }
}

/** The subprotocol offer is [PTY_PROTOCOL, token]; returns the token or null. */
export function tokenFromProtocols(header) {
  const offered = String(header ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!offered.includes(PTY_PROTOCOL)) return null
  return offered.find((p) => p !== PTY_PROTOCOL) ?? null
}
