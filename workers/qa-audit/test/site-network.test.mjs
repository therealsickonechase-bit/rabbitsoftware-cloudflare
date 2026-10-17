import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ANCHORS_URL, CHAIN_URL, PROOF_URL, buildNetwork, describeBlock, edgeLine, layoutNetwork } from '../../../site/network-view.mjs'

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const chain = fx('maxwell_chain.json'), anchors = fx('anchors_index.json'), proof = fx('proof-live.json')
const NOW = Date.parse('2026-10-17T16:00:00Z')

test('the three data files are read from the project\'s own public buckets', () => {
  assert.equal(CHAIN_URL, 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json')
  assert.equal(ANCHORS_URL, 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/index.json')
  assert.equal(PROOF_URL, 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/proof-live.json')
})

test('real blocks are told apart: genesis, research anchors, and web snapshots by their miner', () => {
  const net = buildNetwork({ chain, anchors, proof }, NOW)
  const by = Object.fromEntries(net.blocks.map((b) => [b.index, b]))
  assert.equal(net.blocks.length, chain.blocks.length)
  assert.equal(by[0].kind, 'genesis')
  assert.deepEqual([1, 4, 7, 9, 11, 12].map((i) => by[i].kind), Array(6).fill('research'))
  assert.deepEqual([by[2].miner, by[3].miner], ['owner PC', 'Google Cloud'])
  assert.equal(by[3].kind, 'web')
  assert.ok(net.blocks.every((b, i) => b.index === i && b.hash && (i === 0 || b.prev)))
  const research = by[12].rows.map((r) => r.label)
  assert.ok(research.includes('Public research records covered') && research.includes('Merkle root'))
  assert.match(by[12].rows.find((r) => r.label === 'Public research records covered').value, /1,512/)
  assert.ok(by[2].rows.some((r) => r.label === 'Services answering' && r.value === '27 of 27'))
  assert.match(by[12].snapshot, /maxwell\/snapshots\/block-0012\.ndjson\.gz$/)
  assert.equal(by[2].snapshot, null)
})

test('each block is covered by the EARLIEST anchor that was longer than it, and the status job\'s re-check is carried over', () => {
  const net = buildNetwork({ chain, anchors, proof }, NOW)
  const by = Object.fromEntries(net.blocks.map((b) => [b.index, b]))
  const first = anchors.filter((a) => a.maxwellLength > 12).sort((a, b) => a.maxwellLength - b.maxwellLength)[0]
  assert.equal(by[12].witness.anchor, first.id)
  assert.equal(by[12].witness.bitcoinHeight, first.bitcoinHeight)
  assert.equal(by[0].witness.anchor, anchors.filter((a) => a.maxwellLength > 0).sort((a, b) => a.maxwellLength - b.maxwellLength || (a.id < b.id ? -1 : 1))[0].id)
  const newestLength = Math.max(...anchors.map((a) => a.maxwellLength))
  assert.equal(by[newestLength].witness, undefined === by[newestLength] ? undefined : null)           // a block newer than every anchor has no witness yet
  const checked = proof.anchors.find((a) => a.id === by[12].witness.anchor)
  assert.equal(by[12].witness.verified, checked.verified)
  assert.match(net.summary, /blocks \(\d+ research anchors, \d+ web snapshots\), \d+ of them already witnessed by Bitcoin/)
})

test('odd or hostile data is shown as plain, limited text and never as markup or a bad number', () => {
  const evil = { index: 3, timestamp: 'soon', hash: '<script>', previous_hash: 'x', transactions: [{ sender: 'RESEARCH_ANCHOR', count: -4, root: 'nothex', source: '<img src=x onerror=alert(1)>' + 'a'.repeat(200) }] }
  const b = describeBlock(evil, NOW)
  assert.equal(b.hash, null)
  assert.equal(b.hash8, '?')
  assert.equal(b.time, null)
  assert.ok(!b.rows.some((r) => r.label === 'Public research records covered'))       // a negative count is dropped
  assert.ok(!b.rows.some((r) => r.label === 'Merkle root'))
  const src = b.rows.find((r) => r.label === 'Records read from').value
  assert.ok(src.length <= 80)                                                         // it is data: the page draws it with textContent
  assert.equal(describeBlock({ index: 'x', transactions: [] }, NOW).index, null)
  const net = buildNetwork({ chain: { blocks: [evil, { nope: 1 }, null] }, anchors: [{ id: 'bad', status: 'confirmed' }, null, 5], proof: { anchors: [null] } }, NOW)
  assert.equal(net.blocks.length, 1)
  assert.equal(net.anchors.length, 0)
  assert.equal(buildNetwork({ chain: null, anchors: null, proof: null }, NOW).summary, 'The chain could not be read just now.')
})

test('the layout puts every block, anchor and Bitcoin block in its lane with links that point at real nodes', () => {
  const net = buildNetwork({ chain, anchors, proof, ledgerHead: { length: 18, headHash: 'a'.repeat(64) } }, NOW)
  const lay = layoutNetwork(net)
  const byId = new Map(lay.nodes.map((n) => [n.id, n]))
  assert.equal(byId.size, lay.nodes.length)                                           // unique ids
  assert.equal(lay.nodes.filter((n) => n.type === 'block').length, chain.blocks.length)
  assert.equal(lay.nodes.filter((n) => n.type === 'anchor').length, anchors.filter((a) => a.maxwellLength >= 1).length)
  assert.equal(lay.nodes.filter((n) => n.type === 'bitcoin').length, new Set(anchors.filter((a) => a.status === 'confirmed').map((a) => a.bitcoinHeight)).size)
  assert.equal(lay.nodes.filter((n) => n.type === 'source').length, 3)
  for (const e of lay.edges) { assert.ok(byId.has(e.from) && byId.has(e.to), `${e.from} -> ${e.to}`); assert.ok(edgeLine(e, byId)) }
  const prev = lay.edges.filter((e) => e.type === 'prev')
  assert.equal(prev.length, chain.blocks.length - 1)
  const blockXs = lay.nodes.filter((n) => n.type === 'block').map((n) => n.x)
  assert.deepEqual(blockXs, [...blockXs].sort((a, b) => a - b))                       // left to right in chain order
  assert.ok(new Set(blockXs).size === blockXs.length)
  assert.ok(lay.nodes.every((n) => n.x >= 0 && n.x + n.w <= lay.width && n.y + n.h <= lay.height))
  const research = lay.edges.filter((e) => e.type === 'feeds' && e.from === 'sRes').length
  assert.equal(research, net.blocks.filter((b) => b.kind === 'research').length)
  assert.equal(lay.edges.filter((e) => e.type === 'ledger').length, net.blocks.filter((b) => b.kind === 'web').length)
  assert.match(byId.get('sLedger').sub, /length 18 · head aaaaaaaa/)
  assert.equal(edgeLine({ from: 'nope', to: 'b1' }, byId), null)
})

test('the page script draws with textContent and DOM nodes only, uses ids that exist on the page, and the site serves and links the page', () => {
  const js = readFileSync(new URL('../../../site/network.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../../../site/network.html', import.meta.url), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/.test(js))
  for (const id of new Set([...js.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]))) assert.ok(html.includes(`id="${id}"`), id)
  assert.ok(html.includes('<script type="module" src="network.js"></script>'))
  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(html))
  for (const f of ['all', 'research', 'web']) assert.ok(html.includes(`data-filter="${f}"`), f)
  assert.match(readFileSync(new URL('../../../site/_headers', import.meta.url), 'utf8'), /\/network-view\.mjs\s+Content-Type: application\/javascript/)
  assert.match(readFileSync(new URL('../../../site/sitemap.xml', import.meta.url), 'utf8'), /network\.html/)
  for (const page of ['index.html', 'proof.html', 'blockchain.html']) assert.match(readFileSync(new URL(`../../../site/${page}`, import.meta.url), 'utf8'), /href="network\.html"/, page)
})
