// Adapter: a terminal on the GCP service (workers/public-shell-gcp) that looks like the Cloudflare Sandbox terminal the bridge already uses.
// Surface the bridge needs: output() -> stream of {type:'data', data} / {type:'terminal'}, write(bytes), resize(cols, rows), terminate().
// The Worker keeps all gating (Turnstile, quotas, expiry, input budget); this only moves bytes. Pure apart from the injected `connect`.
import { PTY_PROTOCOL, signBridgeToken } from '../../public-shell-gcp/src/protocol.mjs'

/** The configured GCP service origin, or null. Only an https *.run.app address is accepted, so a bad setting cannot point the Worker elsewhere. */
export function gcpTarget(env) {
  if (env?.TERMINAL_BACKEND !== 'gcp') return null
  if (typeof env.PTY_BRIDGE_SECRET !== 'string' || env.PTY_BRIDGE_SECRET.length < 32) return null
  try {
    const u = new URL(String(env.GCP_SHELL_URL))
    return u.protocol === 'https:' && u.hostname.endsWith('.run.app') && !u.username && !u.password ? u.origin : null
  } catch { return null }
}

/**
 * @param {{connect: (url: string, protocols: string[]) => Promise<any>, origin: string, secret: string, sid: string, expiresAt: number, cols: number, rows: number, keys?: unknown}} options
 */
export async function openGcpTerminal({ connect, origin, secret, sid, expiresAt, cols, rows, keys }) {
  const token = signBridgeToken(secret, sid, expiresAt)
  const ws = await connect(`${origin}/pty`, [PTY_PROTOCOL, token])
  const decoder = new TextDecoder()
  let controller = null
  let closed = false
  const stream = new ReadableStream({ start(c) { controller = c } })
  const end = () => {
    if (closed) return
    closed = true
    try { controller.enqueue({ type: 'terminal' }) } catch { /* already closed */ }
    try { controller.close() } catch { /* already closed */ }
  }
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string' || closed) return          // the service only sends binary output
    try { controller.enqueue({ type: 'data', data: new Uint8Array(event.data) }) } catch { /* stream closed */ }
  })
  ws.addEventListener('close', end)
  ws.addEventListener('error', end)
  ws.send(JSON.stringify({ t: 'start', cols, rows, keys }))
  return {
    output: async () => stream,
    write: async (bytes) => { if (!closed) ws.send(JSON.stringify({ t: 'i', d: decoder.decode(bytes) })) },
    resize: async (c, r) => { if (!closed) ws.send(JSON.stringify({ t: 'r', cols: c, rows: r })) },
    terminate: async () => { end(); try { ws.close(1000, 'done') } catch { /* closed */ } },
  }
}
