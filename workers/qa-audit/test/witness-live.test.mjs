import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildWitnessLive } from '../src/witness-live.mjs'
import { ORIGIN, cosign, generateKey, parseChainText, verifyChain } from '../src/witness.mjs'

const chainText = readFileSync(new URL('./fixtures/maxwell_chain.json', import.meta.url), 'utf8')
const chain = parseChainText(chainText)
const head = verifyChain(chain)
const NOW = new Date('2026-10-17T16:00:00Z')
const keys = { 'pc-witness': generateKey(), 'cloud-witness': generateKey(), 'alice': generateKey() }
const sign = (name, size = head.size, hash = head.head.hash, when = NOW) => cosign({ name, checkpoint: { origin: ORIGIN, size, hash }, privateKeyPem: keys[name].privateKeyPem, publicKey: keys[name].publicKey, now: when })

const REG = 'https://rabbitsoftware.io/witness/registry.json'
const registry = (extra = {}) => ({ v: 1, k: 2, witnesses: [
  { name: 'pc-witness', kind: 'project', publicKey: keys['pc-witness'].publicKey, url: 'https://x.example/pc.json', note: 'the owner\'s PC' },
  { name: 'cloud-witness', kind: 'project', publicKey: keys['cloud-witness'].publicKey, url: 'https://x.example/cloud.json' },
  { name: 'alice', kind: 'external', publicKey: keys.alice.publicKey, url: 'https://alice.example/cosignature.json' },
], ...extra })

const serve = (files) => async (url) => {
  const u = String(url)
  if (u === REG) return new Response(JSON.stringify(files.registry))
  if (u.split('?')[0].endsWith('/maxwell/maxwell_chain.json')) return new Response(files.chain ?? chainText)
  const body = files[u]
  if (body === undefined) return new Response('', { status: 404 })
  if (body instanceof Error) throw body
  return new Response(typeof body === 'string' ? body : JSON.stringify(body))
}

test('two project witnesses plus an outside peer that all signed the live head meet the rule', async () => {
  const w = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), 'https://x.example/pc.json': sign('pc-witness'), 'https://x.example/cloud.json': sign('cloud-witness'), 'https://alice.example/cosignature.json': sign('alice') }), now: NOW })
  assert.equal(w.version, 1)
  assert.equal(w.trusted, true)
  assert.equal(w.agreeing, 3)
  assert.deepEqual(w.rule, { k: 2, n: 3, maxAgeHours: 48 })
  assert.deepEqual(w.witnesses.map((x) => [x.name, x.kind, x.status]), [['pc-witness', 'project', 'agrees'], ['cloud-witness', 'project', 'agrees'], ['alice', 'external', 'agrees']])
  assert.equal(w.head.size, head.size)
  assert.match(w.summary, /3 of 3 witnesses signed the current head, which meets the rule of 2/)
  assert.ok(!JSON.stringify(w).includes('PRIVATE'))
  assert.equal(w.witnesses[0].note, 'the owner\'s PC')
})

test('one witness is not enough for a rule of two, an unreachable witness is only missing, and an old head is behind', async () => {
  const one = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), 'https://x.example/pc.json': sign('pc-witness'), 'https://x.example/cloud.json': new Error('offline') }), now: NOW })
  assert.equal(one.trusted, false)
  assert.equal(one.agreeing, 1)
  assert.deepEqual(one.witnesses.map((x) => x.status), ['agrees', 'missing', 'missing'])
  assert.match(one.summary, /1 of 3 witnesses signed the current head; the rule needs 2/)
  const older = chain.blocks[9]
  const behind = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), 'https://x.example/pc.json': sign('pc-witness', 10, older.hash), 'https://x.example/cloud.json': sign('cloud-witness') }), now: NOW })
  assert.equal(behind.witnesses[0].status, 'behind')
  assert.equal(behind.agreeing, 1)
})

test('a witness that signed a different history raises an alarm and withholds trust, however many others agree', async () => {
  const w = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), 'https://x.example/pc.json': sign('pc-witness'), 'https://x.example/cloud.json': sign('cloud-witness'), 'https://alice.example/cosignature.json': sign('alice', head.size, 'ee'.repeat(32)) }), now: NOW })
  assert.equal(w.agreeing, 2)
  assert.equal(w.conflicts, 1)
  assert.equal(w.trusted, false)
  assert.equal(w.witnesses[2].status, 'conflict')
  assert.match(w.summary, /not this chain: investigate/)
})

test('a witness that signed a LONGER chain than the copy read here is "ahead", not a conflict: a stale cached copy must not raise a false alarm', async () => {
  const older = JSON.parse(chainText); older.blocks = older.blocks.slice(0, 12)
  const w = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), chain: JSON.stringify(older), 'https://x.example/pc.json': sign('pc-witness'), 'https://x.example/cloud.json': sign('cloud-witness', 12, older.blocks[11].hash) }), now: NOW })
  assert.deepEqual(w.witnesses.slice(0, 2).map((x) => x.status), ['ahead', 'agrees'])
  assert.equal(w.conflicts, 0)
  assert.equal(w.agreeing, 1)
  assert.equal(w.trusted, false)
})

test('forged, mislabelled and oversized inputs are rejected, and unreadable sources give null instead of a wrong answer', async () => {
  const forged = { ...sign('pc-witness'), signature: sign('cloud-witness').signature }
  const mislabelled = sign('alice')                                   // alice's cosignature served under pc-witness's address
  const w = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), 'https://x.example/pc.json': forged, 'https://x.example/cloud.json': mislabelled }), now: NOW })
  assert.deepEqual(w.witnesses.slice(0, 2).map((x) => x.status), ['invalid', 'invalid'])
  assert.equal(w.agreeing, 0)
  const bad = registry({ witnesses: [{ name: '../etc', publicKey: 'x', url: 'https://x' }, { name: 'ok', publicKey: keys.alice.publicKey, url: 'http://insecure.example/x.json' }, null, { name: 'nokey', url: 'https://x' }] })
  const filtered = await buildWitnessLive({ fetchImpl: serve({ registry: bad }), now: NOW })
  assert.deepEqual(filtered.witnesses.map((x) => [x.name, x.status]), [['ok', 'missing']])          // an http address is never fetched
  assert.equal(await buildWitnessLive({ fetchImpl: serve({ registry: 'not json' }), now: NOW }), null)
  assert.equal(await buildWitnessLive({ fetchImpl: serve({ registry: registry(), chain: 'not a chain' }), now: NOW }), null)
  assert.equal(await buildWitnessLive({ fetchImpl: async () => { throw new Error('offline') }, now: NOW }), null)
  const huge = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), 'https://x.example/pc.json': ' '.repeat(30_000) + JSON.stringify(sign('pc-witness')) }), now: NOW })
  assert.equal(huge.witnesses[0].status, 'missing')
  const tampered = chainText.replace('"count": 1512', '"count": 1513')
  const broken = await buildWitnessLive({ fetchImpl: serve({ registry: registry(), chain: tampered, 'https://x.example/pc.json': sign('pc-witness') }), now: NOW })
  assert.equal(broken.chainOk, false)
  assert.equal(broken.trusted, false)
})

test('the status job\'s copy of the witness module is byte-for-byte the public script, and the public registry is a valid, empty-of-secrets list', () => {
  const a = readFileSync(new URL('../../../scripts/witness.mjs', import.meta.url), 'utf8')
  const b = readFileSync(new URL('../src/witness.mjs', import.meta.url), 'utf8')
  assert.equal(b, a, 'run: cp scripts/witness.mjs workers/qa-audit/src/witness.mjs')
  const reg = JSON.parse(readFileSync(new URL('../../../site/witness/registry.json', import.meta.url), 'utf8'))
  assert.equal(reg.v, 1)
  assert.ok(Number.isInteger(reg.k) && reg.k >= 1)
  for (const w of reg.witnesses) {
    assert.match(w.name, /^[a-z0-9][a-z0-9._-]{0,39}$/)
    assert.ok(/^https:\/\//.test(w.url), w.name)
    assert.ok(Buffer.from(w.publicKey, 'base64').length > 30 && Buffer.from(w.publicKey, 'base64').length < 100, `${w.name} public key`)
    assert.ok(!/PRIVATE|BEGIN/.test(JSON.stringify(w)), `${w.name}: no private material`)
  }
  assert.equal(new Set(reg.witnesses.map((w) => w.name)).size, reg.witnesses.length)
  assert.equal(new Set(reg.witnesses.map((w) => w.publicKey)).size, reg.witnesses.length)
})
