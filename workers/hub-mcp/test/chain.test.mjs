import assert from 'node:assert/strict'
import test from 'node:test'
import { handleRpc } from '../src/hub.mjs'

const call = async (name, args, fetchImpl) => (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { fetchImpl, now: () => 0, tier: 'public' })).result
const body = (r) => JSON.parse(r.content[0].text)
const reply = (v, status = 200) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status })

const blocks = [
  { index: 0, hash: 'aaaa1111', previous_hash: '00000000', transactions: [] },
  { index: 1, hash: 'bbbb2222', previous_hash: 'aaaa1111', transactions: [] },
]
const appLedger = { since: 0, count: 2, events: blocks.map((b, i) => ({ seq: i + 1, table: 'maxwell_chain', op: 'insert', row_id: String(i), payload: b })) }
const router = (overrides = {}) => async (url) => {
  const u = new URL(url)
  const key = `${u.host}${u.pathname}`
  const table = {
    'app.rabbitsoftware.io/api/chain/head': { length: 2, headHash: 'headhash123' },
    'app.rabbitsoftware.io/api/chain/ledger': appLedger,
    'rabbitsoftware-io-ledger-public.storage.googleapis.com/ledger/chain_head.json': { length: 2, headHash: 'headhash123' },
    'rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json': { chain: blocks },
    ...overrides,
  }
  if (!(key in table)) throw new Error('unexpected request ' + key)
  return table[key] instanceof Response ? table[key] : reply(table[key])
}

test('ledger_mirror reads only the three named objects of the public bucket', async () => {
  const seen = []
  const f = async (url) => { seen.push(url); return reply('{"ok":1}') }
  await call('ledger_mirror', { object: 'chain_head' }, f)
  await call('ledger_mirror', { object: 'maxwell_chain' }, f)
  // every read of the public bucket carries a minute-sized cache-buster, because the bucket caches its objects for an hour
  assert.deepEqual(seen.map((u) => u.replace(/\?cb=\d+$/, '')), ['https://rabbitsoftware-io-ledger-public.storage.googleapis.com/ledger/chain_head.json', 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json'])
  assert.ok(seen.every((u) => /\?cb=\d+$/.test(u)))
  for (const bad of ['../backups', 'maxwell/../x', 'chain_head.json', '', 'private']) assert.equal((await call('ledger_mirror', { object: bad }, f)).isError, true, bad)
  assert.equal(seen.length, 2)
})

test('chain_consistency passes when the app and the bucket agree', async () => {
  const out = body(await call('chain_consistency', {}, router()))
  assert.equal(out.allOk, true, JSON.stringify(out.checks.filter((c) => !c.ok)))
  assert.equal(out.checks.length, 6)
})

test('chain_consistency reports a different head, a different block and a broken link', async () => {
  const forked = [blocks[0], { ...blocks[1], hash: 'cccc3333' }]
  const diff = body(await call('chain_consistency', {}, router({ 'rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json': { chain: forked } })))
  assert.equal(diff.allOk, false)
  assert.equal(diff.checks.find((c) => c.name === 'Maxwell chain: identical block hashes').ok, false)
  const head = body(await call('chain_consistency', {}, router({ 'rabbitsoftware-io-ledger-public.storage.googleapis.com/ledger/chain_head.json': { length: 3, headHash: 'other' } })))
  assert.equal(head.checks.find((c) => c.name === 'app and bucket report the same head hash').ok, false)
  const broken = [blocks[0], { ...blocks[1], previous_hash: 'zzzz' }]
  const link = body(await call('chain_consistency', {}, router({ 'rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json': { chain: broken } })))
  assert.equal(link.checks.find((c) => c.name.includes('bucket copy')).ok, false)
})

test('chain_consistency says so when a system cannot be read, without leaking details', async () => {
  const out = body(await call('chain_consistency', {}, async () => { throw new TypeError('boom /secret/path') }))
  assert.equal(out.allOk, false)
  assert.ok(!JSON.stringify(out).includes('/secret/path'), 'the raw error message must not be shown')
  assert.equal(out.checks[0].name, 'could read both systems')
  assert.equal(out.checks[0].detail, 'TypeError')
  const notFound = body(await call('chain_consistency', {}, router({ 'rabbitsoftware-io-ledger-public.storage.googleapis.com/ledger/chain_head.json': reply('nope', 404) })))
  assert.equal(notFound.allOk, false)
})
