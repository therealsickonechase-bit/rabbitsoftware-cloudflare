// Outbound allowlist for sandbox containers. Used twice: as the Container `allowedHosts` list and inside the outbound handler
// (defence in depth). What the platform cannot restrict is documented in README.md.

/** The hub MCP on Cloud Run, and the PUBLIC ledger bucket by its own virtual-host name (never storage.googleapis.com itself, which would reach any bucket). */
export const HUB_HOST = 'rabbitos-hub-mcp-vxx5lz7c5a-wl.a.run.app'
export const LEDGER_BUCKET_HOST = 'rabbitsoftware-io-ledger-public.storage.googleapis.com'

/** Exact host names the sandbox may reach (HTTPS only, port 443). */
export const EGRESS_HOSTS = Object.freeze([
  'registry.npmjs.org', 'registry.yarnpkg.com',                   // npm / yarn
  'pypi.org', 'files.pythonhosted.org',                           // pip
  'github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'objects.githubusercontent.com',   // public code only; no credentials exist in the sandbox
  'api.anthropic.com',                                            // Claude Code with the visitor's own key
  'generativelanguage.googleapis.com',                            // Gemini CLI with the visitor's own key
  'api.githubcopilot.com',                                        // Copilot CLI API (matches GitHub's documented *.githubcopilot.com entry)
  'api.github.com',                                               // Copilot CLI user/token calls only: /user and /copilot_internal/ (see egressDecision)
  'app.rabbitsoftware.io',                                        // the public RabbitOS origin (ledger, head, read-only data hub)
  HUB_HOST,                                                       // the read-only hub MCP (links, status, public chain and data, command catalog)
  LEDGER_BUCKET_HOST,                                             // the public chain mirror in Google Cloud Storage, this one bucket only
])

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** @returns {{allow: boolean, reason?: string}} */
export function egressDecision(url, method = 'GET') {
  let u
  try { u = new URL(url) } catch { return { allow: false, reason: 'bad_url' } }
  if (u.protocol !== 'https:') return { allow: false, reason: 'https_only' }
  if (u.port && u.port !== '443') return { allow: false, reason: 'port' }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (IPV4.test(host) || host.includes(':') || host.startsWith('[')) return { allow: false, reason: 'ip_literal' }
  if (!EGRESS_HOSTS.includes(host)) return { allow: false, reason: 'host' }
  const m = method.toUpperCase()
  const read = m === 'GET' || m === 'HEAD'
  // Source hosts are read-only, except git's smart-HTTP fetch endpoint on github.com.
  if (host === 'api.github.com' && !(read && (u.pathname === '/user' || u.pathname.startsWith('/copilot_internal/')))) return { allow: false, reason: 'github_api_copilot_only' }
  if (/(^|\.)github(usercontent)?\.com$/.test(host) && !read) {
    const gitFetch = host === 'github.com' && m === 'POST' && u.pathname.endsWith('/git-upload-pack')
    // Copilot CLI device-code login (/login/device/code, /login/oauth/access_token); GitHub documents github.com/login/* for Copilot auth.
    const login = host === 'github.com' && m === 'POST' && u.pathname.startsWith('/login/')
    if (!gitFetch && !login) return { allow: false, reason: 'read_only_host' }
  }
  // RabbitOS: reads only, and only the public ledger (/api/chain/) and the read-only data hub (/api/data, /api/data/<dataset>).
  if (host === 'app.rabbitsoftware.io' && (!read || !(u.pathname.startsWith('/api/chain/') || u.pathname === '/api/data' || u.pathname.startsWith('/api/data/')))) return { allow: false, reason: 'rabbitos_chain_reads_only' }
  // The hub MCP: its JSON-RPC endpoint (POST /mcp) and its health check. Nothing else on that host.
  if (host === HUB_HOST && !((m === 'POST' && u.pathname === '/mcp') || (read && (u.pathname === '/health' || u.pathname === '/mcp')))) return { allow: false, reason: 'hub_mcp_only' }
  // The public ledger bucket: reads of its three published objects only.
  if (host === LEDGER_BUCKET_HOST && !(read && ['/ledger/chain_head.json', '/ledger/chain_ledger.jsonl', '/maxwell/maxwell_chain.json'].includes(u.pathname))) return { allow: false, reason: 'ledger_mirror_reads_only' }
  return { allow: true }
}
