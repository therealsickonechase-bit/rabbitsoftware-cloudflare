// The logic behind the live status page: how fresh the feed is, the overall state, and the 24-hour uptime strips. Pure, so tests can run it.

export const LATE_AFTER_MIN = 12      // the recorder runs every 5 minutes; two missed runs is "late"
export const STALE_AFTER_MIN = 30

export function ageMinutes(iso, now = Date.now()) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, (now - t) / 60000) : Infinity
}

/** 'live' | 'late' | 'stale': is the recorder still reporting? */
export function freshness(iso, now = Date.now()) {
  const m = ageMinutes(iso, now)
  return m <= LATE_AFTER_MIN ? 'live' : m <= STALE_AFTER_MIN ? 'late' : 'stale'
}

export function ageText(iso, now = Date.now()) {
  const m = ageMinutes(iso, now)
  if (!Number.isFinite(m)) return 'unknown'
  if (m < 1) return 'just now'
  if (m < 60) return `${Math.round(m)} minute${Math.round(m) === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.floor(h / 24)} days ago`
}

export const RESEARCH_STALE_AFTER_HOURS = 24

/** What the research line says: when the owner's agents last reported to the app, and whether that is recent. Never an error: the agents run on a private computer. */
export function researchLine(research, now = Date.now()) {
  if (!research) return { state: 'unknown', text: 'The research feed could not be read in the last check.' }
  const records = Number.isFinite(research.records) ? `${research.records} public records` : 'public records'
  const topics = Number.isFinite(research.topicsExplored) ? `, ${research.topicsExplored} topics explored${Number.isFinite(research.topicsQueued) ? `, ${research.topicsQueued} queued` : ''}` : ''
  if (!research.lastReportAt) return { state: 'unknown', text: `${records}${topics}. When the research agents last reported is not known yet.` }
  const hours = ageMinutes(research.lastReportAt, now) / 60
  const when = ageText(research.lastReportAt, now)
  return hours > RESEARCH_STALE_AFTER_HOURS
    ? { state: 'quiet', text: `The research agents last reported ${when}. ${records}${topics}. They run on a private computer, so a quiet day is not an outage.` }
    : { state: 'ok', text: `The research agents last reported ${when}. ${records}${topics}.` }
}

/** The headline: everything answering, some services not answering, or the feed itself too old to trust. */
export function overall(feed, now = Date.now()) {
  if (!feed) return { state: 'unknown', text: 'Status is not available right now.' }
  if (freshness(feed.generatedAt, now) === 'stale') return { state: 'stale', text: `The last report is ${ageText(feed.generatedAt, now)}. Treat the details below as out of date.` }
  const down = feed.services.filter((s) => !s.ok)
  if (!down.length) return { state: 'ok', text: `All ${feed.total} services are answering.` }
  return { state: down.length === feed.total ? 'down' : 'degraded', text: `${down.length} of ${feed.total} services not answering: ${down.map((s) => s.label).join(', ')}.` }
}

/**
 * The last 24 hours split into equal slots for one service: 'up' when every report in the slot saw it answering, 'down' when any did not, 'none' when no report fell in the slot.
 * @param {Array<{t: string, s: string}>} history  @param {number} index position of the service in each entry's string
 */
export function strip(history, index, slots = 48, now = Date.now()) {
  const span = 24 * 3600 * 1000, slot = span / slots, start = now - span
  const out = Array.from({ length: slots }, () => 'none')
  for (const e of Array.isArray(history) ? history : []) {
    const t = Date.parse(e?.t)
    if (!Number.isFinite(t) || t < start || t > now || typeof e.s !== 'string' || e.s.length <= index) continue
    const i = Math.min(slots - 1, Math.floor((t - start) / slot))
    if (e.s[index] === '0') out[i] = 'down'
    else if (out[i] === 'none') out[i] = 'up'
  }
  return out
}

/** Share of reports in the history that saw the service answering, or null with no data. */
export function uptimePercent(history, index) {
  const list = (Array.isArray(history) ? history : []).filter((e) => typeof e?.s === 'string' && e.s.length > index)
  if (!list.length) return null
  return Math.round((list.filter((e) => e.s[index] === '1').length / list.length) * 1000) / 10
}

export const HEARTBEAT_STALE_AFTER_MIN = 30
export const PC_QUIET_AFTER_MIN = 60

/**
 * The heartbeat chart: 24 hours of 5-minute slots showing whether the owner's PC and Google Cloud heard each other (they share no network link; each leaves signed notes in a private mailbox).
 * cells: 'mutual' (both heard a fresh note), 'partial' (one side only), 'none' (nothing recorded). A quiet PC is not an outage: it runs on a private computer that may be off.
 */
export function heartbeatView(hb, now = Date.now()) {
  if (!hb || typeof hb.cells !== 'string') return { state: 'unknown', text: 'The heartbeat could not be read in the last check.', detail: '', cells: [], label: 'Heartbeat unavailable' }
  const names = { 0: 'none', 1: 'partial', 2: 'mutual' }
  const cells = [...hb.cells].map((c) => names[c] ?? 'none')
  const cloudAge = ageMinutes(hb.lastCloudStep, now)
  const pcHeardAge = ageMinutes(hb.lastHeard?.cloud, now)       // when the PC last heard the cloud
  const cloudHeardAge = ageMinutes(hb.lastHeard?.pc, now)       // when the cloud last heard the PC
  let state = 'ok'
  if (!(cloudAge <= HEARTBEAT_STALE_AFTER_MIN)) state = 'stale'
  else if (!(Math.min(pcHeardAge, cloudHeardAge) <= PC_QUIET_AFTER_MIN)) state = 'quiet'
  const detail = state === 'stale'
    ? `The cloud side has not reported for ${ageText(hb.lastCloudStep, now).replace(' ago', '')}, so this chart is out of date.`
    : state === 'quiet'
      ? `The PC was last heard ${ageText(hb.lastHeard?.pc, now)}. It runs on a private computer, so a quiet PC is not an outage.`
      : `The cloud last heard the PC ${ageText(hb.lastHeard?.pc, now)}; the PC last heard the cloud ${ageText(hb.lastHeard?.cloud, now)}.`
  return { state, text: String(hb.sentence ?? ''), detail, cells, label: `Heartbeat, last 24 hours: ${hb.mutualPct ?? '?'} percent of slots heard by both sides` }
}
