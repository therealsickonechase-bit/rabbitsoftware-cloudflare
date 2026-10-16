// Research layer of the hub: which public sources feed the rabbit web, how the data flows, and a safe on-demand search.
// Every call is a GET to a fixed public host with a fixed path template. The query text is the only variable part and is
// URL-encoded. Results are NOT stored: the owner's research agents ingest records into Supabase through the signed ingest.

export const SOURCES = Object.freeze({
  pubmed: {
    name: 'PubMed', host: 'https://eutils.ncbi.nlm.nih.gov', home: 'https://pubmed.ncbi.nlm.nih.gov/',
    about: 'Biomedical literature from the US National Library of Medicine (NCBI E-utilities).',
    gives: 'article titles, journals, dates and PubMed links',
  },
  europepmc: {
    name: 'Europe PMC', host: 'https://www.ebi.ac.uk', home: 'https://europepmc.org/',
    about: 'Papers and preprints from Europe, wider than PubMed alone.',
    gives: 'titles, years, journals, DOIs',
  },
  clinicaltrials: {
    name: 'ClinicalTrials.gov', host: 'https://clinicaltrials.gov', home: 'https://clinicaltrials.gov/',
    about: 'Registered clinical studies (US National Library of Medicine).',
    gives: 'trial ids, titles and recruiting status',
  },
  openfda: {
    name: 'openFDA', host: 'https://api.fda.gov', home: 'https://open.fda.gov/',
    about: 'US FDA public drug adverse-event reports. Reports are not proof a drug caused an event.',
    gives: 'the most reported reactions for a drug name',
  },
  openalex: {
    name: 'OpenAlex', host: 'https://api.openalex.org', home: 'https://openalex.org/',
    about: 'Open catalogue of scholarly works in every field: journal papers and preprints (including arXiv), with venues and citation counts. Use it for physics, engineering and anything outside medicine.',
    gives: 'titles, years, venues, DOIs and citation counts',
  },
  inspirehep: {
    name: 'INSPIRE-HEP', host: 'https://inspirehep.net', home: 'https://inspirehep.net/',
    about: 'High-energy physics literature (CERN, DESY, Fermilab), including arXiv preprints: gravity, antimatter, cosmology, particle physics.',
    gives: 'titles, dates, arXiv or DOI links and citation counts',
  },
})
export const SOURCE_IDS = Object.keys(SOURCES)

/** The data flow, in order. The same story is drawn in the platform graph (data/platform-graph.json in qa-audit). */
export const FLOW = Object.freeze([
  { step: 1, from: 'Public sources (PubMed, Europe PMC, ClinicalTrials.gov, ClinVar, openFDA, NIH RePORTER, St. Jude)', to: 'Research agents on the owner\'s computer', what: 'Agents search the documented public APIs and keep records locally (corpus, topics, summaries).' },
  { step: 2, from: 'Research agents', to: 'Maxwell chain', what: 'Findings are anchored as hashes. The chain proves what was found and when, not that it is true.' },
  { step: 3, from: 'Research agents', to: 'RabbitOS app (Supabase)', what: 'The signed ingest writes public records: topics, runs, records (id, source, title, link) and labelled AI summaries. Personal data is never included.' },
  { step: 4, from: 'RabbitOS app', to: 'Data hub, Ask RabbitOS, research page', what: 'Public, read-only datasets: research_records, research_topics, research_runs, research_summaries.' },
  { step: 5, from: 'Data hub and chain', to: 'Hub MCP and the guest shell', what: 'Assistants read the same records through data_rows, research_feed and chain_events; the shell reaches only the hub and the public app.' },
  { step: 6, from: 'Any assistant', to: 'Public sources, on demand', what: 'research_search asks one source live through the hub when the stored records are not enough. Nothing is saved; the owner\'s agents decide what to ingest.' },
])

const TEXT = /^[^\u0000-\u001f\u007f]{2,120}$/
const clean = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const enc = encodeURIComponent

/** Fixed request templates: one or two GETs per source. Returns [{origin, path}] builders. */
export const PLANS = Object.freeze({
  pubmed: (q, n) => ({
    first: { origin: SOURCES.pubmed.host, path: `/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&tool=rabbitos-hub&retmax=${n}&term=${enc(q)}` },
    then: (json) => {
      const ids = (json?.esearchresult?.idlist ?? []).filter((id) => /^\d{1,10}$/.test(id))
      return ids.length ? { origin: SOURCES.pubmed.host, path: `/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&tool=rabbitos-hub&id=${ids.join(',')}` } : null
    },
  }),
  europepmc: (q, n) => ({ first: { origin: SOURCES.europepmc.host, path: `/europepmc/webservices/rest/search?format=json&resultType=lite&pageSize=${n}&query=${enc(q)}` } }),
  clinicaltrials: (q, n) => ({ first: { origin: SOURCES.clinicaltrials.host, path: `/api/v2/studies?format=json&pageSize=${n}&query.term=${enc(q)}` } }),
  openfda: (q, n) => ({ first: { origin: SOURCES.openfda.host, path: `/drug/event.json?limit=${n}&count=patient.reaction.reactionmeddrapt.exact&search=patient.drug.openfda.generic_name:${enc('"' + q.replace(/["\\]/g, '') + '"')}` } }),
  // Physics and general science (added with research_link): one GET each, the query text is the only variable part.
  openalex: (q, n) => ({ first: { origin: SOURCES.openalex.host, path: `/works?search=${enc(q)}&per-page=${n}&select=id,title,publication_year,doi,type,cited_by_count,primary_location` } }),
  inspirehep: (q, n) => ({ first: { origin: SOURCES.inspirehep.host, path: `/api/literature?q=${enc(q)}&size=${n}&fields=titles,arxiv_eprints,dois,control_number,preprint_date,citation_count` } }),
})

/** Reduce each source's answer to a few plain fields. Unknown shapes give an empty list, never an exception. */
export const NORMALIZE = Object.freeze({
  pubmed(summary) {
    const r = summary?.result ?? {}
    return (r.uids ?? []).filter((id) => /^\d{1,10}$/.test(id)).map((id) => ({
      id, title: clean(r[id]?.title), journal: clean(r[id]?.fulljournalname, 120), date: clean(r[id]?.pubdate, 30), url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    }))
  },
  europepmc(json) {
    return (json?.resultList?.result ?? []).map((x) => ({
      id: clean(`${x.source ?? ''}:${x.id ?? ''}`, 40), title: clean(x.title), journal: clean(x.journalTitle, 120), date: clean(x.pubYear, 10),
      url: x.doi ? `https://doi.org/${clean(x.doi, 100)}` : x.id && /^[A-Z]{3}$/.test(x.source ?? '') ? `https://europepmc.org/article/${x.source}/${enc(x.id)}` : null,
    }))
  },
  clinicaltrials(json) {
    return (json?.studies ?? []).map((s) => {
      const id = s?.protocolSection?.identificationModule?.nctId
      return { id: clean(id, 20), title: clean(s?.protocolSection?.identificationModule?.briefTitle), status: clean(s?.protocolSection?.statusModule?.overallStatus, 40), url: /^NCT\d{8}$/.test(id ?? '') ? `https://clinicaltrials.gov/study/${id}` : null }
    })
  },
  openfda(json) {
    return (json?.results ?? []).map((x) => ({ reaction: clean(x.term, 120), reports: Number.isFinite(x.count) ? x.count : null }))
  },
  openalex(json) {
    return (json?.results ?? []).flatMap((w) => {
      const id = /^https:\/\/openalex\.org\/(W\d{1,12})$/.exec(String(w?.id ?? ''))?.[1]
      const title = clean(w?.title)
      if (!id || !title) return []
      const doi = /^https:\/\/doi\.org\/10\.[^\s]{3,150}$/.test(String(w?.doi ?? '')) ? String(w.doi) : null
      return [{ id: `openalex:${id}`, title, journal: clean(w?.primary_location?.source?.display_name, 120), date: clean(w?.publication_year, 10), citations: Number.isFinite(w?.cited_by_count) ? w.cited_by_count : null, url: doi ?? `https://openalex.org/${id}` }]
    })
  },
  inspirehep(json) {
    return (json?.hits?.hits ?? []).flatMap((h) => {
      const m = h?.metadata ?? {}
      const id = String(m.control_number ?? '')
      const title = clean(m.titles?.[0]?.title)
      if (!/^\d{1,10}$/.test(id) || !title) return []
      const arxiv = String(m.arxiv_eprints?.[0]?.value ?? '')
      const doi = String(m.dois?.[0]?.value ?? '')
      const url = /^[A-Za-z0-9.\-/]{5,40}$/.test(arxiv) ? `https://arxiv.org/abs/${arxiv}` : /^10\.[^\s]{3,150}$/.test(doi) ? `https://doi.org/${doi}` : `https://inspirehep.net/literature/${id}`
      return [{ id: `inspire:${id}`, title, date: clean(m.preprint_date, 10), citations: Number.isFinite(m.citation_count) ? m.citation_count : null, url }]
    })
  },
})

export function validateSearch(args) {
  if (!SOURCE_IDS.includes(args.source)) return `source must be one of: ${SOURCE_IDS.join(', ')}`
  if (typeof args.query !== 'string' || !TEXT.test(args.query.trim())) return 'query must be 2 to 120 printable characters on one line'
  if (enc(args.query.trim()).length > 180) return 'query is too long once encoded; use plainer words'
  if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 20)) return 'limit must be 1 to 20'
  return null
}

const APP = 'https://app.rabbitsoftware.io'
const STATUS_BUCKET = 'https://rabbitsoftware-io-status-public.storage.googleapis.com'
export const LINK_DEFAULT_SOURCES = Object.freeze(['openalex', 'inspirehep', 'europepmc', 'pubmed'])
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** One live search, with failures kept inside the result so one slow source never hides the others. */
async function liveSearch(id, q, n, fetchText) {
  const plan = PLANS[id](q, n)
  const get = async (req) => {
    const r = await fetchText(req.origin, req.path)
    if (r.status !== 200) throw new Error(`${SOURCES[id].name} returned ${r.status}`)
    return JSON.parse(r.text)
  }
  try {
    let json = await get(plan.first)
    if (plan.then) { const next = plan.then(json); json = next ? await get(next) : null }
    return { source: id, name: SOURCES[id].name, items: json ? NORMALIZE[id](json).slice(0, n) : [] }
  } catch (e) { return { source: id, name: SOURCES[id].name, items: [], error: String(e.message).startsWith(SOURCES[id].name) ? e.message : `${SOURCES[id].name} could not be read right now` } }
}

/** What RabbitOS already holds that matches (the data hub's own text search over research_records). */
async function storedSearch(q, n, fetchText) {
  try {
    const r = await fetchText(APP, `/api/data/research_records?limit=${n}&q=${enc(q)}`)
    if (r.status !== 200) return { rows: [], error: `the data hub returned ${r.status}` }
    const rows = (JSON.parse(r.text).rows ?? []).slice(0, n).map((x) => ({ id: clean(x.id, 80), source: clean(x.source, 30), title: clean(x.title, 220), url: /^https:\/\//.test(x.url ?? '') ? clean(x.url, 300) : null, firstSeenAt: Number.isFinite(Date.parse(x.first_seen_at)) ? new Date(x.first_seen_at).toISOString() : null }))
    return { rows }
  } catch { return { rows: [], error: 'the data hub could not be read right now' } }
}

/** The live research file the status job writes in Google Cloud: counts, freshness and the newest Maxwell research anchor. */
async function googleCloudState(fetchText) {
  try {
    const r = await fetchText(STATUS_BUCKET, '/status/research-live.json')
    if (r.status !== 200) return null
    const d = JSON.parse(r.text)
    return d?.version === 1 ? d : null
  } catch { return null }
}

/**
 * The cross-linked answer for a topic: live public sources, what RabbitOS stores, the Maxwell research anchor and the Google Cloud copies. `fetchText(origin, path)` returns {status, text}.
 * Shared by the hub tool research_link and the Research Agent (A2A), so both give the same answer. Returns {error} for bad input, otherwise the report object.
 */
export async function researchLinkReport(args, fetchText) {
  const bad = validateSearch({ source: SOURCE_IDS[0], query: args?.query, limit: args?.limit })
  if (bad) return { error: bad }
  if (args.sources !== undefined && (!Array.isArray(args.sources) || !args.sources.length || args.sources.length > 4 || args.sources.some((x) => !SOURCE_IDS.includes(x)) || new Set(args.sources).size !== args.sources.length)) return { error: `sources must be 1 to 4 different ids from: ${SOURCE_IDS.join(', ')}` }
  const q = args.query.trim(), n = args.limit ?? 4
  const ids = args.sources ?? [...LINK_DEFAULT_SOURCES]
  const [live, stored, gc] = await Promise.all([Promise.all(ids.map((id) => liveSearch(id, q, n, fetchText))), storedSearch(q, n, fetchText), googleCloudState(fetchText)])
  const holdTitles = new Set(stored.rows.map((r) => norm(r.title))), holdUrls = new Set(stored.rows.map((r) => r.url).filter(Boolean))
  const anchor = gc?.maxwell ?? null
  const anchorMs = anchor ? Date.parse(anchor.time) : NaN
  const liveOut = live.map((l) => ({ ...l, items: l.items.map((it) => ({ ...it, inRabbitOS: holdUrls.has(it.url) || holdTitles.has(norm(it.title)) })) }))
  const storedOut = stored.rows.map((r) => {
    const seen = Date.parse(r.firstSeenAt)
    const anchored = anchor && Number.isFinite(seen) && Number.isFinite(anchorMs) ? seen <= anchorMs : null
    return { ...r, maxwell: anchored === null ? { status: 'unknown', why: 'no Maxwell anchor was readable' } : anchored
      ? { status: 'covered', block: anchor.block, root: anchor.root, recordsInAnchor: anchor.count, minedAt: anchor.time }
      : { status: 'not yet', why: `first seen after block ${anchor.block} (${anchor.time}); the next research anchor will cover it` } }
  })
  return {
    query: q,
    live: liveOut,
    rabbitos: { records: storedOut, matchesShown: storedOut.length, ...(stored.error ? { error: stored.error } : {}), read_more: 'data_rows with dataset research_records and q, or research_feed' },
    maxwell: anchor ? { latestResearchAnchor: anchor, meaning: 'A record first seen before minedAt was in the public record set whose Merkle root this block holds. The chain proves existence and time, not that a claim is true.' } : { unavailable: true },
    googleCloud: gc ? { researchLiveFile: `${STATUS_BUCKET}/status/research-live.json`, refreshedAt: gc.generatedAt, publicRecords: gc.total, topicsExplored: gc.topics?.explored ?? null, maxwellMirror: anchor ? { chainLength: anchor.chainLength, headHash: anchor.headHash } : null, publicLedger: 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/ledger/chain_head.json' } : { unavailable: true },
    caution: 'Results are pointers to public records, not endorsements. Every field has speculative and fringe papers; check the venue, the citations and whether a result was replicated.',
    next: "To keep findings, the owner's agents ingest them (python physics_research.py --query \"...\" then the research sync). Nothing was stored by this call.",
  }
}

export const RESEARCH_TOOLS = (helpers) => {
  const { asText, fail, getText, UNTRUSTED } = helpers
  return [
    {
      name: 'research_sources', description: 'The research web: which public sources feed it (PubMed, Europe PMC, ClinicalTrials.gov, openFDA, OpenAlex, INSPIRE-HEP), how data flows from them through the agents, the chain and Supabase to the data hub and the shell, and which tool reads each stage.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return asText({
          sources: SOURCE_IDS.map((id) => ({ id, ...SOURCES[id], live_search: true })),
          also_ingested_by_agents: ['ClinVar', 'NIH RePORTER', 'St. Jude public research'],
          flow: FLOW,
          read_stored_research_with: ['research_feed', 'data_rows (research_records, research_topics, research_runs, research_summaries)', 'concept_lookup', 'chain_events'],
          search_live_with: 'research_search (one source) or research_link (several sources, plus RabbitOS, Maxwell and Google Cloud)',
          map: 'https://app.rabbitsoftware.io/guide',
          rules: ['Public sources only.', 'Personal data (EEG, wearables, labs) never enters this web.', 'AI summaries are interpretation, not findings.', 'A chain entry proves existence and time, not truth.'],
        })
      },
    },
    {
      name: 'research_link', description: 'Search for a topic across the whole research web at once and link the answers: (1) public sources live (default OpenAlex, INSPIRE-HEP, Europe PMC, PubMed; physics and other fields work too), (2) what RabbitOS already stores about it (the data hub), (3) whether each stored record is covered by the Maxwell chain research anchor, and (4) the Google Cloud copies (live research file, public chain mirror). Read only; nothing is stored.' + UNTRUSTED,
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 120 }, sources: { type: 'array', items: { type: 'string', enum: SOURCE_IDS }, minItems: 1, maxItems: 4 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false },
      async run(args, ctx) {
        const out = await researchLinkReport(args, (origin, path) => getText(ctx.fetchImpl, origin, path, 12_000))
        return out.error ? fail(out.error) : asText(out)
      },
    },
    {
      name: 'research_search', description: 'Search one public research source live (pubmed, europepmc, clinicaltrials, openfda, openalex, inspirehep) for a topic. Returns a short list with links. Nothing is stored; use it when the stored records do not cover the question.' + UNTRUSTED,
      inputSchema: { type: 'object', properties: { source: { type: 'string', enum: SOURCE_IDS }, query: { type: 'string', minLength: 2, maxLength: 120 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['source', 'query'], additionalProperties: false },
      async run(args, ctx) {
        const bad = validateSearch(args)
        if (bad) return fail(bad)
        const q = args.query.trim(), n = args.limit ?? 5
        const plan = PLANS[args.source](q, n)
        const get = async (req) => {
          const r = await getText(ctx.fetchImpl, req.origin, req.path, 12_000)
          if (r.status !== 200) throw new Error(`${SOURCES[args.source].name} returned ${r.status}`)
          return JSON.parse(r.text)
        }
        let json
        try {
          json = await get(plan.first)
          if (plan.then) { const next = plan.then(json); json = next ? await get(next) : null }
        } catch (e) { return fail(String(e.message).startsWith(SOURCES[args.source].name) ? e.message : `${SOURCES[args.source].name} could not be read right now`) }
        const items = json ? NORMALIZE[args.source](json).slice(0, n) : []
        return asText({ source: SOURCES[args.source].name, query: q, count: items.length, items, stored: false, home: SOURCES[args.source].home, next: 'To keep a finding, the owner\'s research agents ingest it; AI summaries stay labelled as interpretation.' })
      },
    },
  ]
}
