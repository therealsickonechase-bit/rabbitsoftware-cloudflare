#!/usr/bin/env node
// probe.mjs - health probe for the Rabbitsoftware platform, modelled on NCBI's gprobe (tools/gprobe, public domain).
// gprobe checks a gRPC server and exits non-zero when it is unhealthy; this does the same for our HTTP endpoints.
//
//   node scripts/probe.mjs                  probe every endpoint below
//   node scripts/probe.mjs rabbitos         probe one by name
//   node scripts/probe.mjs --timeout 5000   per-request timeout in ms (default 8000)
//   node scripts/probe.mjs --json           machine-readable output
//
// Exit code 0 when everything probed is healthy, 1 when anything is not, 2 for a usage error.

const TARGETS = {
  site:    { url: 'https://rabbitsoftware.io/',                    expect: (r) => r.status === 200 },
  rabbitos:{ url: 'https://app.rabbitsoftware.io/api/health',      expect: async (r) => r.status === 200 && (await r.json()).status === 'ok' },
  login:   { url: 'https://app.rabbitsoftware.io/login',           expect: (r) => r.status === 200 },
  feed:    { url: 'https://app.rabbitsoftware.io/api/public/research-feed', expect: async (r) => r.status === 200 && !!(await r.json()).counts },
  agent:   { url: 'https://agent.rabbitsoftware.io/health',         expect: async (r) => r.status === 200 && (await r.json()).enabled === true },
  api:     { url: 'https://api.rabbitsoftware.io/',                expect: async (r) => r.status === 200 && (await r.json()).ok === true },
}

const args = process.argv.slice(2)
let timeout = 8000
let json = false
const names = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--timeout') timeout = Number(args[++i])
  else if (args[i] === '--json') json = true
  else if (args[i] === '-h' || args[i] === '--help') { console.log('usage: probe.mjs [--timeout ms] [--json] [' + Object.keys(TARGETS).join('|') + ']...'); process.exit(0) }
  else names.push(args[i])
}
if (!Number.isFinite(timeout) || timeout <= 0 || names.some((n) => !TARGETS[n])) { console.error('usage error: see --help'); process.exit(2) }

const run = async (name) => {
  const t = TARGETS[name]
  const started = Date.now()
  try {
    const res = await fetch(t.url, { signal: AbortSignal.timeout(timeout), redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 rabbit-probe' } })
    const healthy = await t.expect(res)
    return { name, url: t.url, healthy, status: res.status, ms: Date.now() - started }
  } catch (e) {
    return { name, url: t.url, healthy: false, status: null, ms: Date.now() - started, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message ?? e) }
  }
}

const results = await Promise.all((names.length ? names : Object.keys(TARGETS)).map(run))
if (json) console.log(JSON.stringify(results, null, 2))
else for (const r of results) console.log(`${r.healthy ? 'OK  ' : 'FAIL'} ${r.name.padEnd(9)} ${String(r.status ?? '-').padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.url}${r.error ? '  (' + r.error + ')' : ''}`)
process.exit(results.every((r) => r.healthy) ? 0 : 1)
