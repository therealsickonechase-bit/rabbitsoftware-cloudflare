// Smoke test for the terminal server, against a running container (local Docker or Cloud Run).
//   PTY_URL=ws://localhost:8080/pty PTY_BRIDGE_SECRET=<same secret the server has> node scripts/smoke.mjs
// Opens ONE session (the server serves a single visitor and then exits), runs a few commands and checks the isolation it promises.
import { PTY_PROTOCOL, signBridgeToken } from '../src/protocol.mjs'

const url = process.env.PTY_URL
const secret = process.env.PTY_BRIDGE_SECRET
if (!url || !secret) { console.error('Set PTY_URL and PTY_BRIDGE_SECRET.'); process.exit(2) }

const token = signBridgeToken(secret, 'smoke' + Date.now().toString(36), Date.now() + 5 * 60_000)
const ws = new WebSocket(url, [PTY_PROTOCOL, token])
ws.binaryType = 'arraybuffer'
let screen = ''
const decoder = new TextDecoder()
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`) }
const until = async (pattern, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pattern.test(screen)) return true; await new Promise((r) => setTimeout(r, 100)) }
  return false
}
const send = (d) => ws.send(JSON.stringify({ t: 'i', d }))
// The end marker is computed by the shell (MK$((n*2)) prints MK<2n>), so it can only appear in the OUTPUT, never in the echoed command line.
let seq = 0
const run = async (cmd) => {
  const n = 100 + (++seq)
  screen = ''
  send(`${cmd}; echo MK$((${n}*2))\r`)
  await until(new RegExp(`MK${n * 2}`), 45_000)
  await new Promise((r) => setTimeout(r, 400))   // let the prompt arrive before the next command
  return screen
}

ws.onmessage = (e) => { if (typeof e.data !== 'string') screen += decoder.decode(e.data) }
const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('connection failed')) })
const closed = new Promise((resolve) => { ws.onclose = (e) => resolve(e) })

try {
  await opened
  ws.send(JSON.stringify({ t: 'start', cols: 120, rows: 30 }))
  check('shell prompt appears', await until(/visitor@rabbitos/, 30_000), screen.slice(-200))

  let out = await run('echo $((6*7))', 'DONE1')
  check('commands run', /42/.test(out), out.slice(-200))

  out = await run('id -un; id -u', 'DONE2')
  check('runs as the unprivileged visitor, not root', /visitor/.test(out) && /\b1500\b/.test(out) && !/\broot\b/.test(out), out.slice(-200))

  out = await run('echo LEAKCOUNT=$(env | grep -i -E "bridge|secret|token|signing" | wc -l)', 'DONE3')
  check('no bridge secret or token in the shell environment', /LEAKCOUNT=0/.test(out), out.slice(-200))

  out = await run('cat /proc/1/environ 2>&1 | head -c 100; ls /app 2>&1 | head -n 2', 'DONE4')
  check('server files and environment are not readable', /(Permission denied|cannot open)/i.test(out), out.slice(-200))

  out = await run('pwd; ls ~ ; command -v claude gemini copilot pwsh rabbit-save | wc -l', 'DONE5')
  check('work folder, agent notes and CLIs are present', /work/.test(out) && /AGENTS\.md/.test(out) && /\b5\b/.test(out), out.slice(-300))

  // `command -v` only proves a file exists; a CLI whose native binary failed to download still passes that. Run them.
  out = await run('echo CLI_CLAUDE=$(claude --version 2>&1 | head -n 1); echo CLI_GEMINI=$(gemini --version 2>&1 | head -n 1); echo CLI_COPILOT=$(copilot --version 2>&1 | head -n 1)')
  const version = (name) => new RegExp(`CLI_${name}=[^\\r\\n]*\\d+\\.\\d+\\.\\d+`).test(out)
  check('claude, gemini and copilot really run', version('CLAUDE') && version('GEMINI') && version('COPILOT'), out.slice(-300))

  if (process.env.EGRESS_CHECK) {
    // Only meaningful on Cloud Run behind the VPC firewall and the proxy. All four must hold.
    const code = (cmd, tag) => `echo ${tag}=$(${cmd} 2>/dev/null)`
    out = await run(code('curl -s -m 15 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/left-pad', 'X'), 'EDONE1')
    check('egress: an allowed host works (npm registry)', /X=200/.test(out), out.slice(-200))
    out = await run(code('curl -s -m 12 -o /dev/null -w "%{http_code}" https://example.com', 'X'), 'EDONE2')
    check('egress: a host that is not allowed is refused', !/X=(200|301|302)/.test(out), out.slice(-200))
    out = await run(code('curl -s -m 8 -o /dev/null -w "%{http_code}" --noproxy "*" https://registry.npmjs.org/left-pad', 'X'), 'EDONE3')
    check('egress: going around the proxy fails', !/X=(200|301|302|404)/.test(out), out.slice(-200))
    out = await run(code('curl -s -m 8 -o /dev/null -w "%{http_code}" --noproxy "*" http://1.1.1.1', 'X'), 'EDONE4')
    check('egress: a raw IP is unreachable', !/X=(200|301|302)/.test(out), out.slice(-200))
    out = await run(code('curl -s -m 5 -H "Metadata-Flavor: Google" -o /dev/null -w "%{http_code}" http://metadata.google.internal/computeMetadata/v1/instance/id', 'X'), 'EDONE5')
    console.log('INFO  metadata server answer from the shell:', (out.match(/X=(\d*)/) ?? [])[1] || '(none)', '(the runner account has no roles, so a token from it is worthless)')
  }

  send('exit\r')
  const closeEvent = await Promise.race([closed, new Promise((r) => setTimeout(() => r(null), 15_000))])
  check('the session ends when the shell exits', closeEvent !== null)
} catch (error) {
  check('smoke run', false, error instanceof Error ? error.message : String(error))
}
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
