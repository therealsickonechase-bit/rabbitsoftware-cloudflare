// RabbitOS Research Agent as an A2A (Agent2Agent) server for Cloud Run, so it can be discovered through the Google Cloud Agent Registry and called by other agents.
// It wraps the same read-only live search the hub offers: PubMed, Europe PMC, ClinicalTrials.gov and openFDA, each a GET to a fixed public host. It stores nothing and holds no secrets.
//   GET  /.well-known/agent-card.json   the agent card (also served at /.well-known/agent.json)
//   POST /                              JSON-RPC 2.0: message/send  (a text question, or a data part {source, query, limit})
//   GET  /health
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { NORMALIZE, PLANS, SOURCES, SOURCE_IDS, validateSearch } from './research.mjs'

export const VERSION = '1.0.0'
const MAX_BODY = 16_000

export function agentCard(baseUrl) {
  return {
    name: 'RabbitOS Research Agent',
    description: 'Searches public biomedical research live (PubMed, Europe PMC, ClinicalTrials.gov, openFDA) and returns short lists with links. Read only: it stores nothing, holds no secrets and never sees personal data. Results are pointers to public records, not medical advice.',
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
      { id: 'search-literature', name: 'Search the literature', description: 'Find papers on a topic in PubMed or Europe PMC.', tags: ['research', 'pubmed', 'europepmc', 'literature'], examples: ['pubmed: BRCA1 breast cancer', 'Find recent papers on SLC6A4 in Europe PMC'] },
      { id: 'search-trials', name: 'Search clinical trials', description: 'Find registered studies on ClinicalTrials.gov.', tags: ['research', 'clinicaltrials'], examples: ['clinical trials for glioma'] },
      { id: 'drug-adverse-events', name: 'Most reported drug reactions', description: 'The reactions most often reported for a drug in openFDA. Reports are not proof that a drug caused an event.', tags: ['research', 'openfda', 'safety'], examples: ['openfda: metformin'] },
      { id: 'list-sources', name: 'List the sources', description: 'Which public sources this agent can search.', tags: ['research'], examples: ['what sources can you search?'] },
    ],
  }
}

/** Decide what to do with a message: a data part wins, otherwise read the words. */
export function interpret(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const data = parts.find((p) => p?.kind === 'data' && p.data && typeof p.data === 'object')?.data
  if (data) return { action: 'search', source: data.source, query: data.query, limit: data.limit }
  const text = parts.filter((p) => p?.kind === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ').trim()
  if (!text) return { action: 'error', error: 'send a text question or a data part {source, query, limit}' }
  if (/\b(what|which|list)\b.*\bsources?\b|\bsources?\b.*\b(can|do)\b/i.test(text) && !/:/.test(text)) return { action: 'sources' }
  let source = SOURCE_IDS.find((id) => new RegExp(`\\b${id}\\b`, 'i').test(text))
  if (!source) {
    if (/europe\s*pmc/i.test(text)) source = 'europepmc'
    else if (/clinical\s*trials?|\btrials?\b|\bstud(y|ies)\b/i.test(text)) source = 'clinicaltrials'
    else if (/\bfda\b|adverse|side effects?|reactions?/i.test(text)) source = 'openfda'
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
