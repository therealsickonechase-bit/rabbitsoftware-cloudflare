// Warnings the guest terminal prints BEFORE a session ends, so a limit never arrives as a surprise. Pure: the Worker calls dueWarning() on a timer and writes what it returns.
// Two kinds: the hard time limit (5 minutes and 1 minute before it) and idleness (2 minutes before the idle limit). "Activity" is typing OR the shell printing something,
// so a build or a coding agent that is working is not idle; only a quiet, untouched terminal is.

export const WARNING_TIMES = Object.freeze({ lifetimeMs: Object.freeze([5 * 60_000, 60_000]), idleBeforeMs: 2 * 60_000 })

const minutes = (ms) => { const m = Math.max(1, Math.round(ms / 60_000)); return `${m} minute${m === 1 ? '' : 's'}` }

/**
 * @param {{ now: number, expiresAt: number, lastActive: number, idleMs: number, sent: Set<string> }} state
 * @returns {{ key: string, message: string } | null} the next warning that is due and has not been sent, or null
 */
export function dueWarning({ now, expiresAt, lastActive, idleMs, sent }) {
  const left = expiresAt - now
  if (left > 0) {
    for (const ms of WARNING_TIMES.lifetimeMs) {
      const key = `life:${ms}`
      if (left <= ms && !sent.has(key)) {
        return { key, message: `This session reaches its time limit in ${minutes(left)}. Save what you need now: files in the sandbox are deleted when it ends. You can open a new session afterwards.` }
      }
    }
  }
  const idleLeft = idleMs - (now - lastActive)
  if (idleLeft > 0 && idleLeft <= WARNING_TIMES.idleBeforeMs && !sent.has('idle')) {
    return { key: 'idle', message: `Nothing typed and nothing printed for a while: the session ends in about ${minutes(idleLeft)} unless you press a key or the shell prints something.` }
  }
  return null
}

/** Call when there is activity again: the idle warning may be shown again next time. */
export function noteActivity(sent) {
  sent.delete('idle')
}
