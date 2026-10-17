// The logic behind network.html: the map of how research and platform facts flow into the Maxwell chain, are covered by anchors, and are witnessed by Bitcoin.
// Pure functions, no browser APIs, so tests can run them. Everything comes from files the project already publishes:
//   maxwell/maxwell_chain.json (public ledger bucket)   anchors/index.json (same bucket)   status/proof-live.json (public status bucket)
// Everything in those files is data, never markup: strings are length-capped and drawn as plain text, hashes must be hex, numbers must be numbers.
import { ageText } from './status-view.mjs'

const LEDGER = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/'
const STATUS = 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/'
export const CHAIN_URL = LEDGER + 'maxwell/maxwell_chain.json'
export const ANCHORS_URL = LEDGER + 'anchors/index.json'
export const PROOF_URL = STATUS + 'proof-live.json'
export const LEDGER_HEAD_URL = LEDGER + 'ledger/chain_head.json'

const HEX64 = /^[0-9a-f]{64}$/
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/
export const KINDS = Object.freeze({
  MAXWELL_GENESIS: { kind: 'genesis', label: 'Genesis', miner: null },
  RESEARCH_ANCHOR: { kind: 'research', label: 'Research anchor', miner: null },
  RABBITWEB_MINER: { kind: 'web', label: 'Web snapshot', miner: 'owner PC' },
  RABBITWEB_MINER_CLOUD: { kind: 'web', label: 'Web snapshot', miner: 'Google Cloud' },
})
const whole = (n) => (Number.isInteger(n) && n >= 0 ? n : null)
const hex = (h) => (HEX64.test(String(h ?? '')) ? String(h) : null)
const text = (v, n = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n)
const short = (h) => (hex(h) ? h.slice(0, 8) : '?')

/** One block, reduced to safe, displayable facts. */
export function describeBlock(b, now = Date.now()) {
  const tx = Array.isArray(b?.transactions) ? b.transactions.find((t) => t && typeof t === 'object' && t.sender in KINDS) ?? b.transactions[0] : null
  const info = KINDS[tx?.sender] ?? { kind: 'other', label: 'Other block', miner: null }
  const index = whole(b?.index)
  const ms = Number.isFinite(b?.timestamp) ? Math.round(b.timestamp * 1000) : null
  const rows = []
  const add = (label, value) => { if (value !== null && value !== undefined && value !== '') rows.push({ label, value: String(value) }) }
  if (info.kind === 'research') {
    add('Public research records covered', whole(tx.count)?.toLocaleString('en-US'))
    add('Merkle root', hex(tx.root) ? tx.root.slice(0, 16) + '…' : null)
    add('Records read from', text(tx.source, 80))
  } else if (info.kind === 'web') {
    add('Services answering', whole(tx.nodes_up) !== null && whole(tx.nodes_total) !== null ? `${tx.nodes_up} of ${tx.nodes_total}` : null)
    add('Facts in the snapshot (Merkle leaves)', whole(tx.count))
    add('Open datasets', whole(tx.datasets))
    add('Research rows counted', whole(tx.research_rows)?.toLocaleString('en-US'))
    add('Ledger copies agreed', tx.chain_ok === 1 ? 'yes' : tx.chain_ok === 0 ? 'NO' : null)
    add('Merkle root', hex(tx.root) ? tx.root.slice(0, 16) + '…' : null)
    add('Mined by', info.miner)
  } else if (info.kind === 'genesis') add('Anchor', 'sha256("hello world")')
  return {
    index, kind: info.kind, label: info.label, miner: info.miner, hash: hex(b?.hash), prev: hex(b?.previous_hash), hash8: short(b?.hash), prev8: short(b?.previous_hash),
    time: ms === null ? null : new Date(ms).toISOString(), ago: ms === null ? '' : ageText(new Date(ms).toISOString(), now), rows,
    snapshot: info.kind === 'research' && index !== null ? `${LEDGER}maxwell/snapshots/block-${String(index).padStart(4, '0')}.ndjson.gz` : null,
  }
}

/**
 * Joins the chain with the anchors: block i is covered by the EARLIEST anchor whose Maxwell chain was longer than i (its head hash includes every earlier block through the links).
 * `proof` (proof-live.json) says which anchors our status job re-checked against Bitcoin.
 */
export function buildNetwork({ chain, anchors, proof, ledgerHead }, now = Date.now()) {
  const blocks = (Array.isArray(chain?.blocks) ? chain.blocks : []).map((b) => describeBlock(b, now)).filter((b) => b.index !== null).sort((a, b) => a.index - b.index)
  const checks = new Map((proof?.anchors ?? []).filter((a) => a && ID_RE.test(String(a.id))).map((a) => [a.id, a.verified]))
  const list = (Array.isArray(anchors) ? anchors : []).filter((a) => a && ID_RE.test(String(a.id)) && HEX64.test(String(a.digest ?? '0'.repeat(64)))).map((a) => ({
    id: a.id, status: a.status === 'confirmed' ? 'confirmed' : 'pending', bitcoinHeight: whole(a.bitcoinHeight), maxwellLength: whole(a.maxwellLength), ledgerLength: whole(a.ledgerLength),
    tsa: a.tsa === 'freetsa.org', verified: checks.has(a.id) ? checks.get(a.id) : null,
  })).sort((a, b) => (a.id < b.id ? -1 : 1))
  for (const b of blocks) {
    const cover = list.filter((a) => a.maxwellLength !== null && a.maxwellLength > b.index).sort((x, y) => x.maxwellLength - y.maxwellLength || (x.id < y.id ? -1 : 1))[0] ?? null
    b.witness = cover ? { anchor: cover.id, status: cover.status, bitcoinHeight: cover.bitcoinHeight, verified: cover.verified } : null
  }
  const bitcoin = [...new Map(list.filter((a) => a.status === 'confirmed' && a.bitcoinHeight).map((a) => [a.bitcoinHeight, a.bitcoinHeight])).values()]
  const covered = blocks.filter((b) => b.witness?.status === 'confirmed').length
  const kinds = blocks.reduce((m, b) => ({ ...m, [b.kind]: (m[b.kind] ?? 0) + 1 }), {})
  return {
    blocks, anchors: list, bitcoin, kinds,
    ledger: ledgerHead && whole(ledgerHead.length) !== null ? { length: ledgerHead.length, head8: short(ledgerHead.headHash) } : null,
    summary: blocks.length
      ? `${blocks.length} blocks (${kinds.research ?? 0} research anchors, ${kinds.web ?? 0} web snapshots), ${covered} of them already witnessed by Bitcoin through ${list.filter((a) => a.status === 'confirmed').length} confirmed anchors${list.some((a) => a.verified === true) ? `, ${list.filter((a) => a.verified === true).length} re-checked by our status job` : ''}.`
      : 'The chain could not be read just now.',
  }
}

export const LAYOUT = Object.freeze({ col: 96, left: 150, blockW: 78, blockH: 52, lanes: { bitcoin: 50, anchor: 140, block: 250, source: 390 } })

/** Positions for the SVG: lanes top to bottom are Bitcoin, anchors, Maxwell blocks, sources. Returns nodes and edges with coordinates. */
export function layoutNetwork(net) {
  const { col, left, blockW, blockH, lanes } = LAYOUT
  const nodes = [], edges = []
  const bx = (i) => left + i * col
  for (const b of net.blocks) nodes.push({ id: `b${b.index}`, type: 'block', kind: b.kind, x: bx(b.index), y: lanes.block, w: blockW, h: blockH, title: `#${b.index}`, sub: b.kind === 'genesis' ? 'genesis' : b.kind === 'research' ? 'research' : (b.miner === 'Google Cloud' ? 'web · cloud' : 'web · PC'), hash8: b.hash8, index: b.index })
  for (let i = 1; i < net.blocks.length; i++) edges.push({ from: `b${net.blocks[i - 1].index}`, to: `b${net.blocks[i].index}`, type: 'prev', label: net.blocks[i].prev8 })
  const seen = new Map(), btc = new Map()
  for (const a of net.anchors) {
    if (a.maxwellLength === null || a.maxwellLength < 1) continue
    const headIdx = a.maxwellLength - 1
    const n = seen.get(headIdx) ?? 0
    seen.set(headIdx, n + 1)
    const id = `a${a.id}`
    nodes.push({ id, type: 'anchor', x: bx(headIdx) + n * 22, y: lanes.anchor, w: 62, h: 40, title: a.id.slice(5, 16).replace('T', ' ').replace(/(\d\d)(\d\d)$/, '$1:$2'), sub: a.status === 'confirmed' ? 'confirmed' : 'pending', state: a.verified === true ? 'ok' : a.verified === false ? 'bad' : 'wait', ref: a.id, ledger: a.ledgerLength })
    edges.push({ from: id, to: `b${headIdx}`, type: 'covers' })
    if (a.status === 'confirmed' && a.bitcoinHeight) {
      if (!btc.has(a.bitcoinHeight)) { btc.set(a.bitcoinHeight, `t${a.bitcoinHeight}`); nodes.push({ id: `t${a.bitcoinHeight}`, type: 'bitcoin', x: bx(headIdx) + n * 22, y: lanes.bitcoin, w: 74, h: 34, title: `BTC ${a.bitcoinHeight}`, sub: 'Bitcoin block', height: a.bitcoinHeight }) }
      edges.push({ from: btc.get(a.bitcoinHeight), to: id, type: 'witness' })
    }
  }
  const last = Math.max(0, net.blocks.length - 1)
  const srcX = [left, left + Math.max(2, Math.floor(last / 2)) * col, left + last * col]
  const sources = [
    { id: 'sRes', title: 'Research records', sub: 'Supabase store, public rows', x: srcX[0] - 20 },
    { id: 'sPlat', title: 'Platform state', sub: 'services, code, map, backups', x: srcX[1] - 40 },
    { id: 'sLedger', title: 'RabbitOS ledger', sub: net.ledger ? `length ${net.ledger.length} · head ${net.ledger.head8}` : 'hash-chained events', x: srcX[2] - 20 },
  ]
  for (const s of sources) nodes.push({ id: s.id, type: 'source', x: s.x, y: lanes.source, w: 150, h: 46, title: s.title, sub: s.sub })
  for (const b of net.blocks) {
    if (b.kind === 'research') edges.push({ from: 'sRes', to: `b${b.index}`, type: 'feeds' })
    if (b.kind === 'web') { edges.push({ from: 'sPlat', to: `b${b.index}`, type: 'feeds' }); edges.push({ from: 'sLedger', to: `b${b.index}`, type: 'ledger' }) }
  }
  const width = Math.max(...nodes.map((n) => n.x + n.w)) + 40
  return { width, height: lanes.source + 90, nodes, edges }
}

/** Where an edge starts and ends on its two nodes (bottom/top centres, or side centres for the chain links). */
export function edgeLine(edge, byId) {
  const a = byId.get(edge.from), b = byId.get(edge.to)
  if (!a || !b) return null
  if (edge.type === 'prev') return { x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: b.y + b.h / 2 }
  const upward = a.y > b.y
  return { x1: a.x + a.w / 2, y1: upward ? a.y : a.y + a.h, x2: b.x + b.w / 2, y2: upward ? b.y + b.h : b.y }
}

export const KIND_LABEL = Object.freeze({ genesis: 'Genesis', research: 'Research anchor', web: 'Web snapshot', other: 'Other' })
