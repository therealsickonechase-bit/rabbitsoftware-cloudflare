// Can the agents inside the guest shell use the hub? Opens one session on the Cloud Run service and checks, from INSIDE the shell:
//   1. the hub answers a real MCP request through the proxy (tools/list)
//   2. the settings files for gemini, claude and copilot are in place
//   3. `gemini mcp list` and `claude mcp list` see the server
//   PTY_URL=wss://<service>/pty PTY_BRIDGE_SECRET=<secret> node scripts/agents-hub.mjs
import { PTY_PROTOCOL, signBridgeToken } from '../src/protocol.mjs'

const url = process.env.PTY_URL, secret = process.env.PTY_BRIDGE_SECRET
if (!url || !secret) { console.error('Set PTY_URL and PTY_BRIDGE_SECRET.'); process.exit(2) }
const HUB = 'https://rabbitos-hub-mcp-vxx5lz7c5a-wl.a.run.app/mcp'

const ws = new WebSocket(url, [PTY_PROTOCOL, signBridgeToken(secret, 'agents' + Date.now().toString(36), Date.now() + 10 * 60_000)])
ws.binaryType = 'arraybuffer'
let screen = ''
const dec = new TextDecoder()
ws.onmessage = (e) => { if (typeof e.data !== 'string') screen += dec.decode(e.data) }
const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('connection failed')) })
const until = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(screen)) return true; await new Promise((r) => setTimeout(r, 100)) } return false }
let seq = 0
const run = async (cmd, ms = 60_000) => {
  const n = 300 + ++seq; screen = ''
  ws.send(JSON.stringify({ t: 'i', d: `${cmd}; echo MK$((${n}*2))\r` }))
  await until(new RegExp(`MK${n * 2}`), ms)
  await new Promise((r) => setTimeout(r, 300))
  return screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail.replace(/\s+/g, ' ').slice(0, 260)}`) }

await opened
ws.send(JSON.stringify({ t: 'start', cols: 200, rows: 50 }))
if (!(await until(/visitor@rabbitos/, 40_000))) { console.error('no shell prompt'); process.exit(1) }

let out = await run(`curl -s -m 25 -X POST ${HUB} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | wc -l | sed 's/^/TOOLS=/'`)
const tools = Number((out.match(/TOOLS=(\d+)/) ?? [])[1] ?? 0)
check('the hub answers an MCP tools/list through the proxy', tools >= 15, out.slice(-200))

out = await run(`curl -s -m 25 -X POST ${HUB} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chain_consistency","arguments":{}}}' | grep -o 'allOk[^,]*' | head -n 1 | sed 's/^/CONS=/'`)
check('chain_consistency runs from inside the shell and the chain agrees', /CONS=allOk\\?": ?true/.test(out), out.slice(-200))

out = await run('ls -1 ~/.gemini/settings.json ~/.claude.json ~/.copilot/mcp-config.json 2>&1; grep -l rabbitos-hub ~/.gemini/settings.json ~/.claude.json ~/.copilot/mcp-config.json 2>&1 | wc -l | sed "s/^/CFG=/"')
check('settings for gemini, claude and copilot are in place', /CFG=3/.test(out), out.slice(-250))

out = await run('timeout 50 gemini mcp list 2>&1 | grep -i rabbitos | head -n 2', 70_000)
check('gemini sees the rabbitos-hub server', /rabbitos-hub/i.test(out) && /connected|✓/i.test(out), out.slice(-250))

out = await run('timeout 50 claude mcp list 2>&1 | grep -i rabbitos | head -n 2', 70_000)
check('claude sees the rabbitos-hub server', /rabbitos-hub/i.test(out), out.slice(-250))

// the agents must NOT be able to reach what stays closed
out = await run('echo C=$(curl -s -m 10 -o /dev/null -w "%{http_code}" https://rabbitsoftware-io-backups.storage.googleapis.com/ 2>/dev/null)')
check('the private backups bucket is still unreachable', /C=000/.test(out), out.slice(-120))

ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }))
console.log(results.every(Boolean) ? '\nALL PASSED' : '\nSOME FAILED')
setTimeout(() => process.exit(results.every(Boolean) ? 0 : 1), 1500)
