// RabbitOS Research Agent as an A2A (Agent2Agent) server for Cloud Run, so it can be discovered through the Google Cloud Agent Registry and called by other agents.
// It wraps the same read-only live search the hub offers: PubMed, Europe PMC, ClinicalTrials.gov and openFDA, each a GET to a fixed public host. It stores nothing and holds no secrets.
//   GET  /.well-known/agent-card.json   the agent card (also served at /.well-known/agent.json)
//   POST /                              JSON-RPC 2.0: message/send  (a text question, or a data part {source, query, limit})
//   GET  /health
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { NORMALIZE, PLANS, SOURCES, SOURCE_IDS, researchLinkReport, validateSearch } from './research.mjs'

export const VERSION = '1.3.0'
// The public slice of the toolbox, written by rabbit-web/scripts/toolbox-publish.mjs next to the status feed: the commands a guest may see, links to files in the two public repositories,
// and the root hash and counts of the whole bundle. This service never reads the private toolbox: it has no credentials and no sign-in, so it can only serve what is already public.
export const TOOLBOX_URL = 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/toolbox-public.json'
const GITHUB_PREFIX = 'https://github.com/therealsickonechase-bit/'
const MAX_BODY = 16_000

export function agentCard(baseUrl) {
  return {
    name: 'RabbitOS Research Agent',
    description: 'Searches public biomedical research live (PubMed, Europe PMC, ClinicalTrials.gov, openFDA) and returns short lists with links; it also looks up the public RabbitOS commands and the files behind them (the toolbox). Read only: it stores nothing, holds no secrets and never sees personal data. Results are pointers to public records, not medical advice.',
    url: baseUrl,
    version: VERSION,
    protocolVersion: '0.3.0',
    preferredTransport: 'JSONRPC',
    provider: { organization: 'RabbitSoftware', url: 'https://rabbitsoftware.io' },
    documentationUrl: 'https://github.com/therealsickonechase-bit/rabbitsoftware-cloudflare/tree/main/workers/agent-a2a',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      { id: 'search-literature', name: 'Search the literature', description: 'Find papers on a topic in PubMed, Europe PMC, OpenAlex (all fields) or INSPIRE-HEP (physics).', tags: ['research', 'pubmed', 'europepmc', 'literature'], examples: ['pubmed: BRCA1 breast cancer', 'Find recent papers on SLC6A4 in Europe PMC'] },
      { id: 'search-trials', name: 'Search clinical trials', description: 'Find registered studies on ClinicalTrials.gov.', tags: ['research', 'clinicaltrials'], examples: ['clinical trials for glioma'] },
      { id: 'drug-adverse-events', name: 'Most reported drug reactions', description: 'The reactions most often reported for a drug in openFDA. Reports are not proof that a drug caused an event.', tags: ['research', 'openfda', 'safety'], examples: ['openfda: metformin'] },
      { id: 'research-link', name: 'Search and link to RabbitOS, Maxwell and Google Cloud', description: 'Search several public sources at once (OpenAlex, INSPIRE-HEP, Europe PMC, PubMed), then show what RabbitOS already stores about the topic, whether the Maxwell chain research anchor covers it, and the Google Cloud copies. Works for physics as well as medicine.', tags: ['research', 'link', 'maxwell', 'google-cloud', 'physics'], examples: ['link: antigravity', 'link: antihydrogen gravity ALPHA-g', 'link: BRCA1 PARP'] },
      { id: 'toolbox', name: 'Toolbox: platform commands and files', description: 'Look up the RabbitOS commands a guest may use and the public files behind them (with links), see which toolbox bundle they come from, and ask what each agent can do (the task kinds a worker runs and the actions it carries out). Owner-only commands and private files are not listed.', tags: ['toolbox', 'commands', 'catalog', 'files', 'agents', 'capabilities'], examples: ['toolbox: chain', 'which commands check the public chain?', 'what can the task worker do?'] },
      { id: 'list-sources', name: 'List the sources', description: 'Which public sources this agent can search.', tags: ['research'], examples: ['what sources can you search?'] },
    ],
  }
}

/** Decide what to do with a message: a data part wins, otherwise read the words. */
export function interpret(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const data = parts.find((p) => p?.kind === 'data' && p.data && typeof p.data === 'object')?.data
  const data0 = data
  if (data && data.skill !== 'toolbox' && data.skill !== 'research-link') return { action: 'search', source: data.source, query: data.query, limit: data.limit }
  const text = parts.filter((p) => p?.kind === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ').trim()
  if (data0?.skill === 'research-link') return { action: 'link', query: String(data0.query ?? '').slice(0, 120), sources: Array.isArray(data0.sources) ? data0.sources.slice(0, 4) : undefined }
  if (!text && data0?.skill === 'toolbox') return { action: 'toolbox', query: String(data0.query ?? '').slice(0, 120) }
  if (!text) return { action: 'error', error: 'send a text question or a data part {source, query, limit}' }
  if (/\b(what|which|list)\b.*\bsources?\b|\bsources?\b.*\b(can|do)\b/i.test(text) && !/:/.test(text)) return { action: 'sources' }
  if (data0?.skill === 'toolbox') return { action: 'toolbox', query: String(data0.query ?? '').slice(0, 120) }
  const linkMatch = /^\s*link(?:ed)?\s*:\s*(.+)$/i.exec(text)
  if (linkMatch) return { action: 'link', query: linkMatch[1].trim().slice(0, 120) }
  if (/\b(toolbox|catalog|commands?|capabilit\w*|task kinds?|workers?|explorers?)\b/i.test(text) && !/^(pubmed|europepmc|clinicaltrials|openfda)\s*:/i.test(text)) return { action: 'toolbox', query: text.slice(0, 160) }
  let source = SOURCE_IDS.find((id) => new RegExp(`\\b${id}\\b`, 'i').test(text))
  if (!source) {
    if (/europe\s*pmc/i.test(text)) source = 'europepmc'
    else if (/clinical\s*trials?|\btrials?\b|\bstud(y|ies)\b/i.test(text)) source = 'clinicaltrials'
    else if (/\bfda\b|adverse|side effects?|reactions?/i.test(text)) source = 'openfda'
    else if (/\b(physics|gravity|antigravity|antimatter|antihydrogen|cosmolog\w*|quantum|arxiv|inspire|particle|relativity)\b/i.test(text)) source = 'inspirehep'
    else source = 'pubmed'
  }
  const query = text.replace(/^[a-z ]{2,20}:\s*/i, '').replace(/\b(please|find|search( for)?|show( me)?|look up|recent|papers?|articles?|on|about|for|in|using|from|pubmed|europe\s*pmc|europepmc|clinicaltrials?(\.gov)?|clinical trials?|openfda|fda)\b/gi, ' ').replace(/\s+/g, ' ').trim() || text.slice(0, 120)
  return { action: 'search', source, query: query.slice(0, 120), limit: 5 }
}

async function run(plan, fetchImpl) {
  const bad = validateSearch(plan)
  if (bad) return { error: bad }
  const q = plan.query.trim(), n = plan.limit ?? 5
  const p = PLANS[plan.source](q, n)
  const get = async (req) => {
    const res = await fetchImpl(new URL(req.path, req.origin).toString(), { headers: { Accept: 'application/json', 'User-Agent': 'rabbitos-research-agent/1.0 (+https://rabbitsoftware.io)' }, signal: AbortSignal.timeout(12_000) })
    if (!res.ok) throw new Error(`${SOURCES[plan.source].name} returned ${res.status}`)
    return res.json()
  }
  try {
    let json = await get(p.first)
    if (p.then) { const next = p.then(json); json = next ? await get(next) : null }
    const items = json ? NORMALIZE[plan.source](json).slice(0, n) : []
    return { source: SOURCES[plan.source].name, query: q, count: items.length, items, home: SOURCES[plan.source].home }
  } catch (e) { return { error: String(e.message).startsWith(SOURCES[plan.source].name) ? e.message : `${SOURCES[plan.source].name} could not be read right now` } }
}

const STOP = new Set(['toolbox', 'tool', 'command', 'commands', 'catalog', 'the', 'for', 'how', 'what', 'which', 'show', 'list', 'find', 'run', 'use', 'can', 'you', 'that', 'with', 'and', 'are', 'does', 'any', 'all', 'please', 'platform', 'files', 'file'])

/** The toolbox skill: a keyword lookup over the public slice. Only fixed fields are returned, and only links into the public GitHub repositories. */
async function toolbox(query, fetchImpl) {
  let slice
  try {
    const res = await fetchImpl(TOOLBOX_URL, { headers: { Accept: 'application/json', 'User-Agent': 'rabbitos-research-agent/1.1 (+https://rabbitsoftware.io)' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`status ${res.status}`)
    slice = await res.json()
  } catch { return { error: 'the toolbox listing could not be read right now' } }
  if (slice?.version !== 1 || !Array.isArray(slice.commands)) return { error: 'the toolbox listing is not in the expected shape' }
  const safe = slice.commands.slice(0, 500).map((c) => ({
    id: String(c.id ?? '').slice(0, 80), group: String(c.group ?? '').slice(0, 80), label: String(c.label ?? '').slice(0, 120), command: String(c.command ?? '').slice(0, 400), description: String(c.description ?? '').slice(0, 300),
    files: (Array.isArray(c.files) ? c.files : []).filter((f) => typeof f?.url === 'string' && f.url.startsWith(GITHUB_PREFIX)).slice(0, 5).map((f) => ({ path: String(f.path ?? '').slice(0, 200), url: f.url.slice(0, 300), sha256: String(f.sha256 ?? '').slice(0, 64) })),
  })).filter((c) => c.id)
  const words = String(query ?? '').toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3 && !STOP.has(w))
  const scored = safe.map((c) => {
    const hay = `${c.id} ${c.label} ${c.group} ${c.description} ${c.command}`.toLowerCase()
    return { c, score: words.reduce((n, w) => n + (hay.includes(w) ? (c.id.toLowerCase().includes(w) || c.label.toLowerCase().includes(w) ? 3 : 1) : 0), 0) }
  })
  const picked = (words.length ? scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score) : scored).slice(0, 8).map((x) => x.c)
  const groups = {}
  for (const c of safe) groups[c.group || 'Other'] = (groups[c.group || 'Other'] ?? 0) + 1
  const asksAgents = /\b(workers?|explorers?|agents?|capabilit\w*|task kinds?)\b/i.test(String(query ?? ''))
  const agentsAll = (Array.isArray(slice.agents) ? slice.agents : []).slice(0, 20).map((a) => ({
    id: String(a.id ?? '').slice(0, 40), where: String(a.where ?? '').slice(0, 160),
    tasks: (Array.isArray(a.tasks) ? a.tasks : []).slice(0, 20).map((t) => ({ kind: String(t.kind ?? '').slice(0, 40), about: String(t.about ?? '').slice(0, 200), params: Object.fromEntries(Object.entries(t.params && typeof t.params === 'object' ? t.params : {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 80)])) })),
    actions: (Array.isArray(a.actions) ? a.actions : []).slice(0, 20).map((x) => ({ id: String(x.id ?? '').slice(0, 40), about: String(x.about ?? '').slice(0, 200), target: String(x.target ?? '').slice(0, 80) })),
  })).filter((a) => a.id)
  const q = String(query ?? '').toLowerCase()
  const named = agentsAll.filter((a) => q.includes(a.id.replace(/_/g, ' ')) || q.includes(a.id))
  const agents = asksAgents ? (named.length ? named : agentsAll) : []
  return { root: String(slice.root ?? '').slice(0, 64), generatedAt: String(slice.generatedAt ?? '').slice(0, 40), counts: { files: Number(slice.counts?.files) || 0, commands: Number(slice.counts?.commands) || 0, publicCommands: safe.length },
    query: words.join(' '), groups, commands: asksAgents && !words.some((w) => !['worker', 'workers', 'explorer', 'agent', 'agents', 'task', 'kinds', 'kind', 'capabilities', 'capability', 'research', 'cloud', 'explorer', 'do', 'does'].includes(w)) ? [] : picked, agents }
}

const reply = (id, parts) => ({ jsonrpc: '2.0', id, result: { kind: 'message', role: 'agent', messageId: randomUUID(), parts } })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

/** Handles one JSON-RPC request object. Pure apart from the fetch it is given. */
export async function handleRpc(body, fetchImpl = fetch) {
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(body?.id, -32600, 'not a JSON-RPC 2.0 request')
  if (body.method !== 'message/send') return rpcError(body.id, -32601, 'only message/send is supported (no streaming, tasks or push notifications)')
  const intent = interpret(body.params?.message)
  if (intent.action === 'error') return rpcError(body.id, -32602, intent.error)
  if (intent.action === 'sources') {
    const list = SOURCE_IDS.map((id) => ({ id, name: SOURCES[id].name, about: SOURCES[id].about }))
    return reply(body.id, [{ kind: 'text', text: list.map((s) => `${s.name}: ${s.about}`).join('\n') }, { kind: 'data', data: { sources: list } }])
  }
  if (intent.action === 'link') {
    const fetchText = async (origin, path) => {
      const res = await fetchImpl(new URL(path, origin).toString(), { headers: { Accept: 'application/json', 'User-Agent': 'rabbitos-research-agent/1.3 (+https://rabbitsoftware.io)' }, signal: AbortSignal.timeout(12_000) })
      return { status: res.status, text: (await res.text()).slice(0, 400_000) }
    }
    const report = await researchLinkReport({ query: intent.query, ...(intent.sources ? { sources: intent.sources } : {}), limit: 4 }, fetchText)
    if (report.error) return rpcError(body.id, -32602, report.error)
    const lines = [`Research on "${report.query}":`]
    for (const l of report.live) lines.push(l.error ? `- ${l.name}: ${l.error}` : `- ${l.name}: ${l.items.length} result(s)` + l.items.slice(0, 2).map((it) => `\n    ${it.title ?? it.id}${it.url ? ` - ${it.url}` : ''}${it.inRabbitOS ? ' (already in RabbitOS)' : ''}`).join(''))
    const covered = report.rabbitos.records.filter((r) => r.maxwell.status === 'covered').length
    lines.push(`RabbitOS stores ${report.rabbitos.records.length} matching record(s)${report.rabbitos.records.length ? `; ${covered} covered by the Maxwell research anchor` : ''}${report.rabbitos.error ? ` (${report.rabbitos.error})` : ''}.`)
    lines.push(report.maxwell.latestResearchAnchor ? `Maxwell: block ${report.maxwell.latestResearchAnchor.block} anchors ${report.maxwell.latestResearchAnchor.count} public records (mined ${report.maxwell.latestResearchAnchor.time}). Google Cloud: ${report.googleCloud.publicRecords ?? '?'} public records, refreshed ${report.googleCloud.refreshedAt ?? 'unknown'}.` : 'Maxwell and Google Cloud state could not be read just now.')
    lines.push(report.caution)
    return reply(body.id, [{ kind: 'text', text: lines.join('\n') }, { kind: 'data', data: report }])
  }
  if (intent.action === 'toolbox') {
    const t = await toolbox(intent.query, fetchImpl)
    if (t.error) return reply(body.id, [{ kind: 'text', text: `I could not read the toolbox: ${t.error}` }, { kind: 'data', data: { error: t.error } }])
    const agentLines = t.agents.flatMap((a) => [`${a.id} (${a.where}):`, `  runs: ${a.tasks.map((x) => `${x.kind} [${Object.entries(x.params).map(([k, v]) => `${k}: ${v}`).join('; ')}]`).join('; ')}`, `  carries out: ${a.actions.map((x) => `${x.id} (${x.target})`).join('; ')}`])
    const lines0 = t.commands.map((c, i) => `${i + 1}. ${c.id}: ${c.label}\n   ${c.command}${c.files.length ? `\n   files: ${c.files.map((f) => f.url).join(' ')}` : ''}`)
    const lines = [...lines0, ...(agentLines.length ? ['Agents:', ...agentLines] : [])]
    const head = t.agents.length && !t.commands.length ? `What ${t.agents.length === 1 ? t.agents[0].id : 'the agents'} can do:` : t.commands.length ? (t.query ? `${t.commands.length} command(s) for "${t.query}":` : `${t.counts.publicCommands} commands a guest may use (showing ${t.commands.length}; ask with a topic to narrow it):`) : `No guest command matches "${t.query}". Groups: ${Object.entries(t.groups).map(([g, n]) => `${g} (${n})`).join(', ')}.`
    const foot = `Toolbox bundle ${t.root.slice(0, 12)} (${t.counts.files} files, ${t.counts.commands} commands in all). Owner-only commands and private files are not listed here.`
    return reply(body.id, [{ kind: 'text', text: [head, ...lines, foot].join('\n') }, { kind: 'data', data: t }])
  }
  const out = await run(intent, fetchImpl)
  if (out.error) return reply(body.id, [{ kind: 'text', text: `I could not do that search: ${out.error}` }, { kind: 'data', data: { error: out.error } }])
  const lines = out.items.map((it, i) => `${i + 1}. ${it.title ?? (it.reaction ? `${it.reaction} (${it.reports ?? '?'} reports)` : (it.id ?? JSON.stringify(it).slice(0, 100)))}${it.url ? ` - ${it.url}` : ''}`)
  const text = out.count ? `${out.count} result(s) from ${out.source} for "${out.query}":\n${lines.join('\n')}\nThese are pointers to public records, not medical advice.` : `No results from ${out.source} for "${out.query}".`
  return reply(body.id, [{ kind: 'text', text }, { kind: 'data', data: out }])
}

export function makeServer(fetchImpl = fetch) {
  return createServer(async (req, res) => {
    const send = (status, obj, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)) }
    try {
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]
      const base = process.env.AGENT_URL || `${proto}://${req.headers.host}`
      const path = new URL(req.url, 'http://x').pathname
      if (req.method === 'GET' && path === '/health') return send(200, 'ok', 'text/plain')
      if (req.method === 'GET' && (path === '/.well-known/agent-card.json' || path === '/.well-known/agent.json')) return send(200, agentCard(base))
      if (req.method === 'POST' && (path === '/' || path === '/a2a')) {
        const chunks = []; let size = 0
        for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, rpcError(null, -32600, 'request too large')); chunks.push(c) }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, rpcError(null, -32700, 'invalid JSON')) }
        return send(200, await handleRpc(body, fetchImpl))
      }
      send(404, { error: 'not found' })
    } catch { send(500, rpcError(null, -32603, 'internal error')) }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) makeServer().listen(Number(process.env.PORT) || 8080)
