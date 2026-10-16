import assert from 'node:assert/strict'
import test from 'node:test'
import { TOOLBOX_URL, agentCard, handleRpc, interpret, makeServer } from './server.mjs'

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

// ---- the toolbox skill ----
const GH = 'https://github.com/therealsickonechase-bit/'
const slice = (over = {}) => ({
  version: 1, generatedAt: '2026-10-16T12:00:00Z', root: 'ab'.repeat(32), counts: { files: 709, commands: 284, publicCommands: 3 },
  commands: [
    { id: 'chain-head', group: 'Public chain', label: 'Read the head of the public chain', command: 'curl https://app.rabbitsoftware.io/api/chain/head', description: 'Length and head hash.',
      files: [{ repo: 'rabbit-web', path: 'src/app/api/chain/head/route.ts', sha256: 'c'.repeat(64), url: GH + 'rabbit-web/blob/main/src/app/api/chain/head/route.ts' }] },
    { id: 'chain-dna', group: 'Public chain', label: 'The chain head as DNA letters', command: 'curl https://app.rabbitsoftware.io/api/chain/dna', description: 'A=00 C=01 G=10 T=11.', files: [] },
    { id: 'web-test-auth', group: 'Checks', label: 'Run all unit tests', command: 'npm run test:auth', description: 'node --test', files: [] },
  ],
  ...over,
})
const toolboxFetch = (data = slice(), log = []) => async (url) => { log.push(String(url)); if (String(url) === TOOLBOX_URL) return json(data); throw new Error('unexpected ' + url) }

test('the card lists the toolbox skill and the words that ask for it are recognised, without stealing source searches', () => {
  assert.ok(agentCard('https://x').skills.some((s) => s.id === 'toolbox' && s.tags.includes('commands')))
  assert.equal(interpret(msg('toolbox: chain').params.message).action, 'toolbox')
  assert.equal(interpret(msg('which commands read the public chain?').params.message).action, 'toolbox')
  assert.deepEqual(interpret({ parts: [{ kind: 'data', data: { skill: 'toolbox', query: 'dna' } }] }), { action: 'toolbox', query: 'dna' })
  assert.equal(interpret(msg('pubmed: BRCA1 commands').params.message).action, 'search')
  assert.equal(interpret(msg('Find clinical trials for glioma').params.message).source, 'clinicaltrials')
})

test('a toolbox question returns matching guest commands with links into the public repositories, and the bundle it comes from', async () => {
  const seen = []
  const r = await handleRpc(msg('which commands read the public chain?'), toolboxFetch(slice(), seen))
  const text = r.result.parts[0].text
  assert.match(text, /chain-head: Read the head of the public chain/)
  assert.match(text, /files: https:\/\/github\.com\/therealsickonechase-bit\/rabbit-web\/blob\/main\/src\/app\/api\/chain\/head\/route\.ts/)
  assert.match(text, /Toolbox bundle abababababab \(709 files, 284 commands in all\)/)
  assert.match(text, /Owner-only commands and private files are not listed here/)
  assert.ok(!text.includes('web-test-auth'))                                    // does not match the question
  assert.deepEqual(seen, [TOOLBOX_URL])                                          // only the one fixed public address
  assert.equal(r.result.parts[1].data.commands.length, 2)
})

test('with no topic the skill lists what a guest may use, and an unmatched topic says which groups exist', async () => {
  const all = await handleRpc(msg('list the toolbox commands'), toolboxFetch())
  assert.match(all.result.parts[0].text, /3 commands a guest may use/)
  const none = await handleRpc(msg('toolbox: zebra'), toolboxFetch())
  assert.match(none.result.parts[0].text, /No guest command matches "zebra"\. Groups: Public chain \(2\), Checks \(1\)/)
})

test('only github links in the public repositories are passed on, and odd data is trimmed or dropped', async () => {
  const bad = slice({ commands: [{ id: 'x', group: 'g', label: 'l', command: 'c', description: 'd'.repeat(900), files: [
    { path: 'a', url: 'https://evil.example.com/steal', sha256: '1' }, { path: 'b', url: 'http://github.com/therealsickonechase-bit/x/blob/main/b', sha256: '2' },
    { path: 'ok', url: GH + 'rabbit-web/blob/main/ok.ts', sha256: '3' }] }, { nope: true }] })
  const r = await handleRpc(msg('toolbox: x'), toolboxFetch(bad))
  const c = r.result.parts[1].data.commands[0]
  assert.deepEqual(c.files.map((f) => f.path), ['ok'])
  assert.equal(c.description.length, 300)
  assert.equal(r.result.parts[1].data.commands.length, 1)
  assert.ok(!JSON.stringify(r).includes('evil.example.com'))
})

test('the skill never exposes private material even if it were published by mistake into the slice text, and failures are polite', async () => {
  const down = await handleRpc(msg('toolbox: chain'), async () => json({}, 500))
  assert.match(down.result.parts[0].text, /could not read the toolbox/)
  const odd = await handleRpc(msg('toolbox: chain'), toolboxFetch({ version: 2, commands: 'x' }))
  assert.match(odd.result.parts[0].text, /not in the expected shape/)
  const src = (await import('node:fs')).readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.ok(!/storage\.googleapis\.com\/storage\/v1|rabbitsoftware-io-backups|metadata\.google\.internal/.test(src))     // no path to the private toolbox or to credentials
})
