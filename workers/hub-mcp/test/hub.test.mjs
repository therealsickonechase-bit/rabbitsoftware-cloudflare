import assert from 'node:assert/strict'
import test from 'node:test'
import { LINKS, LINK_GROUPS, ORIGINS, TOOLS, bearerFrom, buildUrl, checkKey, handleRpc, htmlToText } from '../src/hub.mjs'

const call = (name, args = {}, fetchImpl = async () => { throw new Error('no network in this test') }) =>
  handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { fetchImpl, now: () => 1_800_000_000_000 })
const textOf = (out) => out.result.content[0].text
const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

test('initialize negotiates a supported protocol and advertises tools only', async () => {
  const out = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, {})
  assert.equal(out.result.protocolVersion, '2025-06-18')
  assert.deepEqual(Object.keys(out.result.capabilities), ['tools', 'prompts', 'resources'])
  const old = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, {})
  assert.equal(old.result.protocolVersion, '2025-06-18')
})

test('notifications get no body, unknown methods are errors, junk is rejected', async () => {
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}), null)
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 3, method: 'nope' }, {})).error.code, -32601)
  assert.equal((await handleRpc([], {})).error.code, -32600)
  assert.equal((await handleRpc({ id: 1, method: 'ping' }, {})).error.code, -32600)
})

test('every tool is read-only, has a strict schema and is listed once', async () => {
  const out = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {})
  const names = out.result.tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  for (const t of out.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name)
    assert.equal(t.inputSchema.additionalProperties, false, t.name)
  }
  for (const needed of ['hub_links', 'hub_status', 'chain_head', 'data_rows', 'site_page', 'shell_propose']) assert.ok(names.includes(needed), needed)
  assert.ok(!names.some((n) => /exec|run_command|shell_run|write|delete/.test(n)), 'no tool may execute or write')
})

test('unexpected and missing arguments are refused', async () => {
  assert.equal((await call('hub_links', { evil: 1 })).result.isError, true)
  assert.equal((await call('data_rows', {})).result.isError, true)
  assert.equal((await call('no_such_tool')).error.code, -32602)
})

test('the link catalog is complete and well formed', async () => {
  assert.ok(LINKS.length >= 20)
  for (const l of LINKS) { assert.ok(new URL(l.url).protocol === 'https:', l.name); assert.ok(l.about.length > 5) }
  const all = JSON.parse(textOf(await call('hub_links')))
  assert.equal(all.length, LINKS.length)
  const shells = JSON.parse(textOf(await call('hub_links', { group: 'shell' })))
  assert.ok(shells.every((l) => l.group === 'shell') && shells.length >= 1)
  assert.equal((await call('hub_links', { group: 'nope' })).result.isError, true)
  assert.ok(LINK_GROUPS.includes('api'))
})

test('URLs are built on fixed origins and cannot be pointed at another host', () => {
  assert.equal(buildUrl(ORIGINS.app, '/api/chain/head'), 'https://app.rabbitsoftware.io/api/chain/head')
  for (const bad of ['//evil.example/x', '/\\evil.example', '/../etc', '', 'api/x', '/a b', '/x\n', 5, null]) assert.throws(() => buildUrl(ORIGINS.app, bad), String(bad))
  assert.equal(new URL(buildUrl(ORIGINS.site, '/a?b=c')).origin, ORIGINS.site)
})

test('site_page refuses scheme-relative paths and never fetches another host', async () => {
  const seen = []
  const out = await call('site_page', { path: '//evil.example/x' }, async (url) => { seen.push(url); return reply(200, 'x') })
  assert.equal(out.result.isError, true)
  assert.deepEqual(seen, [])
  const ok = await call('site_page', { path: '/about' }, async (url) => { seen.push(url); return reply(200, '<html><script>steal()</script><h1>About</h1><p>Rabbit &amp; co</p></html>') })
  assert.deepEqual(seen, ['https://rabbitsoftware.io/about'])
  assert.equal(textOf(ok), 'About\nRabbit & co')
})

test('htmlToText drops scripts, styles and tags', () => {
  assert.equal(htmlToText('<style>a{}</style><p>Hi <b>you</b></p><!-- c -->'), 'Hi you')
})

test('data_rows validates every part of the query before calling out', async () => {
  const seen = []
  const f = async (url) => { seen.push(url); return reply(200, { rows: [] }) }
  await call('data_rows', { dataset: 'research_records', limit: 5, q: 'brain cancer', cursor: 'eyJvIjoxfQ' }, f)
  assert.equal(seen[0], 'https://app.rabbitsoftware.io/api/data/research_records?limit=5&q=brain%20cancer&cursor=eyJvIjoxfQ')
  for (const bad of [{ dataset: '../x' }, { dataset: 'a/b' }, { dataset: 'ok', limit: 500 }, { dataset: 'ok', cursor: 'a b' }, { dataset: 'ok', q: 'x'.repeat(81) }]) {
    assert.equal((await call('data_rows', bad, f)).result.isError, true, JSON.stringify(bad))
  }
  assert.equal(seen.length, 1)
})

test('hub_status reports each part and survives failures', async () => {
  const f = async (url) => {
    if (url.includes('run.rabbitsoftware.io')) throw new Error('down')
    if (url.includes('/health') && url.includes('workers.dev')) return reply(200, '{"ok":true}')
    if (url.includes('/api/health')) return reply(200, '{"status":"ok"}')
    if (url.includes('/api/chain/head')) return reply(200, '{"headHash":"x"}')
    if (url.includes('/api/data')) return reply(200, '{"datasets":[]}')
    return reply(200, '<html>RabbitSoftware</html>')
  }
  const status = JSON.parse(textOf(await call('hub_status', {}, f)))
  assert.equal(status.rows.length, 8)
  assert.equal(status.allOk, false)
  assert.equal(status.rows.find((r) => r.name === 'Cloud Run mirror').ok, false)
  assert.equal(status.rows.find((r) => r.name === 'Website').ok, true)
})

test('shell_propose never executes anything and refuses multi-line input', async () => {
  const seen = []
  const out = await call('shell_propose', { command: 'ledger', why: 'look at the chain' }, async (u) => { seen.push(u); return reply(200, '') })
  const body = JSON.parse(textOf(out))
  assert.equal(body.executed, false)
  assert.equal(body.run_it_at, 'https://app.rabbitsoftware.io/cloudshell-public')
  assert.deepEqual(seen, [])
  for (const bad of ['ls\nrm -rf ~', 'ls\r', '', '   ', 'x'.repeat(501)]) assert.equal((await call('shell_propose', { command: bad })).result.isError, true)
})

test('API keys: only the rbk_ format is accepted and it is verified by the app', async () => {
  const key = 'rbk_' + 'A'.repeat(32)
  assert.equal(bearerFrom(`Bearer ${key}`), key)
  for (const bad of [undefined, '', 'Bearer abc', `Basic ${key}`, `Bearer ${key} extra`, 'Bearer rbk_short']) assert.equal(bearerFrom(bad), null)
  assert.equal(await checkKey(async () => reply(200, '{}'), key), 'ok')
  assert.equal(await checkKey(async () => reply(401, '{}'), key), 'invalid')
  assert.equal(await checkKey(async () => reply(429, '{}'), key), 'rate')
  assert.equal(await checkKey(async () => reply(500, '{}'), key), 'unavailable')
  assert.equal(await checkKey(async () => { throw new Error('x') }, key), 'unavailable')
})

test('tool failures do not leak details', async () => {
  const out = await call('chain_head', {}, async () => { throw new TypeError('secret path /etc/x') })
  assert.equal(out.result.isError, true)
  assert.ok(!textOf(out).includes('/etc/x'))
  assert.equal(TOOLS.length, 25)
})
