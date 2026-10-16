import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCard, handleRpc, interpret, makeServer } from './server.mjs'

const json = (v, status = 200) => new Response(JSON.stringify(v), { status })
const fakeFetch = (log = []) => async (url) => {
  log.push(String(url))
  const u = new URL(url)
  if (u.host === 'eutils.ncbi.nlm.nih.gov' && u.pathname.includes('esearch')) return json({ esearchresult: { idlist: ['111', '222'] } })
  if (u.host === 'eutils.ncbi.nlm.nih.gov') return json({ result: { uids: ['111', '222'], 111: { title: 'BRCA1 paper', fulljournalname: 'J', pubdate: '2026' }, 222: { title: 'Another', fulljournalname: 'K', pubdate: '2025' } } })
  if (u.host === 'api.fda.gov') return json({ results: [{ term: 'NAUSEA', count: 12 }] })
  if (u.host === 'www.ebi.ac.uk') return json({ resultList: { result: [{ id: '1', source: 'MED', title: 'Euro paper', pubYear: '2024' }] } })
  throw new Error('unexpected host ' + u.host)
}
const msg = (text) => ({ jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text }] } } })

test('the agent card names the agent, its protocol version, transport and skills', () => {
  const c = agentCard('https://example.run.app')
  assert.equal(c.url, 'https://example.run.app')
  assert.equal(c.protocolVersion, '0.3.0')
  assert.equal(c.preferredTransport, 'JSONRPC')
  assert.ok(c.skills.length >= 4 && c.skills.every((s) => s.id && s.name && s.description && s.tags.length))
  assert.equal(c.capabilities.streaming, false)
})

test('words are mapped to the right public source and the query is cleaned', () => {
  assert.deepEqual(interpret(msg('pubmed: BRCA1 breast cancer').params.message), { action: 'search', source: 'pubmed', query: 'BRCA1 breast cancer', limit: 5 })
  assert.equal(interpret(msg('Find clinical trials for glioma').params.message).source, 'clinicaltrials')
  assert.equal(interpret(msg('side effects of metformin').params.message).source, 'openfda')
  assert.equal(interpret(msg('recent papers on SLC6A4 in Europe PMC').params.message).source, 'europepmc')
  assert.equal(interpret(msg('what sources can you search?').params.message).action, 'sources')
  assert.equal(interpret({ parts: [{ kind: 'data', data: { source: 'openfda', query: 'aspirin', limit: 3 } }] }).limit, 3)
  assert.equal(interpret({ parts: [] }).action, 'error')
})

test('message/send returns a message with readable text and structured data, and only fixed public hosts are called', async () => {
  const seen = []
  const r = await handleRpc(msg('pubmed: BRCA1'), fakeFetch(seen))
  assert.equal(r.id, 7)
  assert.equal(r.result.role, 'agent')
  assert.match(r.result.parts[0].text, /2 result\(s\) from PubMed/)
  assert.equal(r.result.parts[1].data.items[0].url, 'https://pubmed.ncbi.nlm.nih.gov/111/')
  assert.ok(seen.every((u) => new URL(u).host === 'eutils.ncbi.nlm.nih.gov'), seen.join())
  const fda = await handleRpc(msg('openfda: metformin'), fakeFetch())
  assert.match(fda.result.parts[0].text, /NAUSEA \(12 reports\)/)
})

test('bad input and unsupported methods give JSON-RPC errors; a failing source gives a polite message, not a crash', async () => {
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tasks/get' })).error.code, -32601)
  assert.equal((await handleRpc({ nope: true })).error.code, -32600)
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 2, method: 'message/send', params: { message: { parts: [] } } })).error.code, -32602)
  const down = await handleRpc(msg('pubmed: BRCA1'), async () => json({}, 500))
  assert.match(down.result.parts[0].text, /could not do that search/)
  const tooLong = await handleRpc(msg('pubmed: ' + 'x'.repeat(300)), fakeFetch())
  assert.ok(tooLong.result.parts[0].text.length > 0)
})

test('the HTTP server serves the card, health and RPC, refuses big bodies and unknown paths', async () => {
  const server = makeServer(fakeFetch()).listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal(await (await fetch(`${base}/health`)).text(), 'ok')
    const card = await (await fetch(`${base}/.well-known/agent-card.json`, { headers: { 'x-forwarded-proto': 'http' } })).json()
    assert.equal(card.name, 'RabbitOS Research Agent')
    assert.match(card.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const rpc = await (await fetch(base, { method: 'POST', body: JSON.stringify(msg('pubmed: BRCA1')) })).json()
    assert.equal(rpc.result.kind, 'message')
    assert.equal((await fetch(base, { method: 'POST', body: 'x'.repeat(20000) })).status, 413)
    assert.equal((await fetch(base, { method: 'POST', body: '{not json' })).status, 400)
    assert.equal((await fetch(`${base}/admin`)).status, 404)
  } finally { server.close() }
})
