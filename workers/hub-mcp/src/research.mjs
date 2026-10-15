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
})

export function validateSearch(args) {
  if (!SOURCE_IDS.includes(args.source)) return `source must be one of: ${SOURCE_IDS.join(', ')}`
  if (typeof args.query !== 'string' || !TEXT.test(args.query.trim())) return 'query must be 2 to 120 printable characters on one line'
  if (enc(args.query.trim()).length > 180) return 'query is too long once encoded; use plainer words'
  if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 20)) return 'limit must be 1 to 20'
  return null
}

export const RESEARCH_TOOLS = (helpers) => {
  const { asText, fail, getText, UNTRUSTED } = helpers
  return [
    {
      name: 'research_sources', description: 'The research web: which public sources feed it (PubMed, Europe PMC, ClinicalTrials.gov, openFDA), how data flows from them through the agents, the chain and Supabase to the data hub and the shell, and which tool reads each stage.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return asText({
          sources: SOURCE_IDS.map((id) => ({ id, ...SOURCES[id], live_search: true })),
          also_ingested_by_agents: ['ClinVar', 'NIH RePORTER', 'St. Jude public research'],
          flow: FLOW,
          read_stored_research_with: ['research_feed', 'data_rows (research_records, research_topics, research_runs, research_summaries)', 'concept_lookup', 'chain_events'],
          search_live_with: 'research_search',
          map: 'https://app.rabbitsoftware.io/guide',
          rules: ['Public sources only.', 'Personal data (EEG, wearables, labs) never enters this web.', 'AI summaries are interpretation, not findings.', 'A chain entry proves existence and time, not truth.'],
        })
      },
    },
    {
      name: 'research_search', description: 'Search one public research source live (pubmed, europepmc, clinicaltrials, openfda) for a topic. Returns a short list with links. Nothing is stored; use it when the stored records do not cover the question.' + UNTRUSTED,
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
