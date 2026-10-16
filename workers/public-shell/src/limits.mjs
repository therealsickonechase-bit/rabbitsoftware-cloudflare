// Fixed limits for the public sandbox. Pure data: tests read these, the Worker enforces them.
// The operator can only tighten them with the optional numeric vars handled in `limitsFrom` (never loosen past HARD).

export const LIMITS = Object.freeze({
  idleMs: 15 * 60_000,              // no typing AND no terminal output for this long: session ends and its container is destroyed (a running build or agent is not idle)
  maxLifetimeMs: 60 * 60_000,       // hard maximum from creation, regardless of activity (the Cloud Run request limit is also 60 minutes)
  tokenTtlMs: 60 * 60_000,          // signed session token lifetime (never longer than maxLifetimeMs)
  commandTimeoutMs: 60_000,         // applies to non-interactive helper runs; see README (a PTY has no per-command timeout)
  maxGlobalSessions: 6,             // concurrent live sessions across all visitors
  maxSessionsPerIp: 1,              // concurrent live sessions per visitor address
  maxSessionsPerIpPerDay: 6,        // sessions an address may create per UTC day
  maxCommandsPerIpPerDay: 400,      // Enter presses (command lines) per address per UTC day
  maxOutputBytes: 32 * 1024 * 1024, // terminal output per session before it is cut off (coding agents redraw a lot; 8 MiB ended real work)
  maxFrameBytes: 16 * 1024,         // one WebSocket frame from the browser
  maxInputBytesPerSecond: 64 * 1024,
  maxHelloBytes: 8 * 1024,          // the first frame (carries optional API keys)
  helloTimeoutMs: 10_000,
  attachGraceMs: 90_000,            // a session nobody connected to within this long is released, so an abandoned page cannot hold the address's only slot for 10 minutes
  minCols: 20, maxCols: 300, minRows: 5, maxRows: 120,
  maxTurnstileTokenBytes: 2048,
  maxSessionBodyBytes: 4096,
})

export const WS_PROTOCOL = 'rabbit-shell.v1'

/** Operator overrides may only lower a limit. Unknown, non-numeric or larger values are ignored. */
export function limitsFrom(overrides = {}) {
  const out = { ...LIMITS }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in LIMITS)) continue
    const n = Number(value)
    if (Number.isFinite(n) && n > 0 && n <= LIMITS[key]) out[key] = Math.floor(n)
  }
  return Object.freeze(out)
}

/** Kill switch: ONLY the exact string "true" enables the service. Missing, "false", or anything else is off (fails closed). */
export function shellEnabled(env) {
  return env?.PUBLIC_SHELL_ENABLED === 'true'
}

/** Comma-separated exact origins that may call the Worker from a browser. */
export function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS ?? 'https://app.rabbitsoftware.io').split(',').map((s) => s.trim()).filter(Boolean)
}

export function originAllowed(origin, env) {
  return typeof origin === 'string' && allowedOrigins(env).includes(origin)
}
