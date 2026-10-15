// What can the guest shell reach? Opens one session on the Cloud Run service and asks curl about each system, from INSIDE the shell.
//   PTY_URL=wss://<service>/pty PTY_BRIDGE_SECRET=<secret> [REACH_SUPABASE_URL=https://<project>.supabase.co] node scripts/reach.mjs
// "reachable" = any HTTP answer; "blocked" = no answer (the proxy refuses the host). Prints a table and exits 1 if a result differs from the intended design.
import { PTY_PROTOCOL, signBridgeToken } from '../src/protocol.mjs'

const url = process.env.PTY_URL, secret = process.env.PTY_BRIDGE_SECRET
if (!url || !secret) { console.error('Set PTY_URL and PTY_BRIDGE_SECRET.'); process.exit(2) }
const supabase = process.env.REACH_SUPABASE_URL

// intended: 'open' = the design lets the guest shell reach it; 'closed' = it must not.
const TARGETS = [
  ['RabbitOS public chain head', 'https://app.rabbitsoftware.io/api/chain/head', 'open', 'public ledger (Supabase-backed)'],
  ['RabbitOS data hub', 'https://app.rabbitsoftware.io/api/data', 'open', 'public research data'],
  ['npm registry', 'https://registry.npmjs.org/left-pad', 'open', 'packages'],
  ['PyPI', 'https://pypi.org/simple/pip/', 'open', 'packages'],
  ['GitHub (public code)', 'https://raw.githubusercontent.com/octocat/Hello-World/master/README', 'open', 'public code'],
  ['Anthropic API', 'https://api.anthropic.com/v1/models', 'open', 'claude (needs the visitor\'s own key)'],
  ['Gemini API', 'https://generativelanguage.googleapis.com/v1beta/models', 'open', 'gemini (needs the visitor\'s own key)'],
  ['Public website', 'https://rabbitsoftware.io/', 'closed', 'not on the allowlist (the hub tool site_page reads it)'],
  ['RabbitOS hub MCP (Cloud Run)', 'https://rabbitos-hub-mcp-vxx5lz7c5a-wl.a.run.app/health', 'open', 'read-only tool server: links, status, public chain and data, commands'],
  ['Public ledger bucket (GCS)', 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json', 'open', 'public mirror of the chain (this one bucket only)'],
  ['Private backups bucket (own host)', 'https://rabbitsoftware-io-backups.storage.googleapis.com/', 'closed', 'sibling bucket host: must stay closed'],
  ['Private backups bucket (API)', 'https://storage.googleapis.com/storage/v1/b/rabbitsoftware-io-backups/o', 'closed', 'must stay closed'],
  ['Any other bucket host', 'https://some-other-bucket.storage.googleapis.com/', 'closed', 'only the one public bucket is open'],
  ['Other Cloud Run service (visitor shell)', 'https://rabbit-visitor-shell-vxx5lz7c5a-wl.a.run.app/health', 'closed', 'only the hub is open'],
  ...(supabase ? [['Supabase project', `${supabase}/rest/v1/`, 'closed', 'system of record; must stay closed']] : []),
  ['Cloudflare API', 'https://api.cloudflare.com/client/v4/user/tokens/verify', 'closed', 'must stay closed'],
  ['Google Cloud APIs', 'https://compute.googleapis.com/compute/v1/projects', 'closed', 'must stay closed'],
  ['GCP metadata server', 'http://169.254.169.254/computeMetadata/v1/', 'closed', 'must stay closed'],
  ['Cloud Run app mirror', 'https://run.rabbitsoftware.io/api/health', 'closed', 'not on the allowlist'],
  ['Owner PC / local network', 'http://192.168.1.1/', 'closed', 'no route from the sandbox'],
]

const ws = new WebSocket(url, [PTY_PROTOCOL, signBridgeToken(secret, 'reach' + Date.now().toString(36), Date.now() + 10 * 60_000)])
ws.binaryType = 'arraybuffer'
let screen = ''
const dec = new TextDecoder()
ws.onmessage = (e) => { if (typeof e.data !== 'string') screen += dec.decode(e.data) }
const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('connection failed')) })
const until = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(screen)) return true; await new Promise((r) => setTimeout(r, 100)) } return false }
let seq = 0
const run = async (cmd) => {
  const n = 200 + ++seq; screen = ''
  ws.send(JSON.stringify({ t: 'i', d: `${cmd}; echo MK$((${n}*2))\r` }))
  await until(new RegExp(`MK${n * 2}`), 40_000)
  await new Promise((r) => setTimeout(r, 300))
  return screen
}

await opened
ws.send(JSON.stringify({ t: 'start', cols: 160, rows: 40 }))
if (!(await until(/visitor@rabbitos/, 40_000))) { console.error('no shell prompt'); process.exit(1) }
const rows = []
for (const [name, target, intended, note] of TARGETS) {
  // A plain http:// request goes to the proxy, which answers 403 with its own error page ("Server: squid"). That is a refusal, not an answer from the target.
  const out = await run(`c=$(curl -s -m 12 -D /tmp/h -o /dev/null -w "%{http_code}" "${target}" 2>/dev/null); echo CODE=$c SQ=$(grep -ci squid /tmp/h 2>/dev/null); rm -f /tmp/h`)
  const code = (out.match(/CODE=(\d{3})/) ?? [])[1] ?? '???'
  const proxyRefused = Number((out.match(/SQ=(\d+)/) ?? [])[1] ?? 0) > 0
  const reachable = code !== '000' && code !== '???' && !proxyRefused
  rows.push({ name, intended, reachable, code, note, ok: intended === 'open' ? reachable : !reachable })
}
ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }))
const pad = (s, n) => String(s).padEnd(n)
console.log(`${pad('SYSTEM', 32)} ${pad('INTENDED', 9)} ${pad('ACTUAL', 18)} RESULT  NOTE`)
for (const r of rows) console.log(`${pad(r.name, 32)} ${pad(r.intended, 9)} ${pad(r.reachable ? 'reachable (' + r.code + ')' : 'blocked', 18)} ${r.ok ? 'as designed' : 'MISMATCH'}  ${r.note}`)
const bad = rows.filter((r) => !r.ok)
console.log(bad.length ? `\n${bad.length} mismatch(es)` : '\nEvery system behaves as designed.')
setTimeout(() => process.exit(bad.length ? 1 : 0), 1500)
