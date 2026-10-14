// What the terminal process gets as environment. Built from scratch: the Worker's own env is NEVER spread into it.
// Visitor API keys are validated here, live only in the value returned for ONE terminal launch, and are never stored or logged.

/** Keys a visitor may supply. Each value is only an API key; base URLs and anything else are refused. */
export const KEY_NAMES = Object.freeze(['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'COPILOT_GITHUB_TOKEN'])

/** Names the Worker (or any operator tooling) could hold. Never forwarded, whatever the visitor sends. */
const PROTECTED = /(_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$|SERVICE_ROLE|SUPABASE|CLOUDFLARE|^CF_|^WRANGLER|^PUBLIC_SHELL_|^TURNSTILE|SIGNING_KEY|^RABBIT_|^AWS_|^R2_/i

// COPILOT_GITHUB_TOKEN is the one *_TOKEN name a visitor may supply: it is the visitor's own fine-grained PAT for the Copilot CLI,
// never an operator credential. GITHUB_TOKEN / GH_TOKEN and every other *_TOKEN stay refused.
export const isProtectedEnvName = (name) => !KEY_NAMES.includes(String(name)) && PROTECTED.test(String(name))

const KEY_VALUE = /^[\x21-\x7e]{8,512}$/

/** @returns {{ok: true, env: Record<string,string>} | {ok: false, error: string}} */
export function buildKeyEnv(keys) {
  if (keys === undefined || keys === null) return { ok: true, env: {} }
  if (typeof keys !== 'object' || Array.isArray(keys)) return { ok: false, error: 'keys must be an object' }
  const env = {}
  for (const [name, value] of Object.entries(keys)) {
    if (isProtectedEnvName(name) || !KEY_NAMES.includes(name)) return { ok: false, error: `key name not accepted: ${name.slice(0, 40)}` }
    if (value === '' || value === undefined) continue
    if (typeof value !== 'string' || !KEY_VALUE.test(value)) return { ok: false, error: `${name} is not a plausible API key` }
    env[name] = value
  }
  return { ok: true, env }
}

/** Fixed base environment. Takes no Worker env on purpose. */
export function baseEnv() {
  return {
    HOME: '/home/visitor', USER: 'visitor', LOGNAME: 'visitor', SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'xterm-256color',
    PATH: '/usr/local/bin:/usr/bin:/bin', WORKSPACE: '/workspace', RABBITOS_ORIGIN: 'https://app.rabbitsoftware.io',
    GEMINI_CLI_TRUST_WORKSPACE: 'true', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/** Final launch env: base plus validated keys; defence in depth strips anything protected. */
export function terminalEnv(keyEnv) {
  const out = { ...baseEnv() }
  for (const [name, value] of Object.entries(keyEnv)) if (!isProtectedEnvName(name) && KEY_NAMES.includes(name)) out[name] = value
  return out
}

const LOG_FIELDS = new Set(['event', 'sid', 'reason', 'code', 'bytes', 'limit'])

/** The only logging helper the bridge uses: allowlisted scalar fields, session id shortened, strings capped. Frames and env never reach it. */
export function logLine(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!LOG_FIELDS.has(k)) continue
    if (k === 'sid') out.sid = String(v).slice(0, 8)
    else out[k] = typeof v === 'number' ? v : String(v).slice(0, 60)
  }
  return JSON.stringify(out)
}
