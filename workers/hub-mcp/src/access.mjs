// Who may call the hub and how often. Two tiers:
//   public  no key: the read-only tools, 20 calls per minute per client address
//   key     a hub key (hub_...) minted by New-HubKey.ps1, or an existing RabbitOS key (rbk_...): 120 calls per minute per key, and the only way to
//           reach any future tool that needs approval
// Pure functions: the server passes in the clock and the request details.
import { createHash, timingSafeEqual } from 'node:crypto'

export const RATE = Object.freeze({ windowMs: 60_000, publicPerIp: 20, keyPerKey: 120 })
export const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const HUB = /^Bearer (hub_[A-Za-z0-9_-]{32,64})$/
const RBK = /^Bearer (rbk_[A-Za-z0-9_-]{20,64})$/

/** @returns {{kind: 'none'} | {kind: 'hub' | 'rbk', key: string} | {kind: 'bad'}} */
export function classify(header) {
  if (header === undefined || header === null || header === '') return { kind: 'none' }
  const hub = HUB.exec(header); if (hub) return { kind: 'hub', key: hub[1] }
  const rbk = RBK.exec(header); if (rbk) return { kind: 'rbk', key: rbk[1] }
  return { kind: 'bad' }                      // something was sent but it is not a key we know the shape of: refuse, never treat as anonymous
}

/** HUB_KEY_HASHES = "name:sha256hex,name2:sha256hex". Malformed entries are skipped. Returns Map(hash -> name). */
export function parseKeyHashes(raw) {
  const out = new Map()
  for (const part of String(raw ?? '').split(',')) {
    const m = /^([a-z0-9-]{1,32}):([0-9a-f]{64})$/.exec(part.trim())
    if (m) out.set(m[2], m[1])
  }
  return out
}

/** Name of the hub key, or null. Compares every stored hash in constant time. */
export function hubKeyName(hashes, key) {
  const given = Buffer.from(sha256(key), 'hex')
  let found = null
  for (const [hash, name] of hashes) if (timingSafeEqual(given, Buffer.from(hash, 'hex'))) found = name
  return found
}

/**
 * The caller's address as Cloud Run reports it: the LAST entry of X-Forwarded-For is added by Google's front end, earlier entries are whatever the
 * client claimed and can be forged. Falls back to the socket address.
 */
export function clientIp(forwardedFor, socketAddress) {
  const last = String(forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop()
  return last && /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last : String(socketAddress ?? 'unknown')
}

/** Sliding one-minute window per id. hit() records a call and says whether the caller is now over `limit`. */
export function makeLimiter(now = Date.now) {
  const calls = new Map()
  return {
    hit(id, limit) {
      const t = now()
      const list = (calls.get(id) ?? []).filter((x) => t - x < RATE.windowMs)
      list.push(t); calls.set(id, list)
      if (calls.size > 2000) for (const [k, v] of calls) if (!v.some((x) => t - x < RATE.windowMs)) calls.delete(k)
      return list.length > limit
    },
    size: () => calls.size,
  }
}
