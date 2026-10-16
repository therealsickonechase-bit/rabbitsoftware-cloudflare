import assert from 'node:assert/strict'
import test from 'node:test'
import { handleRpc } from '../src/hub.mjs'
import { NORMALIZE, PLANS, SOURCES, SOURCE_IDS, validateSearch } from '../src/research.mjs'

const openalex = { results: [
  { id: 'https://openalex.org/W111', title: 'Antigravity: A crazy idea?', publication_year: 1979, doi: 'https://doi.org/10.1016/0370-2693(79)90463-5', cited_by_count: 12, primary_location: { source: { display_name: 'Physics Letters B' } } },
  { id: 'https://openalex.org/W222', title: 'No DOI paper', publication_year: 2021, doi: null, cited_by_count: 0, primary_location: null },
  { id: 'https://evil.example.com/W3', title: 'Bad id', publication_year: 2000 }, { id: 'https://openalex.org/W4', title: '' },
] }
const inspire = { hits: { hits: [
  { metadata: { control_number: 2835822, titles: [{ title: 'Do We Live in an Antigravity Universe?' }], preprint_date: '2024-09-24', arxiv_eprints: [{ value: '2409.18145' }], citation_count: 3 } },
  { metadata: { control_number: 1330152, titles: [{ title: 'Antigravity in F(R) theories' }], dois: [{ value: '10.1103/PhysRevD.1' }] } },
  { metadata: { control_number: 99, titles: [{ title: 'Neither' }] } },
  { metadata: { control_number: 'x', titles: [{ title: 'Bad id' }] } },
] } }

test('the two physics sources are listed, have fixed plans on their own hosts, and normalise to plain fields', () => {
  assert.ok(SOURCE_IDS.includes('openalex') && SOURCE_IDS.includes('inspirehep'))
  assert.equal(PLANS.openalex('antigravity', 5).first.origin, 'https://api.openalex.org')
  assert.equal(PLANS.inspirehep('antigravity', 5).first.origin, 'https://inspirehep.net')
  assert.match(PLANS.openalex('a b&c=d', 3).first.path, /search=a%20b%26c%3Dd&per-page=3/)
  assert.ok(Object.isFrozen(PLANS))
  const o = NORMALIZE.openalex(openalex)
  assert.deepEqual(o.map((x) => x.id), ['openalex:W111', 'openalex:W222'])                       // a foreign id and an empty title are dropped
  assert.equal(o[0].url, 'https://doi.org/10.1016/0370-2693(79)90463-5')
  assert.equal(o[0].journal, 'Physics Letters B')
  assert.equal(o[1].url, 'https://openalex.org/W222')
  const i = NORMALIZE.inspirehep(inspire)
  assert.deepEqual(i.map((x) => x.id), ['inspire:2835822', 'inspire:1330152', 'inspire:99'])
  assert.deepEqual(i.map((x) => x.url), ['https://arxiv.org/abs/2409.18145', 'https://doi.org/10.1103/PhysRevD.1', 'https://inspirehep.net/literature/99'])
  assert.deepEqual(NORMALIZE.openalex(null), [])
  assert.deepEqual(NORMALIZE.inspirehep({}), [])
  assert.equal(validateSearch({ source: 'openalex', query: 'antigravity', limit: 5 }), null)
})

const ANCHOR = { block: 7, hash: '00bd0bae38a9f35c', root: 'a'.repeat(64), count: 918, time: '2026-10-16T16:43:32.000Z', chainLength: 9, headHash: '00f7128e71731d86' }
const live = { version: 1, generatedAt: '2026-10-16T20:21:29.456Z', total: 1309, topics: { explored: 47 }, maxwell: ANCHOR }
const stored = { rows: [
  { id: 'physics_paper:W111', source: 'physics_paper', title: 'Antigravity: A crazy idea?', url: 'https://doi.org/10.1016/0370-2693(79)90463-5', first_seen_at: '2026-10-16T10:00:00+00:00' },
  { id: 'physics_paper:W9', source: 'physics_paper', title: 'A newer stored paper', url: 'https://openalex.org/W9', first_seen_at: '2026-10-16T19:00:00+00:00' },
] }
const seen = []
const world = (over = {}) => async (url) => {
  const u = new URL(url)
  seen.push(u.host)
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status })
  if (over[u.host]) return over[u.host](u)
  if (u.host === 'api.openalex.org') return json(openalex)
  if (u.host === 'inspirehep.net') return json(inspire)
  if (u.host === 'app.rabbitsoftware.io') return json(stored)
  if (u.host === 'rabbitsoftware-io-status-public.storage.googleapis.com') return json(live)
  if (u.host === 'www.ebi.ac.uk') return json({ resultList: { result: [{ id: '1', source: 'MED', title: 'Euro paper', pubYear: '2024' }] } })
  if (u.host === 'eutils.ncbi.nlm.nih.gov') return json({ esearchresult: { idlist: [] } })
  throw new Error('unexpected host ' + u.host)
}
const call = async (args, fetchImpl) => (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'research_link', arguments: args } }, { fetchImpl, now: () => 0, tier: 'public' })).result
const body = (r) => JSON.parse(r.content[0].text)

test('research_link searches several public sources, RabbitOS, Maxwell and Google Cloud in one answer', async () => {
  seen.length = 0
  const r = await call({ query: 'antigravity', sources: ['openalex', 'inspirehep'] }, world())
  const out = body(r)
  assert.deepEqual(out.live.map((l) => l.source), ['openalex', 'inspirehep'])
  assert.equal(out.live[0].items[0].title, 'Antigravity: A crazy idea?')
  assert.equal(out.live[0].items[0].inRabbitOS, true)                      // RabbitOS already stores it
  assert.equal(out.live[0].items[1].inRabbitOS, false)
  assert.equal(out.rabbitos.records.length, 2)
  assert.deepEqual(out.rabbitos.records[0].maxwell, { status: 'covered', block: 7, root: ANCHOR.root, recordsInAnchor: 918, minedAt: ANCHOR.time })
  assert.equal(out.rabbitos.records[1].maxwell.status, 'not yet')          // first seen after the anchor was mined
  assert.match(out.rabbitos.records[1].maxwell.why, /block 7/)
  assert.equal(out.maxwell.latestResearchAnchor.count, 918)
  assert.equal(out.googleCloud.publicRecords, 1309)
  assert.equal(out.googleCloud.maxwellMirror.chainLength, 9)
  assert.match(out.caution, /not endorsements/)
  assert.deepEqual([...new Set(seen)].sort(), ['api.openalex.org', 'app.rabbitsoftware.io', 'inspirehep.net', 'rabbitsoftware-io-status-public.storage.googleapis.com'])
})

test('without a source list it uses the four default sources, and one failing source never hides the others', async () => {
  const r = body(await call({ query: 'antigravity' }, world({ 'api.openalex.org': () => new Response('', { status: 503 }) })))
  assert.deepEqual(r.live.map((l) => l.source), ['openalex', 'inspirehep', 'europepmc', 'pubmed'])
  assert.match(r.live[0].error, /OpenAlex returned 503/)
  assert.equal(r.live[0].items.length, 0)
  assert.equal(r.live[1].items.length, 3)
})

test('when RabbitOS or Google Cloud cannot be read the answer says so instead of failing', async () => {
  const r = body(await call({ query: 'antigravity', sources: ['inspirehep'] }, world({
    'app.rabbitsoftware.io': () => new Response('', { status: 500 }), 'rabbitsoftware-io-status-public.storage.googleapis.com': () => new Response('', { status: 404 }) })))
  assert.equal(r.rabbitos.records.length, 0)
  assert.match(r.rabbitos.error, /data hub returned 500/)
  assert.deepEqual(r.maxwell, { unavailable: true })
  assert.deepEqual(r.googleCloud, { unavailable: true })
  assert.equal(r.live[0].items[0].inRabbitOS, false)
})

test('records without an anchor are reported as unknown, and a record seen exactly at the anchor time is covered', async () => {
  const noAnchor = body(await call({ query: 'x1', sources: ['openalex'] }, world({ 'rabbitsoftware-io-status-public.storage.googleapis.com': () => new Response(JSON.stringify({ version: 1, generatedAt: 'g', total: 1 })) })))
  assert.equal(noAnchor.rabbitos.records[0].maxwell.status, 'unknown')
  const edge = body(await call({ query: 'x2', sources: ['openalex'] }, world({ 'app.rabbitsoftware.io': () => new Response(JSON.stringify({ rows: [{ id: 'r', source: 's', title: 't', url: null, first_seen_at: ANCHOR.time }] })) })))
  assert.equal(edge.rabbitos.records[0].maxwell.status, 'covered')
})

test('bad input is refused before anything is fetched', async () => {
  seen.length = 0
  const bad = [{}, { query: 'x' }, { query: 'ok query', sources: [] }, { query: 'ok query', sources: ['nope'] }, { query: 'ok query', sources: ['openalex', 'openalex'] },
    { query: 'ok query', sources: ['pubmed', 'europepmc', 'openalex', 'inspirehep', 'openfda'] }, { query: 'ok query', limit: 99 }, { query: 'line' + String.fromCharCode(10) + 'break' }, { query: 'ok query', extra: 1 }]
  for (const args of bad) {
    const r = await call(args, world())
    assert.equal(r.isError, true, JSON.stringify(args))
  }
  assert.equal(seen.length, 0)
})

test('untrusted text from the sources cannot smuggle newlines into titles or a script link into the url', async () => {
  const evil = { results: [{ id: 'https://openalex.org/W5', title: 'A' + String.fromCharCode(10, 10) + '  title <b>x</b>  with   gaps', publication_year: 2020, doi: 'javascript:alert(1)' }] }
  const r = body(await call({ query: 'antigravity', sources: ['openalex'] }, world({ 'api.openalex.org': () => new Response(JSON.stringify(evil)) })))
  assert.equal(r.live[0].items[0].title, 'A title <b>x</b> with gaps')                          // one line; the hub marks all of it untrusted data
  assert.equal(r.live[0].items[0].url, 'https://openalex.org/W5')                               // a javascript: link is never passed on
  assert.ok(SOURCES.openalex.about.length > 20)
})
