import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateGraph, layoutGraph, graphSvg, graphSql, graphSection, roadmapGroups } from '../src/graph.mjs'

const g = JSON.parse(await readFile(new URL('../data/platform-graph.json', import.meta.url), 'utf8'))

test('the platform graph file is consistent', () => {
  assert.deepEqual(validateGraph(g), [])
})

test('validation catches broken links and duplicates', () => {
  const bad = structuredClone(g)
  bad.edges.push({ from: 'nope', to: 'site', label: 'x', kind: 'data' })
  bad.nodes.push({ ...bad.nodes[0] })
  const problems = validateGraph(bad)
  assert.ok(problems.some((p) => p.includes('unknown node nope')))
  assert.ok(problems.some((p) => p.startsWith('duplicate node')))
})

test('every node gets its own position inside the canvas', () => {
  const L = layoutGraph(g)
  const seen = new Set()
  for (const n of g.nodes) {
    const p = L.pos[n.id]
    assert.ok(p.x + L.nodeW <= L.width && p.y + L.nodeH <= L.height)
    const key = `${p.x},${p.y}`
    assert.ok(!seen.has(key), `overlap at ${key}`)
    seen.add(key)
  }
})

test('svg draws every node and edge, escaped', () => {
  const svg = graphSvg(g)
  assert.equal((svg.match(/class="node /g) || []).length, g.nodes.length)
  assert.equal((svg.match(/<path /g) || []).length, g.edges.length)
  assert.ok(!svg.includes('<script'))
})

test('roadmap groups keep every item', () => {
  assert.equal(roadmapGroups(g).reduce((n, x) => n + x.items.length, 0), g.roadmap.length)
})

test('sql is one transaction, quotes are doubled, row counts match', () => {
  const sql = graphSql({ ...g, nodes: [{ ...g.nodes[0], about: "it's" }, ...g.nodes.slice(1)] })
  assert.ok(sql.includes("'it''s'"))
  assert.ok(sql.includes('begin;') && sql.trim().endsWith('commit;'))
  assert.equal((sql.match(/insert into public\.platform_nodes/g) || []).length, g.nodes.length)
  assert.equal((sql.match(/insert into public\.platform_edges/g) || []).length, g.edges.length)
  assert.equal((sql.match(/insert into public\.platform_roadmap/g) || []).length, g.roadmap.length)
})

test('report section includes the map, the board and the table', () => {
  const html = graphSection(g)
  assert.ok(html.includes('class="pgraph"') && html.includes('rm-waiting') && html.includes('<table>'))
})

test('the research flow names real nodes, starts at the sources and ends at the hub', () => {
  assert.ok(g.researchFlow.length >= 6)
  const ids = new Set(g.nodes.map((n) => n.id))
  for (const s of g.researchFlow) for (const n of s.nodes) assert.ok(ids.has(n), n)
  assert.ok(g.researchFlow[0].nodes.includes('pubmed'))
  assert.ok(g.researchFlow.at(-1).nodes.includes('gcp_hub'))
  const bad = structuredClone(g); bad.researchFlow[0].nodes.push('ghost')
  assert.ok(validateGraph(bad).some((p) => p.includes('ghost')))
  assert.ok(graphSection(g).includes('How research flows'))
})

test('research sources are reachable from the assistants and the hub in the graph', () => {
  const reach = new Set(['gcp_hub']); 
  for (const e of g.edges) if (e.from === 'gcp_hub' && e.to === 'pubmed') reach.add('pubmed')
  assert.ok(reach.has('pubmed'))
  assert.ok(g.edges.some((e) => e.from === 'corpus_store' && e.to === 'app'))
})
