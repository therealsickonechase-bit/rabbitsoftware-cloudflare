// Cloud Run visitor terminal. ONE WebSocket = ONE bash for ONE visitor, then this process exits so Cloud Run starts a fresh instance.
// Run with concurrency 1 and a service account that has no roles. Outbound traffic is forced through the allowlist proxy by the VPC (see README.md).
import http from 'node:http'
import { WebSocketServer } from 'ws'
import * as pty from 'node-pty'
import { buildKeyEnv, logLine, terminalEnv } from '../../public-shell/src/env.mjs'
import { LIMITS } from '../../public-shell/src/limits.mjs'
import { PTY_PROTOCOL, parseClientFrame, parseStartFrame, tokenFromProtocols, verifyBridgeToken } from './protocol.mjs'

const SECRET = process.env.PTY_BRIDGE_SECRET ?? ''
delete process.env.PTY_BRIDGE_SECRET            // the shell is started with an explicit env, but do not keep the secret in process.env anyway
const PORT = Number(process.env.PORT) || 8080
const PROXY = process.env.EGRESS_PROXY_URL ?? ''  // e.g. http://10.0.0.5:3128, the only place the VPC lets this container talk to
if (SECRET.length < 32) { console.error(logLine({ event: 'fatal', reason: 'PTY_BRIDGE_SECRET missing or short' })); process.exit(1) }

let used = false
const finish = (code = 0) => setTimeout(() => process.exit(code), 200)   // Cloud Run restarts a clean container for the next visitor

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return }
  res.writeHead(404); res.end()
})
const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes, handleProtocols: (protocols) => (protocols.has(PTY_PROTOCOL) ? PTY_PROTOCOL : false) })

server.on('upgrade', (req, socket, head) => {
  const deny = (status, text) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy() }
  if (req.url !== '/pty') return deny(404, 'Not Found')
  const claims = verifyBridgeToken(SECRET, tokenFromProtocols(req.headers['sec-websocket-protocol']))
  if (!claims) return deny(401, 'Unauthorized')
  if (used) return deny(409, 'Conflict')          // this instance already served (or is serving) a visitor
  used = true
  wss.handleUpgrade(req, socket, head, (ws) => run(ws, claims))
})

function run(ws, claims) {
  const sid = claims.sid
  let shell = null
  let output = 0
  let lastActive = Date.now()                         // typing OR terminal output: a build or an agent that is working is not idle
  let ended = false
  const end = (reason, code = 1000) => {
    if (ended) return
    ended = true
    console.log(logLine({ event: 'end', sid, reason }))
    try { shell?.kill() } catch { /* already gone */ }
    try { ws.close(code, reason.slice(0, 100)) } catch { /* closed */ }
    finish(0)
  }
  const hello = setTimeout(() => end('hello timeout', 1008), LIMITS.helloTimeoutMs)
  const lifetime = setTimeout(() => end('max lifetime'), Math.min(LIMITS.maxLifetimeMs, Math.max(1000, claims.expiresAt - Date.now())))
  const idle = setInterval(() => { if (Date.now() - lastActive > LIMITS.idleMs) end('idle') }, 15_000)
  ws.on('close', () => { clearTimeout(hello); clearTimeout(lifetime); clearInterval(idle); end('closed') })
  ws.on('error', () => end('socket error', 1011))

  ws.on('message', (data, isBinary) => {
    if (isBinary) return end('text frames only', 1003)
    const text = data.toString('utf8')
    if (!shell) {
      const start = parseStartFrame(text)
      if (!start.ok) return end(start.error, 1008)
      const keys = buildKeyEnv(start.keys)
      if (!keys.ok) return end(keys.error, 1008)
      clearTimeout(hello)
      const env = terminalEnv(keys.env)
      if (PROXY) Object.assign(env, { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, https_proxy: PROXY, http_proxy: PROXY, NO_PROXY: '', no_proxy: '' })
      try {
        shell = pty.spawn('/usr/sbin/runuser', ['-u', 'visitor', '--', '/bin/bash', '-l'], { name: 'xterm-256color', cols: start.cols, rows: start.rows, cwd: '/home/visitor', env })
      } catch (error) {
        console.log(logLine({ event: 'spawn_error', sid, reason: error instanceof Error ? `${error.name}: ${error.message}` : 'error' }))
        return end('could not start shell', 1011)
      }
      shell.onData((chunk) => {
        output += chunk.length
        lastActive = Date.now()
        if (output > LIMITS.maxOutputBytes) return end('output limit', 1009)
        try { ws.send(Buffer.from(chunk, 'utf8')) } catch { /* closed */ }
      })
      shell.onExit(() => end('exited'))
      console.log(logLine({ event: 'started', sid }))
      return
    }
    const frame = parseClientFrame(text)
    if (!frame.ok) return end(frame.error, 1008)
    lastActive = Date.now()
    if (frame.t === 'i') shell.write(frame.d)
    else shell.resize(frame.cols, frame.rows)
  })
}

server.listen(PORT, () => console.log(logLine({ event: 'listening', code: PORT })))
