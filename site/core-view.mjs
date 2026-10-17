// The logic behind core.html ("Maxwell Core: everything in one place"): the node and its chain, the research, the networks that witness it, the open data and the agents.
// Pure functions, no browser APIs, so tests can run them. Each panel reads its own public file and fails on its own: one source being down never blanks the page.
// Everything in these files is data, never markup: strings are length-capped and drawn as plain text, numbers must be numbers.
import { ageMinutes, ageText } from './status-view.mjs'
import { liveView } from './research-live-view.mjs'
import { proofView, witnessView } from './proof-view.mjs'

export const CORE_URL = 'https://maxwell-core-vxx5lz7c5a-wl.a.run.app'
const STATUS = 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/'
const APP = 'https://app.rabbitsoftware.io'
export const URLS = Object.freeze({
  chaininfo: `${CORE_URL}/rest/chaininfo.json`, mining: `${CORE_URL}/rest/mininginfo.json`, nodeinfo: `${CORE_URL}/rest/nodeinfo.json`,
  latest: `${STATUS}latest.json`, research: `${STATUS}research-live.json`, witness: `${STATUS}witness.json`, proof: `${STATUS}proof-live.json`,
  agents: `${APP}/api/data/agents?limit=50`, scores: `${APP}/api/data/node_scores?limit=60`,
})
const HEX64 = /^[0-9a-f]{64}$/
const whole = (n) => (Number.isInteger(n) && n >= 0 ? n : null)
const text = (v, n = 60) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n)
const KIND_NAMES = Object.freeze({ MAXWELL_GENESIS: 'genesis', RESEARCH_ANCHOR: 'research anchors', RABBITWEB_MINER: 'web snapshots (PC)', RABBITWEB_MINER_CLOUD: 'web snapshots (Google Cloud)' })

/** The node and its chain, read from the Maxwell Core public gateway. */
export function coreView({ chaininfo, mining, nodeinfo } = {}, now = Date.now()) {
  if (!chaininfo || chaininfo.chain !== 'maxwell') return { state: 'down', headline: 'The Maxwell Core gateway could not be read just now.', facts: [], kinds: [] }
  const blocks = whole(chaininfo.blocks), ok = chaininfo.verified === true && blocks !== null
  const state = !ok ? 'bad' : chaininfo.conflict ? 'bad' : 'ok'
  const facts = [
    ['Blocks (tip height)', blocks === null ? '?' : String(blocks)],
    ['Tip hash', HEX64.test(String(chaininfo.bestblockhash)) ? chaininfo.bestblockhash.slice(0, 20) + '…' : '?'],
    ['Verified by the node', ok ? 'yes: every hash, link and work target' : 'NO'],
    ['Work target', whole(chaininfo.difficulty) !== null ? `${chaininfo.difficulty} leading zeros (light: tamper-evident, not a security claim)` : '?'],
    ['Last sync', chaininfo.lastsync ? `${ageText(chaininfo.lastsync, now)} (${text(chaininfo.lastsyncresult, 20)})` : 'not yet'],
    ['History conflict', chaininfo.conflict ? 'YES: the source offered a different history' : 'none'],
  ]
  if (nodeinfo && nodeinfo.name === 'maxwell-core') facts.push(['Node', `${text(nodeinfo.name, 20)} ${text(nodeinfo.version, 12)} · ${text(nodeinfo.mode, 40)}`])
  const kinds = Object.entries(mining?.blocksbykind ?? {}).filter(([, n]) => whole(n) !== null).map(([k, n]) => ({ label: KIND_NAMES[k] ?? text(k, 30), count: n })).sort((a, b) => b.count - a.count)
  const last = mining?.lastresearchanchor
  return {
    state,
    headline: !ok ? 'The node could not verify the chain.' : chaininfo.conflict ? 'The node refused a source that offered a different history.' : `Verified chain of ${blocks + 1} blocks`,
    facts: facts.map(([label, value]) => ({ label, value })), kinds,
    last: last && whole(last.height) !== null ? `Newest research anchor: block ${last.height}, ${last.records === null ? '?' : Number(last.records).toLocaleString('en-US')} records.` : '',
  }
}

/** Research: totals and sources from the live research file. */
export function researchPanel(research, now = Date.now()) {
  const v = liveView(research, now)
  return { state: v.state, when: v.when, total: v.total, topics: v.topics, sources: v.sources.slice(0, 8), recent: v.recent.slice(0, 6) }
}

/** Networks: witnesses, Bitcoin anchors, services and the agreement of the chain copies. */
export function networksPanel({ witness, proof, latest } = {}, now = Date.now()) {
  const w = witnessView(witness, now), p = proofView(proof, now)
  const services = Array.isArray(latest?.services) ? latest.services.filter((s) => s && typeof s.ok === 'boolean') : []
  const down = services.filter((s) => !s.ok).map((s) => text(s.label ?? s.key, 40))
  const c = latest?.chain
  return {
    witnesses: { state: w.state, headline: w.headline, rows: w.rows },
    anchors: { state: p.state, headline: p.headline, witnesses: p.witnesses, notYet: p.notYet },
    services: services.length ? { up: services.filter((s) => s.ok).length, total: services.length, down, when: latest.generatedAt ? `checked ${ageText(latest.generatedAt, now)}` : '' } : null,
    ledger: c && c.app && c.mirror ? { agree: c.agree === true, app: whole(c.app.length), mirror: whole(c.mirror.length) } : null,
  }
}

/** Open data: every dataset the data hub publishes, with its row count. */
export function dataPanel(latest) {
  const tree = Array.isArray(latest?.tree) ? latest.tree : []
  const datasets = tree.filter((d) => d && /^[a-z_]{1,40}$/.test(String(d.id))).map((d) => ({ id: d.id, title: text(d.title ?? d.id, 60), rows: whole(d.rows) ?? 0, columns: Array.isArray(d.columns) ? d.columns.length : 0 })).sort((a, b) => b.rows - a.rows)
  return { datasets, total: datasets.reduce((n, d) => n + d.rows, 0) }
}

export const AGENT_ACTIVE_MIN = 120
export const AGENT_RECENT_HOURS = 48
/** Agents: the registered agent nodes from the data hub, newest activity first, with their latest score balance. */
export function agentsPanel(agents, scores, now = Date.now()) {
  const rows = Array.isArray(agents?.rows) ? agents.rows : []
  const balance = new Map()
  for (const s of Array.isArray(scores?.rows) ? scores.rows : []) if (s && typeof s.node_id === 'string' && !balance.has(s.node_id) && Number.isFinite(s.balance)) balance.set(s.node_id, s.balance)
  const list = rows.filter((a) => a && /^[A-Za-z0-9._-]{1,60}$/.test(String(a.node_id))).map((a) => {
    const mins = a.last_seen_at ? ageMinutes(a.last_seen_at, now) : Infinity
    return { id: String(a.node_id), kind: text(a.kind, 24).replace(/_/g, ' '), seen: a.last_seen_at ? ageText(a.last_seen_at, now) : 'never', mins,
      state: mins <= AGENT_ACTIVE_MIN ? 'ok' : mins <= AGENT_RECENT_HOURS * 60 ? 'wait' : 'idle', balance: balance.get(String(a.node_id)) ?? null }
  }).sort((a, b) => a.mins - b.mins)
  return { agents: list.map(({ mins, ...rest }) => rest), active: list.filter((a) => a.state === 'ok').length, total: list.length }
}
