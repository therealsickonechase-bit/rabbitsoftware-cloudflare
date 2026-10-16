// The live research file for rabbitsoftware.io: status/research-live.json in the public status bucket, rewritten by the status job every 5 minutes from the app's PUBLIC research feed.
// The website reads it in the browser, so a new finding shows up on the site without deploying the site. Only public facts go in: counts, topic counts and the newest records (id, source,
// title, link, when first seen). No metadata blobs, nothing private. Titles come from outside sources, so they are cleaned here and the page shows them as plain text.

const SOURCE = /^[a-z][a-z0-9_]{0,29}$/
const MAX_RECENT = 12

const int = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : null)
const clean = (s, max) => String(s ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null }
/** Only https links are passed on. */
const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && x.hostname.includes('.') ? x.toString().slice(0, 300) : null } catch { return null } }

/** @param {object|null} feed the app's public research feed @returns {object|null} */
export function buildResearchLive(feed, now = new Date()) {
  if (!feed || typeof feed !== 'object') return null
  const bySource = {}
  let total = 0
  for (const [k, v] of Object.entries(feed.counts && typeof feed.counts === 'object' ? feed.counts : {})) {
    const n = int(v)
    if (n !== null && SOURCE.test(k)) { bySource[k] = n; total += n }
  }
  const recent = (Array.isArray(feed.recent) ? feed.recent : []).slice(0, MAX_RECENT).flatMap((r) => {
    const id = clean(r?.id, 80), title = clean(r?.title, 220), source = SOURCE.test(String(r?.source)) ? String(r.source) : null
    return id && title && source ? [{ id, source, title, url: httpsUrl(r.url), seenAt: iso(r.first_seen_at) }] : []
  })
  const topics = feed.topics && typeof feed.topics === 'object' ? { explored: int(feed.topics.explored), queued: int(feed.topics.queued) } : { explored: null, queued: null }
  return { version: 1, generatedAt: now.toISOString(), lastReportAt: iso(feed.chain?.audit_head_time), total, bySource, topics, recent }
}
