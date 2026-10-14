// Session and command accounting as pure functions over a plain JSON state. The Gate Durable Object loads the state, calls one
// of these, and stores it again. No raw IP is kept: callers pass an opaque `ipKey` (an HMAC of the address).
import { LIMITS } from './limits.mjs'

export const emptyState = () => ({ sessions: {}, ips: {} })

const day = (now) => new Date(now).toISOString().slice(0, 10)

function ipRecord(state, ipKey, now) {
  const today = day(now)
  const record = state.ips[ipKey]
  if (!record || record.day !== today) state.ips[ipKey] = { day: today, commands: 0, sessions: 0 }
  return state.ips[ipKey]
}

/** Drop address records from earlier days so the state stays small. */
export function pruneIps(state, now) {
  const today = day(now)
  for (const [key, record] of Object.entries(state.ips)) if (record.day !== today) delete state.ips[key]
}

export function liveSessions(state) {
  return Object.keys(state.sessions).length
}

function sessionsForIp(state, ipKey) {
  return Object.values(state.sessions).filter((s) => s.ipKey === ipKey).length
}

/** Try to create a session. Mutates `state` only when it returns ok. */
export function admit(state, { now, ipKey, sid }, limits = LIMITS) {
  pruneIps(state, now)
  if (state.sessions[sid]) return { ok: false, reason: 'duplicate' }
  if (liveSessions(state) >= limits.maxGlobalSessions) return { ok: false, reason: 'global_cap' }
  if (sessionsForIp(state, ipKey) >= limits.maxSessionsPerIp) return { ok: false, reason: 'ip_cap' }
  const record = ipRecord(state, ipKey, now)
  if (record.sessions >= limits.maxSessionsPerIpPerDay) return { ok: false, reason: 'daily_sessions' }
  record.sessions += 1
  state.sessions[sid] = { ipKey, createdAt: now, lastSeen: now, attached: false }
  return { ok: true, expiresAt: now + limits.maxLifetimeMs }
}

/** Why a session is over, or null while it is alive. */
export function expiryReason(session, now, limits = LIMITS) {
  if (now - session.createdAt >= limits.maxLifetimeMs) return 'max_lifetime'
  if (now - session.lastSeen >= limits.idleMs) return 'idle'
  return null
}

export function expired(state, now, limits = LIMITS) {
  const out = []
  for (const [sid, session] of Object.entries(state.sessions)) {
    const reason = expiryReason(session, now, limits)
    if (reason) out.push({ sid, reason })
  }
  return out
}

/** Record activity. Returns false when the session is unknown or already over. */
export function touch(state, sid, now, limits = LIMITS) {
  const session = state.sessions[sid]
  if (!session || expiryReason(session, now, limits)) return false
  session.lastSeen = now
  return true
}

/** One live terminal connection per session. */
export function attach(state, sid, now, limits = LIMITS) {
  const session = state.sessions[sid]
  if (!session) return { ok: false, reason: 'unknown' }
  const reason = expiryReason(session, now, limits)
  if (reason) return { ok: false, reason }
  if (session.attached) return { ok: false, reason: 'already_attached' }
  session.attached = true
  session.lastSeen = now
  return { ok: true, expiresAt: session.createdAt + limits.maxLifetimeMs }
}

export function detach(state, sid) {
  if (state.sessions[sid]) state.sessions[sid].attached = false
}

/** Count `n` command lines against the address's daily quota. Over quota: nothing is counted. */
export function consumeCommands(state, sid, n, now, limits = LIMITS) {
  const session = state.sessions[sid]
  if (!session) return { ok: false, reason: 'unknown', remaining: 0 }
  if (expiryReason(session, now, limits)) return { ok: false, reason: 'expired', remaining: 0 }
  const record = ipRecord(state, session.ipKey, now)
  const remaining = limits.maxCommandsPerIpPerDay - record.commands
  if (n > remaining) return { ok: false, reason: 'daily_commands', remaining: Math.max(0, remaining) }
  record.commands += n
  session.lastSeen = now
  return { ok: true, remaining: remaining - n }
}

export function release(state, sid) {
  delete state.sessions[sid]
}

/** When the Gate should wake next to expire sessions, or null with none live. */
export function nextAlarm(state, now, limits = LIMITS) {
  let at = null
  for (const s of Object.values(state.sessions)) {
    const due = Math.min(s.createdAt + limits.maxLifetimeMs, s.lastSeen + limits.idleMs)
    if (at === null || due < at) at = due
  }
  return at === null ? null : Math.max(at, now + 1000)
}
