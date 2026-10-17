// network.html: draws the map of how research and platform facts flow into the Maxwell chain and out to Bitcoin (see network-view.mjs for the logic).
// Reads only files the project already publishes, re-reads every minute. Everything is drawn with textContent and SVG nodes made with createElementNS, never HTML strings.
// If a file cannot be read the page says so and keeps what it last had.
import { ANCHORS_URL, CHAIN_URL, KIND_LABEL, LEDGER_HEAD_URL, PROOF_URL, buildNetwork, edgeLine, layoutNetwork } from './network-view.mjs'

const REFRESH_MS = 60_000
const SVG = 'http://www.w3.org/2000/svg'
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e }
let data = { chain: null, anchors: null, proof: null, ledgerHead: null }
let net = null, filter = 'all', selected = null

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function detail(index) {
  const panel = $('net-detail')
  panel.replaceChildren()
  const b = net?.blocks.find((x) => x.index === index)
  if (!b) { panel.append(el('p', 'small', 'Click a block on the map to see what it holds, which block it follows and who witnessed it.')); return }
  panel.append(el('h3', null, `Block ${b.index} · ${KIND_LABEL[b.kind] ?? b.label}`))
  const dl = el('dl', 'facts')
  const row = (k, v) => { dl.append(el('dt', null, k), el('dd', null, v)) }
  if (b.time) row('Mined', `${b.time.replace('T', ' ').slice(0, 19)} UTC (${b.ago})`)
  row('Block hash', b.hash ?? 'unreadable')
  row('Follows (previous hash)', b.prev ?? 'unreadable')
  for (const r of b.rows) row(r.label, r.value)
  if (b.witness) {
    const w = b.witness
    row('Witnessed by', w.status === 'confirmed' ? `anchor ${w.anchor}, Bitcoin block ${w.bitcoinHeight}${w.verified === true ? ' (re-checked by our status job: matches)' : w.verified === false ? ' (our re-check does NOT match)' : ' (re-check pending)'}` : `anchor ${w.anchor}, waiting for a Bitcoin block`)
  } else row('Witnessed by', 'not yet covered by an anchor')
  panel.append(dl)
  if (b.snapshot) { const p = el('p', 'small'); const a = el('a', null, 'Saved record set for this block (.ndjson.gz)'); a.href = b.snapshot; a.rel = 'noopener noreferrer'; p.append(a); panel.append(p) }
}

function draw() {
  const map = $('net-map')
  map.replaceChildren()
  if (!net || !net.blocks.length) return
  const shown = (kind) => filter === 'all' || kind === filter || kind === 'genesis'
  const lay = layoutNetwork(net)
  const byId = new Map(lay.nodes.map((n) => [n.id, n]))
  const svg = sv('svg', { class: 'netsvg', viewBox: `0 0 ${lay.width} ${lay.height}`, width: lay.width, height: lay.height, role: 'img', 'aria-label': 'Map of the Maxwell chain, its anchors and the Bitcoin blocks that witness them' })
  const defs = sv('defs'); const mk = sv('marker', { id: 'arr', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' }); mk.append(sv('path', { d: 'M0,0 L8,4 L0,8 z', class: 'arrow' })); defs.append(mk); svg.append(defs)
  for (const [y, label] of [[22, 'Bitcoin (free witness)'], [112, 'Anchors (every 6 h)'], [222, 'Maxwell chain: block links'], [362, 'Where the hashes come from']]) svg.append(sv('text', { x: 8, y, class: 'lane' }, label))
  const blockKind = new Map(net.blocks.map((b) => [`b${b.index}`, b.kind]))
  for (const e of lay.edges) {
    if ((e.type === 'feeds' || e.type === 'ledger') && !shown(blockKind.get(e.to))) continue
    const l = edgeLine(e, byId)
    if (!l) continue
    svg.append(sv('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, class: `edge ${e.type}`, 'marker-end': e.type === 'prev' || e.type === 'covers' || e.type === 'witness' ? 'url(#arr)' : '' }))
  }
  for (const n of lay.nodes) {
    if (n.type === 'block' && !shown(n.kind)) continue
    const g = sv('g', { class: `node ${n.type} ${n.kind ?? ''} ${n.state ?? ''}${selected === n.index && n.type === 'block' ? ' selected' : ''}`, transform: `translate(${n.x},${n.y})` })
    g.append(sv('rect', { width: n.w, height: n.h, rx: 6 }))
    g.append(sv('text', { x: n.w / 2, y: n.type === 'source' ? 19 : 17, class: 'nt', 'text-anchor': 'middle' }, n.title))
    g.append(sv('text', { x: n.w / 2, y: n.type === 'source' ? 35 : 31, class: 'ns', 'text-anchor': 'middle' }, n.sub))
    if (n.type === 'block') {
      g.append(sv('text', { x: n.w / 2, y: 45, class: 'nh', 'text-anchor': 'middle' }, n.hash8))
      const b = net.blocks.find((x) => x.index === n.index)
      const badge = b?.witness?.status === 'confirmed' ? (b.witness.verified === false ? '✕' : '✓') : b?.witness ? '…' : ''
      if (badge) g.append(sv('text', { x: n.w - 8, y: 13, class: `badge ${b.witness.verified === false ? 'bad' : b.witness.status === 'confirmed' ? 'ok' : 'wait'}`, 'text-anchor': 'middle' }, badge))
      g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button'); g.setAttribute('aria-label', `Block ${n.index}, ${n.sub}`)
      const pick = () => { selected = n.index; detail(n.index); draw() }
      g.addEventListener('click', pick)
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick() } })
    }
    if (n.type === 'anchor') g.append(sv('text', { x: n.w / 2, y: 52, class: 'ns', 'text-anchor': 'middle' }, n.ledger !== null && n.ledger !== undefined ? `ledger ${n.ledger}` : ''))
    svg.append(g)
  }
  map.append(svg)
}

function table() {
  const body = $('net-rows')
  body.replaceChildren()
  if (!net) return
  for (const b of [...net.blocks].reverse()) {
    const tr = el('tr')
    const w = b.witness
    tr.append(el('td', null, String(b.index)), el('td', null, KIND_LABEL[b.kind] ?? b.label), el('td', 'mono', b.hash8), el('td', 'mono', b.prev8), el('td', null, b.ago || ''),
      el('td', null, w ? (w.status === 'confirmed' ? `Bitcoin ${w.bitcoinHeight}${w.verified === true ? ' ✓' : w.verified === false ? ' ✕' : ''}` : 'pending') : '—'))
    tr.tabIndex = 0
    const pick = () => { selected = b.index; detail(b.index); draw() }
    tr.addEventListener('click', pick)
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick() })
    body.append(tr)
  }
}

function render() {
  net = data.chain ? buildNetwork(data) : null
  $('net-summary').textContent = net ? net.summary : 'The chain could not be read just now. Nothing is shown rather than guessing.'
  $('net-ledger').textContent = net?.ledger ? `RabbitOS ledger: ${net.ledger.length} events, head ${net.ledger.head8}.` : ''
  draw(); table(); detail(selected)
}

for (const btn of document.querySelectorAll('[data-filter]')) {
  btn.addEventListener('click', () => { filter = btn.dataset.filter; for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b === btn)); draw() })
}

async function load() {
  const [c, a, p, l] = await Promise.allSettled([getJson(CHAIN_URL), getJson(ANCHORS_URL), getJson(PROOF_URL), getJson(LEDGER_HEAD_URL)])
  if (c.status === 'fulfilled') data.chain = c.value
  if (a.status === 'fulfilled') data.anchors = a.value
  if (p.status === 'fulfilled') data.proof = p.value
  if (l.status === 'fulfilled') data.ledgerHead = l.value
  render()
}

load()
setInterval(load, REFRESH_MS)
setInterval(() => { if (net) render() }, 30_000)      // keeps "N minutes ago" honest
