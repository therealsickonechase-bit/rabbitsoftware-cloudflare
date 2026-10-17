// The status recorder. Every few minutes it checks the PUBLIC parts of the platform and writes two small files to a public bucket that rabbitsoftware.io reads in the browser:
//   status/latest.json   the current picture: services up or down, chain copies, the public data tree
//   status/history.json  the last 24 hours (one entry per run), for the uptime strips
// It also writes status/research-live.json, the newest public research findings, which the website reads in the browser so new findings appear without deploying the site.
// It also logs one "status_check" line, which Cloud Logging keeps and the BigQuery sink records. Nothing private goes in the feed: no addresses, no findings, no private services.
import { buildDigest, buildProofLive } from './proof-live.mjs'
import { buildWitnessLive } from './witness-live.mjs'
import { checkPlatform } from './platform.mjs'
import { uploadObject } from './gcs.mjs'

/** The services the public page may show, in a fixed order (history entries are strings in this order). */
export const PUBLIC_KEYS = Object.freeze(['site', 'app', 'supabase', 'chainHead', 'dataHub', 'shellWorker', 'shellService', 'hub', 'standby', 'mirror', 'ledgerBucket'])
export const MAX_HISTORY = 288                 // 24 hours at one entry every 5 minutes

export function buildFeed(platform, now = new Date()) {
  const services = PUBLIC_KEYS.map((key) => {
    const n = platform.nodes[key]
    return { key, label: n?.label ?? key, ok: !!n?.ok, ms: n?.ms ?? 0 }
  })
  const short = (h) => (typeof h === 'string' ? h.slice(0, 12) : null)
  return {
    generatedAt: now.toISOString(),
    up: services.filter((s) => s.ok).length, total: services.length, services,
    chain: { app: platform.chain.app ? { length: platform.chain.app.length, head: short(platform.chain.app.headHash) } : null,
      mirror: platform.chain.bucket ? { length: platform.chain.bucket.length, head: short(platform.chain.bucket.headHash) } : null, agree: platform.chain.agree },
    data: platform.data,
    research: platform.research ?? null,
    tree: platform.tree ?? [],
  }
}

/** One compact history entry: when, how many up, whether the chain copies agreed, and 1 or 0 per service in PUBLIC_KEYS order. */
export function historyEntry(feed) {
  return { t: feed.generatedAt, up: feed.up, total: feed.total, agree: !!feed.chain.agree, s: feed.services.map((s) => (s.ok ? '1' : '0')).join('') }
}

export function nextHistory(previous, feed, max = MAX_HISTORY) {
  const list = Array.isArray(previous) ? previous.filter((e) => e && typeof e.t === 'string' && typeof e.s === 'string') : []
  return [...list, historyEntry(feed)].slice(-max)
}

export async function recordStatus({ fetchImpl = fetch, bucket, upload = uploadObject, now = new Date(), log = console.log } = {}) {
  const platform = await checkPlatform({ fetchImpl })
  const feed = buildFeed(platform, now)
  let previous = []
  try {
    const res = await fetchImpl(`https://${bucket}.storage.googleapis.com/status/history.json`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(10_000) })
    if (res.ok) previous = JSON.parse(await res.text())
  } catch { /* first run, or the bucket is unreachable: start a fresh history */ }
  const history = nextHistory(previous, feed)
  const headers = { cacheControl: 'no-cache', contentType: 'application/json' }
  await upload({ bucket, name: 'status/latest.json', body: JSON.stringify(feed), ...headers })
  await upload({ bucket, name: 'status/history.json', body: JSON.stringify(history), ...headers })
  // The live research file the website reads in the browser (see research-live.mjs). A failure here must never stop the status feed.
  if (platform.researchLive) { try { await upload({ bucket, name: 'status/research-live.json', body: JSON.stringify(platform.researchLive), ...headers }) } catch { /* the next run tries again */ } }
  // Proof for the website: the anchors re-checked against Bitcoin, and a plain-language digest (see proof-live.mjs). Neither may ever stop the status feed.
  try {
    const readJson = async (name) => { try { const r = await fetchImpl(`https://${bucket}.storage.googleapis.com/status/${name}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(10_000) }); return r.ok ? JSON.parse(await r.text()) : null } catch { return null } }
    const [previousProof, previousDigest] = await Promise.all([readJson('proof-live.json'), readJson('digest.json')])
    const proofLive = await buildProofLive({ fetchImpl, now, previous: previousProof })
    if (proofLive) {
      await upload({ bucket, name: 'status/proof-live.json', body: JSON.stringify(proofLive), ...headers })
      const digest = buildDigest({ researchLive: platform.researchLive, proofLive, previous: previousDigest, now })
      if (digest) await upload({ bucket, name: 'status/digest.json', body: JSON.stringify(digest), ...headers })
    }
  } catch { /* the next run tries again */ }
  // Who has independently checked the Maxwell chain (peer witnesses, see witness-live.mjs). Never allowed to stop the status feed either.
  try {
    const witness = await buildWitnessLive({ fetchImpl, now })
    if (witness) await upload({ bucket, name: 'status/witness.json', body: JSON.stringify(witness), ...headers })
  } catch { /* the next run tries again */ }
  log(JSON.stringify({ event: 'status_check', up: feed.up, total: feed.total, chain_agrees: feed.chain.agree, down: feed.services.filter((s) => !s.ok).map((s) => s.key).join(',') || null }))
  return { feed, history }
}

if (process.argv[1]?.endsWith('status.mjs')) {
  const bucket = process.env.STATUS_BUCKET
  if (!bucket) { console.error(JSON.stringify({ event: 'status_failed', reason: 'STATUS_BUCKET is not set' })); process.exit(1) }
  recordStatus({ bucket }).catch((error) => { console.error(JSON.stringify({ event: 'status_failed', reason: error instanceof Error ? error.name : 'error' })); process.exit(1) })
}
