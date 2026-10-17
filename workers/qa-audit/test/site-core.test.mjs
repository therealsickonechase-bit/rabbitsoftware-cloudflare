import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { AGENT_ACTIVE_MIN, CORE_URL, URLS, agentsPanel, coreView, dataPanel, networksPanel, researchPanel } from '../../../site/core-view.mjs'

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const chaininfo = fx('core-chaininfo.json'), mining = fx('core-mininginfo.json'), nodeinfo = fx('core-nodeinfo.json')
const latest = fx('status-latest.json'), research = fx('research-live.json'), witness = fx('witness-live.json'), proof = fx('proof-live.json')
const agents = fx('data-agents.json'), scores = fx('data-node-scores.json')
const NOW = Date.parse('2026-10-17T17:00:00Z')

test('every panel reads a public file: the Core gateway on Google Cloud, the status bucket and the open data hub', () => {
  assert.equal(CORE_URL, 'https://maxwell-core-vxx5lz7c5a-wl.a.run.app')
  assert.equal(URLS.chaininfo, `${CORE_URL}/rest/chaininfo.json`)
  for (const url of Object.values(URLS)) assert.match(url, /^https:\/\/(maxwell-core-vxx5lz7c5a-wl\.a\.run\.app|rabbitsoftware-io-status-public\.storage\.googleapis\.com|app\.rabbitsoftware\.io)\//)
})

test('the node panel states the verified chain, the miners and the newest research anchor from the real gateway answers', () => {
  const v = coreView({ chaininfo, mining, nodeinfo }, NOW)
  assert.equal(v.state, 'ok')
  assert.match(v.headline, /^Verified chain of \d+ blocks$/)
  assert.equal(chaininfo.blocks + 1, Number(v.headline.match(/\d+/)[0]))
  assert.ok(v.facts.some((f) => f.label === 'Verified by the node' && /^yes/.test(f.value)))
  assert.ok(v.facts.some((f) => f.label === 'Node' && /maxwell-core 0\.2\.0 · public read-only gateway/.test(f.value)))
  assert.ok(v.facts.some((f) => f.label === 'History conflict' && f.value === 'none'))
  assert.deepEqual(v.kinds.map((k) => k.label), ['research anchors', 'web snapshots (PC)', 'web snapshots (Google Cloud)', 'genesis'])
  assert.match(v.last, /Newest research anchor: block \d+, [\d,]+ records\./)
})

test('a conflict or a failed verification is loud, and an unreachable gateway shows nothing rather than guessing', () => {
  assert.equal(coreView({ chaininfo: { ...chaininfo, conflict: true } }, NOW).state, 'bad')
  assert.match(coreView({ chaininfo: { ...chaininfo, conflict: true } }, NOW).headline, /different history/)
  assert.equal(coreView({ chaininfo: { ...chaininfo, verified: false } }, NOW).state, 'bad')
  for (const broken of [undefined, {}, { chaininfo: null }, { chaininfo: { chain: 'bitcoin' } }]) assert.equal(coreView(broken, NOW).state, 'down')
  const hostile = coreView({ chaininfo: { ...chaininfo, lastsyncresult: '<img onerror=x>'.repeat(10), bestblockhash: 'not hex' } }, NOW)
  assert.ok(hostile.facts.find((f) => f.label === 'Tip hash').value === '?')
  assert.ok(hostile.facts.find((f) => f.label === 'Last sync').value.length < 140)
})

test('the research panel shows the totals, the biggest sources and the newest records', () => {
  const r = researchPanel(research, NOW)
  assert.equal(r.total, research.total)
  assert.ok(r.sources.length > 0 && r.sources.length <= 8)
  assert.deepEqual(r.sources.map((s) => s.count), [...r.sources.map((s) => s.count)].sort((a, b) => b - a))
  assert.ok(r.recent.length > 0 && r.recent.length <= 6)
  assert.equal(researchPanel(null, NOW).state, 'unknown')
})

test('the networks panel combines the independent witnesses, the Bitcoin anchors, the services and the chain copies', () => {
  const n = networksPanel({ witness, proof, latest }, NOW)
  assert.equal(n.witnesses.rows.length, witness.witnesses.length)
  assert.match(n.witnesses.headline, /witnesses signed the current head/)
  assert.match(n.anchors.headline, /anchors were re-checked/)
  assert.ok(n.anchors.witnesses.includes('Bitcoin via OpenTimestamps'))
  assert.deepEqual(n.anchors.notYet, ['Ethereum', 'XRP Ledger'])
  assert.deepEqual([n.services.up, n.services.total], [latest.up, latest.total])
  assert.equal(n.ledger.agree, latest.chain.agree)
  assert.equal(n.ledger.app, latest.chain.app.length)
  const degraded = networksPanel({ latest: { ...latest, services: latest.services.map((s, i) => (i === 0 ? { ...s, ok: false } : s)) } }, NOW)
  assert.equal(degraded.services.down.length, 1)
  const none = networksPanel({}, NOW)
  assert.equal(none.services, null)
  assert.equal(none.ledger, null)
  assert.equal(none.witnesses.state, 'unknown')
})

test('the data panel lists every dataset with its rows, biggest first', () => {
  const d = dataPanel(latest)
  assert.equal(d.datasets.length, latest.tree.length)
  assert.deepEqual(d.datasets.map((x) => x.rows), [...d.datasets.map((x) => x.rows)].sort((a, b) => b - a))
  assert.equal(d.total, latest.tree.reduce((n, x) => n + x.rows, 0))
  assert.deepEqual(dataPanel(null), { datasets: [], total: 0 })
  assert.equal(dataPanel({ tree: [{ id: '../etc', rows: 5 }, { id: 'ok_one', rows: 'many' }] }).datasets.length, 1)
})

test('the agents panel orders the agents by recent activity, marks who is active, and attaches the latest score', () => {
  const a = agentsPanel(agents, scores, NOW)
  assert.equal(a.total, agents.rows.length)
  assert.ok(a.agents.every((x, i, all) => i === 0 || true))
  const byId = Object.fromEntries(a.agents.map((x) => [x.id, x]))
  assert.equal(byId['cloud-task-worker'].state, 'ok')                                  // seen within two hours of NOW in the fixture
  assert.equal(byId['claude-code'].state, 'idle')                                       // last seen days ago
  assert.equal(byId['50346c27ba992a8f'].balance, scores.rows.find((s) => s.node_id === '50346c27ba992a8f').balance)
  assert.equal(a.active, a.agents.filter((x) => x.state === 'ok').length)
  assert.equal(a.agents[0].state, 'ok')                                                 // most recent first
  assert.equal(AGENT_ACTIVE_MIN, 120)
  assert.deepEqual(agentsPanel(null, null, NOW), { agents: [], active: 0, total: 0 })
  const odd = agentsPanel({ rows: [{ node_id: '<script>', kind: 'x' }, { node_id: 'fine', kind: 'a'.repeat(100), last_seen_at: null }] }, null, NOW)
  assert.deepEqual(odd.agents.map((x) => x.id), ['fine'])
  assert.equal(odd.agents[0].seen, 'never')
  assert.ok(odd.agents[0].kind.length <= 24)
})

test('the page script draws with textContent only, uses ids that exist on the page, and the site serves, links and allows the sources for it', () => {
  const js = readFileSync(new URL('../../../site/core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../../../site/core.html', import.meta.url), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/.test(js))
  for (const id of new Set([...js.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]))) assert.ok(html.includes(`id="${id}"`), id)
  assert.ok(html.includes('<script type="module" src="core.js"></script>'))
  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(html))
  const headers = readFileSync(new URL('../../../site/_headers', import.meta.url), 'utf8')
  assert.match(headers, /\/core-view\.mjs\s+Content-Type: application\/javascript/)
  assert.ok(headers.includes('https://maxwell-core-vxx5lz7c5a-wl.a.run.app'), 'the Content-Security-Policy must allow the Core gateway')
  assert.match(readFileSync(new URL('../../../site/sitemap.xml', import.meta.url), 'utf8'), /core\.html/)
  for (const page of ['index.html', 'proof.html', 'network.html']) assert.match(readFileSync(new URL(`../../../site/${page}`, import.meta.url), 'utf8'), /href="core\.html"/, page)
})
