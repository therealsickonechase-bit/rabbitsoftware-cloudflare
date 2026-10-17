import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DIGEST_URL, PROOF_URL, digestView, proofView } from '../../../site/proof-view.mjs'

const NOW = Date.parse('2026-10-17T15:00:00Z')
const proof = (over = {}) => ({
  version: 1, generatedAt: '2026-10-17T14:57:00Z',
  summary: { anchors: 3, confirmed: 2, pending: 1, verified: 1, failed: 0, witnesses: ['Bitcoin via OpenTimestamps', 'FreeTSA (RFC 3161)'] },
  heads: { maxwellHeadIndex: 12, ledgerLength: 16 },
  notYetOn: ['Ethereum', 'XRP Ledger'],
  anchors: [
    { id: '2026-10-17T070013Z', status: 'confirmed', bitcoinHeight: 971827, verified: true, reason: 'matches the Merkle root of 3 Bitcoin blocks', checkedAt: '2026-10-17T14:50:00Z', tsa: 'freetsa.org', maxwellLength: 13, ledgerLength: 16 },
    { id: '2026-10-17T010010Z', status: 'confirmed', bitcoinHeight: 971788, verified: null, reason: 'not checked yet' },
    { id: '2026-10-17T130014Z', status: 'pending', bitcoinHeight: null, verified: null, reason: 'waiting for a Bitcoin block' },
    { id: '<script>alert(1)</script>', status: 'confirmed', verified: true },
  ],
  ...over,
})

test('the files are read from the public status bucket', () => {
  assert.equal(PROOF_URL, 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/proof-live.json')
  assert.equal(DIGEST_URL, 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/digest.json')
})

test('a fresh file says how many anchors were re-checked, lists them with honest verdicts, and drops rows with odd ids', () => {
  const v = proofView(proof(), NOW)
  assert.equal(v.state, 'ok')
  assert.match(v.headline, /1 of the last 3 anchors were re-checked/)
  assert.match(v.headline, /1 confirmed anchor is waiting for its check/)
  assert.deepEqual(v.anchors.map((a) => a.verdict), ['matches Bitcoin', 'not checked yet', 'waiting for Bitcoin'])
  assert.equal(v.anchors[0].blockLink, 'https://mempool.space/block/971827')
  assert.equal(v.anchors[0].files.tsa, 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/2026-10-17T070013Z/anchor.json.tsr')
  assert.equal(v.anchors[1].files.tsa, null)
  assert.equal(v.anchors[2].blockLink, null)
  assert.deepEqual(v.notYet, ['Ethereum', 'XRP Ledger'])
  assert.match(v.when, /Updated 3 minutes ago/)
})

test('a failed check is shown loudly, an old file is marked stale, and a broken file shows nothing rather than guessing', () => {
  const bad = proofView(proof({ summary: { anchors: 3, confirmed: 2, pending: 1, verified: 0, failed: 1 }, anchors: [{ id: '2026-10-17T070013Z', status: 'confirmed', bitcoinHeight: 5, verified: false, reason: 'the proof does not match' }] }), NOW)
  assert.match(bad.headline, /1 did NOT match/)
  assert.equal(bad.anchors[0].verdict, 'DOES NOT MATCH')
  assert.equal(bad.anchors[0].state, 'bad')
  assert.equal(proofView(proof({ generatedAt: '2026-10-17T10:00:00Z' }), NOW).state, 'stale')
  for (const broken of [null, {}, { version: 2 }, { version: 1, anchors: 'x', summary: {} }]) assert.equal(proofView(broken, NOW).state, 'unknown')
})

test('the digest keeps its plain text, shows the figures, and only passes on known research links', () => {
  const d = digestView({ version: 1, text: 'The store holds 1,565 public records.', total: 1565, topics: { explored: 55 }, lastWeek: { added: 135 },
    newest: [{ title: 'A paper', source: 'Physics papers', url: 'https://arxiv.org/abs/2409.18145', seenAt: '2026-10-17T14:00:00Z' }, { title: 'Bad link', url: 'https://evil.example/x' }, { title: '' }] }, NOW)
  assert.equal(d.ok, true)
  assert.deepEqual(d.stats, ['1,565 public records', '55 topics explored', '135 added last period'])
  assert.equal(d.newest.length, 2)
  assert.equal(d.newest[0].link, 'https://arxiv.org/abs/2409.18145')
  assert.equal(d.newest[1].link, null)
  assert.equal(digestView(null).ok, false)
  assert.equal(digestView({ version: 1 }).ok, false)
})

test('the page script draws with textContent only, uses ids that exist on the page, and the site serves the module as JavaScript and links the page', () => {
  const js = readFileSync(new URL('../../../site/proof.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../../../site/proof.html', import.meta.url), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/.test(js))
  for (const id of new Set([...js.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]))) assert.ok(html.includes(`id="${id}"`), id)
  assert.ok(html.includes('<script type="module" src="proof.js"></script>'))
  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(html))
  assert.match(readFileSync(new URL('../../../site/_headers', import.meta.url), 'utf8'), /\/proof-view\.mjs\s+Content-Type: application\/javascript/)
  assert.match(readFileSync(new URL('../../../site/sitemap.xml', import.meta.url), 'utf8'), /proof\.html/)
  assert.match(readFileSync(new URL('../../../site/index.html', import.meta.url), 'utf8'), /href="proof\.html"/)
})
