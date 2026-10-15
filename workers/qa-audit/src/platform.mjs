// Is each piece of the platform answering? Public endpoints only, no credentials. Feeds the platform map in the report.

export const HUB = 'https://rabbitos-hub-mcp-vxx5lz7c5a-wl.a.run.app'
export const BUCKET = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com'

// key, label, url, text that must appear in the answer
export const PROBES = Object.freeze([
  ['site', 'rabbitsoftware.io', 'https://rabbitsoftware.io/', 'RabbitSoftware'],
  ['app', 'RabbitOS app', 'https://app.rabbitsoftware.io/api/health', '"status":"ok"'],
  ['supabase', 'Supabase database (through the app)', 'https://app.rabbitsoftware.io/api/health', '"database":"ok"'],
  ['chainHead', 'Public chain', 'https://app.rabbitsoftware.io/api/chain/head', 'headHash'],
  ['dataHub', 'Data hub', 'https://app.rabbitsoftware.io/api/data', 'datasets'],
  ['shellWorker', 'Guest shell gate (Worker)', 'https://rabbitsoftware-public-shell.rabbitsoftware-gateway.workers.dev/health', '"ok":true'],
  ['shellService', 'Visitor shell (Cloud Run)', 'https://rabbit-visitor-shell-vxx5lz7c5a-wl.a.run.app/health', 'ok'],
  ['hub', 'Hub MCP (Cloud Run)', `${HUB}/health`, 'ok'],
  ['standby', 'Standby website (Cloud Run)', 'https://rabbit-site-standby-vxx5lz7c5a-wl.a.run.app/', 'RabbitSoftware'],
  ['mirror', 'App mirror (Cloud Run)', 'https://run.rabbitsoftware.io/api/health', '"status":"ok"'],
  ['ledgerBucket', 'Public ledger bucket', `${BUCKET}/ledger/chain_head.json`, 'headHash'],
])

async function probe(fetchImpl, [key, label, url, expect], timeoutMs) {
  const t0 = Date.now()
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'rabbitweb-audit/1.0' }, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    return { key, label, url, ok: res.status === 200 && text.includes(expect), status: res.status, ms: Date.now() - t0, text }
  } catch (error) {
    return { key, label, url, ok: false, status: 0, ms: Date.now() - t0, text: '', error: error instanceof Error ? error.name : 'error' }
  }
}

/**
 * How recently the owner's research agents reported to the app: the time of the newest research audit entry and public record counts.
 * Reads the app's public research feed. Returns null if the feed cannot be read (a gap in the report, never a failure of the audit).
 */
export async function readResearch(fetchImpl, timeoutMs = 12_000) {
  try {
    const res = await fetchImpl('https://app.rabbitsoftware.io/api/public/research-feed', { headers: { 'user-agent': 'rabbitweb-audit/1.0' }, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return null
    const feed = JSON.parse(await res.text())
    const at = Date.parse(feed?.chain?.audit_head_time)
    const counts = feed?.counts && typeof feed.counts === 'object' ? feed.counts : {}
    return {
      lastReportAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
      records: Object.values(counts).reduce((n, v) => n + (Number.isFinite(v) ? v : 0), 0),
      topicsExplored: Number.isFinite(feed?.topics?.explored) ? feed.topics.explored : null,
      topicsQueued: Number.isFinite(feed?.topics?.queued) ? feed.topics.queued : null,
    }
  } catch { return null }
}

/** @returns {Promise<{nodes: Record<string, object>, chain: object, data: object, research: object|null}>} */
export async function checkPlatform({ fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const [results, research] = await Promise.all([Promise.all(PROBES.map((p) => probe(fetchImpl, p, timeoutMs))), readResearch(fetchImpl, timeoutMs)])
  const nodes = Object.fromEntries(results.map(({ text, ...r }) => [r.key, r]))
  const text = Object.fromEntries(results.map((r) => [r.key, r.text]))
  const json = (k) => { try { return JSON.parse(text[k]) } catch { return null } }
  const appHead = json('chainHead'), bucketHead = json('ledgerBucket'), data = json('dataHub')
  const chain = {
    app: appHead ? { length: appHead.length, headHash: appHead.headHash } : null,
    bucket: bucketHead ? { length: bucketHead.length, headHash: bucketHead.headHash } : null,
  }
  chain.agree = !!(chain.app && chain.bucket && chain.app.length === chain.bucket.length && chain.app.headHash === chain.bucket.headHash)
  const datasets = data?.datasets ?? []
  return {
    nodes, chain, research,
    data: { datasets: datasets.length, researchRows: datasets.find((d) => d.id === 'research_records')?.rows ?? null, rows: datasets.reduce((n, d) => n + (Number(d.rows) || 0), 0) },
    // The public data tree: what the data hub itself publishes (names, sizes and column names), nothing more.
    tree: datasets.map((d) => ({ id: String(d.id), title: String(d.title ?? d.id), rows: Number(d.rows) || 0, columns: Array.isArray(d.columns) ? d.columns.map(String) : [] })),
    up: results.filter((r) => r.ok).length, total: results.length,
  }
}
