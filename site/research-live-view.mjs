// The logic behind the "Live from the agents" section of research.html: what the two public files say, and how stale they are. Pure, so tests can run it.
// The files are rewritten in Google Cloud every few minutes (status/research-live.json by the status job, status/dna-live.json by the owner's PC after each comparison), so a new finding
// shows up on the website WITHOUT deploying the website. Everything in them comes from outside sources or from agents, so the page shows it as plain text and only links to known hosts.
import { ageMinutes, ageText } from './status-view.mjs'

const BASE = 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/'
export const LIVE_URL = BASE + 'research-live.json'
export const DNA_URL = BASE + 'dna-live.json'
export const STALE_AFTER_MIN = 45
export const QUIET_AFTER_HOURS = 24

export const SOURCE_LABEL = Object.freeze({
  trial: 'Trials', pubmed: 'PubMed', stjude: 'St. Jude papers', stjude_dataset: 'St. Jude datasets', europepmc: 'Europe PMC', nih_grant: 'NIH grants', clinvar: 'ClinVar',
  ncbi_datasets: 'NCBI sequences', topic_summary: 'Topic summaries', crispr_guide: 'CRISPR guides', crispr_trial: 'CRISPR trials', crispr_paper: 'CRISPR papers',
  crispr_preprint: 'CRISPR preprints', brain_paper: 'Brain / EEG papers', brain_preprint: 'Brain / EEG preprints', physics_paper: 'Physics papers', physics_preprint: 'Physics preprints',
})
const LINK_HOSTS = [/(^|\.)nih\.gov$/, /(^|\.)ebi\.ac\.uk$/, /^europepmc\.org$/, /^clinicaltrials\.gov$/, /(^|\.)stjude\.org$/, /(^|\.)stjude\.cloud$/, /^doi\.org$/, /^arxiv\.org$/, /^inspirehep\.net$/, /^openalex\.org$/, /^(www\.)?(bio|med)rxiv\.org$/]

/** A link is passed on only if it is https and its host is a known public research site. Anything else is shown as plain text. */
export function safeLink(url) {
  try {
    const u = new URL(String(url))
    return u.protocol === 'https:' && !u.username && !u.password && LINK_HOSTS.some((re) => re.test(u.hostname)) ? u.toString() : null
  } catch { return null }
}

const num = (n) => (Number.isFinite(n) && n >= 0 ? n : null)
const label = (k) => SOURCE_LABEL[k] ?? String(k).replace(/_/g, ' ')

/** @returns {{state: 'ok'|'quiet'|'stale'|'unknown', when: string, total: number|null, sources: object[], topics: string, recent: object[]}} */
export function liveView(data, now = Date.now()) {
  if (!data || data.version !== 1 || typeof data.bySource !== 'object' || !Array.isArray(data.recent)) {
    return { state: 'unknown', when: 'The live findings could not be read just now. Nothing is shown rather than guessing.', total: null, sources: [], topics: '', recent: [] }
  }
  const entries = Object.entries(data.bySource).filter(([, n]) => num(n) !== null).sort((a, b) => b[1] - a[1])
  const top = entries.length ? entries[0][1] : 0
  const sources = entries.map(([key, n]) => ({ key, label: label(key), count: n, pct: top ? Math.max(2, Math.round((n / top) * 100)) : 0 }))
  const ageGen = ageMinutes(data.generatedAt, now)
  const quiet = ageMinutes(data.lastReportAt, now) / 60 > QUIET_AFTER_HOURS
  const state = !(ageGen <= STALE_AFTER_MIN) ? 'stale' : quiet ? 'quiet' : 'ok'
  const when = state === 'stale'
    ? `This list was last refreshed ${ageText(data.generatedAt, now)}, so it may be out of date.`
    : quiet
      ? `The agents last reported ${ageText(data.lastReportAt, now)}. They run on a private computer and in Google Cloud, so a quiet day is not an outage.`
      : `The agents last reported ${ageText(data.lastReportAt, now)}. This list refreshes itself every few minutes.`
  const t = data.topics ?? {}
  const topics = num(t.explored) !== null ? `${t.explored} topics explored${num(t.queued) !== null ? `, ${t.queued} queued` : ''}.` : ''
  const recent = data.recent.slice(0, 12).map((r) => ({ title: String(r.title ?? '').slice(0, 220), source: label(r.source), link: safeLink(r.url), ago: r.seenAt ? ageText(r.seenAt, now) : '' })).filter((r) => r.title)
  return { state, when, total: num(data.total), sources, topics, recent }
}

/** The variant index panel, or null if the file is missing or not in the expected shape. */
export function dnaView(data, now = Date.now()) {
  if (!data || data.version !== 1 || ![data.genes, data.variants, data.kmers].every((n) => num(n) !== null) || typeof data.root !== 'string') return null
  const gaps = Array.isArray(data.coverageGaps) ? data.coverageGaps.filter((g) => /^[A-Z0-9-]{2,12}$/.test(String(g))).slice(0, 40) : []
  const built = data.indexBuiltAt ? ageText(data.indexBuiltAt, now) : null
  const compared = data.updatedAt ? ageText(data.updatedAt, now) : null
  const parts = [`${data.variants.toLocaleString('en-US')} verified pathogenic or likely pathogenic ClinVar variants in ${data.genes} cancer genes, each checked against its RefSeq transcript (index ${data.root.slice(0, 12)}).`]
  if (num(data.researchRecordsChecked) !== null) parts.push(`Compared with ${data.researchRecordsChecked} public research records: ${num(data.variantMentions) ?? 0} name a known variant.`)
  if (num(data.guidesChecked) !== null) parts.push(`${num(data.guidesFlagged) ?? 0} of ${data.guidesChecked} CRISPR guide candidates also occur in another panel gene (a flag, not an off-target score).`)
  const stamp = [built ? `index built ${built}` : null, compared ? `compared ${compared}` : null].filter(Boolean).join(', ')
  return { line: parts.join(' '), stamp: stamp ? stamp[0].toUpperCase() + stamp.slice(1) + '.' : '',
    gaps: gaps.length ? `Genes with known variants and no research record yet (the agents are exploring them): ${gaps.join(', ')}.` : 'Every panel gene with known variants has at least one research record.' }
}

export const SEARCH_ORIGIN = 'https://app.rabbitsoftware.io'

/** The data-hub search for the box on research.html, or null if the words are unusable. */
export function searchUrl(words) {
  const q = String(words ?? '').replace(/\s+/g, ' ').trim()
  return q.length >= 2 && q.length <= 120 && !/[\u0000-\u001f]/.test(q) ? `${SEARCH_ORIGIN}/api/data/research_records?limit=20&q=${encodeURIComponent(q)}` : null
}

/**
 * Turns the data hub rows into lines for the page and ties each to the Maxwell chain: a record first seen at or before the newest research anchor
 * (`live.maxwell.time`) was in the public record set that block's Merkle root covers. Anything else is "not yet" or "unknown".
 */
export function searchView(data, live, now = Date.now()) {
  const rows = Array.isArray(data?.rows) ? data.rows : null
  if (!rows) return { summary: 'The search could not be read just now.', rows: [] }
  const m = live?.version === 1 ? live.maxwell : null
  const anchorMs = m ? Date.parse(m.time) : NaN
  const out = rows.slice(0, 20).map((r) => {
    const seen = Date.parse(r.first_seen_at)
    const maxwell = !Number.isFinite(anchorMs) || !Number.isFinite(seen) ? 'Maxwell: unknown' : seen <= anchorMs ? `Covered by Maxwell block ${m.block}` : 'Not yet in a Maxwell block'
    return { title: String(r.title ?? '').slice(0, 220), source: label(r.source), link: safeLink(r.url), ago: Number.isFinite(seen) ? ageText(r.first_seen_at, now) : '', maxwell }
  }).filter((r) => r.title)
  const anchorText = Number.isFinite(anchorMs) ? ` Newest Maxwell research anchor: block ${m.block}, ${m.count} records, mined ${ageText(m.time, now)}.` : ''
  return { summary: `${out.length} matching record${out.length === 1 ? '' : 's'} in the shared research store.${anchorText}`, rows: out }
}
