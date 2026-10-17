// core.html: "Maxwell Core: everything in one place". Reads public files (the Core gateway on Google Cloud, the status bucket, the open data hub) and draws six panels.
// Each panel loads and fails on its own, so one source being down never blanks the page. Everything is drawn with textContent; links go only to this site, GitHub and known research hosts.
import { URLS, agentsPanel, coreView, dataPanel, networksPanel, researchPanel } from './core-view.mjs'

const REFRESH_MS = 60_000
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
const link = (href, text) => { const a = el('a', null, text); a.href = href; a.rel = 'noopener noreferrer'; return a }
const data = {}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
const fill = (id, rows) => { const list = $(id); list.replaceChildren(...rows); return list }
const dot = (state) => el('span', `dot ${state}`)

function renderNode() {
  const v = coreView({ chaininfo: data.chaininfo, mining: data.mining, nodeinfo: data.nodeinfo })
  $('node-headline').textContent = v.headline
  $('node-headline').className = `lead ${v.state}`
  const dl = $('node-facts'); dl.replaceChildren()
  for (const f of v.facts) dl.append(el('dt', null, f.label), el('dd', null, f.value))
  fill('node-kinds', v.kinds.map((k) => { const li = el('li'); li.append(el('strong', null, String(k.count)), ` ${k.label}`); return li }))
  $('node-last').textContent = v.last ?? ''
}

function renderResearch() {
  const r = researchPanel(data.research)
  $('res-total').textContent = r.total === null ? r.when : `${r.total.toLocaleString('en-US')} public records${r.topics ? ` · ${r.topics}` : ''}`
  $('res-when').textContent = r.state === 'unknown' ? '' : r.when
  fill('res-sources', r.sources.map((s) => { const li = el('li', 'barrow'); const bar = el('span', 'bar'); bar.style.width = `${s.pct}%`; li.append(el('span', 'bl', s.label), bar, el('span', 'bn', s.count.toLocaleString('en-US'))); return li }))
  fill('res-recent', r.recent.map((x) => { const li = el('li'); if (x.link) li.append(link(x.link, x.title)); else li.append(el('span', null, x.title)); li.append(el('small', null, ` ${x.source}${x.ago ? ` · ${x.ago}` : ''}`)); return li }))
}

function renderNetworks() {
  const n = networksPanel({ witness: data.witness, proof: data.proof, latest: data.latest })
  $('net-wit-headline').textContent = n.witnesses.headline
  $('net-wit-headline').className = `lead ${n.witnesses.state}`
  fill('net-wit-list', n.witnesses.rows.map((w) => { const li = el('li'); li.append(dot(w.state), el('strong', null, ` ${w.name}`), el('small', null, ` ${w.kind} · ${w.status}${w.signed ? ` · signed ${w.signed}` : ''}`)); return li }))
  $('net-anchors').textContent = [n.anchors.headline, n.anchors.witnesses.length ? `Witnessed by ${n.anchors.witnesses.join(' and ')}.` : '', n.anchors.notYet.length ? `Not switched on yet: ${n.anchors.notYet.join(' and ')}.` : ''].filter(Boolean).join(' ')
  $('net-services').textContent = n.services ? `${n.services.up} of ${n.services.total} services answering${n.services.down.length ? ` (down: ${n.services.down.join(', ')})` : ''}${n.services.when ? `, ${n.services.when}` : ''}.` : 'The service list could not be read just now.'
  $('net-ledger').textContent = n.ledger ? `RabbitOS ledger: the app and the public copy ${n.ledger.agree ? 'agree' : 'DISAGREE'} (${n.ledger.app ?? '?'} and ${n.ledger.mirror ?? '?'} events).` : ''
}

function renderData() {
  const d = dataPanel(data.latest)
  $('data-total').textContent = d.datasets.length ? `${d.datasets.length} open datasets · ${d.total.toLocaleString('en-US')} rows` : 'The dataset list could not be read just now.'
  fill('data-list', d.datasets.map((x) => { const li = el('li'); li.append(link(`https://app.rabbitsoftware.io/api/data/${x.id}?limit=20`, x.id), el('small', null, ` ${x.rows.toLocaleString('en-US')} rows · ${x.columns} columns`)); return li }))
}

function renderAgents() {
  const a = agentsPanel(data.agents, data.scores)
  $('agents-summary').textContent = a.total ? `${a.active} of ${a.total} agents active in the last 2 hours.` : 'The agent list could not be read just now.'
  fill('agents-list', a.agents.map((x) => { const li = el('li'); li.append(dot(x.state), el('strong', null, ` ${x.id}`), el('small', null, ` ${x.kind} · seen ${x.seen}${x.balance !== null ? ` · score ${x.balance}` : ''}`)); return li }))
}

function render() {
  for (const f of [renderNode, renderResearch, renderNetworks, renderData, renderAgents]) { try { f() } catch { /* one panel failing never stops the others */ } }
  $('core-when').textContent = `Read ${new Date().toISOString().slice(11, 19)} UTC; refreshes every minute.`
}

async function load() {
  const names = Object.keys(URLS)
  const results = await Promise.allSettled(names.map((k) => getJson(URLS[k])))
  names.forEach((k, i) => { if (results[i].status === 'fulfilled') data[k] = results[i].value })
  render()
}

load()
setInterval(load, REFRESH_MS)
