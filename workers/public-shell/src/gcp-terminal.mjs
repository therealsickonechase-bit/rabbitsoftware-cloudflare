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

/** Binary messages arrive as an ArrayBuffer, a typed array or (in current Workers runtimes, by default) a Blob. Never turn a Blob into bytes with `new Uint8Array(blob)`: that is empty. */
export async function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer())
  return null
}

/**
 * @param {{connect: (url: string, protocols: string[]) => Promise<any>, origin: string, secret: string, sid: string, expiresAt: number, cols: number, rows: number, keys?: unknown}} options
 */
export async function openGcpTerminal({ connect, origin, secret, sid, expiresAt, cols, rows, keys }) {
  const token = signBridgeToken(secret, sid, expiresAt)
  const ws = await connect(`${origin}/pty`, [PTY_PROTOCOL, token])
  const decoder = new TextDecoder()
  let controller = null
  let closed = false                       // no more input or output is accepted
  const stream = new ReadableStream({ start(c) { controller = c } })
  // Output is handled one message at a time so that converting a Blob can never reorder bytes or lose the last of them before the stream ends.
  let chain = Promise.resolve()
  const finish = () => {
    try { controller.enqueue({ type: 'terminal' }) } catch { /* already closed */ }
    try { controller.close() } catch { /* already closed */ }
  }
  const end = () => {
    if (closed) return
    closed = true
    chain = chain.then(finish)
  }
  try { ws.binaryType = 'arraybuffer' } catch { /* the runtime may not allow it; Blobs are handled below */ }
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string' || closed) return          // the service only sends binary output
    const data = event.data
    chain = chain.then(async () => {
      const bytes = await toBytes(data)
      if (bytes && bytes.length) { try { controller.enqueue({ type: 'data', data: bytes }) } catch { /* stream closed */ } }
    })
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
