import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runWitness } from '../../witness-job/run.mjs'
import { ORIGIN, generateKey, parseChainText, verifyCosignature } from '../../witness-job/witness.mjs'

const real = readFileSync(new URL('./fixtures/maxwell_chain.json', import.meta.url), 'utf8')
const key = generateKey()
const NOW = new Date('2026-10-17T17:00:00Z')

function bucket() {
  const files = new Map()
  const logs = []
  return { files, logs, readObject: async (p) => files.get(p) ?? null, writeObject: async (p, body) => { files.set(p, body) }, log: (event, fields) => logs.push({ event, ...fields }) }
}
const go = (b, text, over = {}) => runWitness({ name: 'cloud-witness', pem: key.privateKeyPem, readObject: b.readObject, writeObject: b.writeObject, fetchChainText: async () => text, now: NOW, log: b.log, ...over })

test('the cloud witness verifies the live chain, signs its head, and writes only its own two files', async () => {
  const b = bucket()
  assert.equal(await go(b, real), 0)
  assert.deepEqual([...b.files.keys()].sort(), ['witness/cloud-witness/cosignature.json', 'witness/cloud-witness/state.json'])
  const c = JSON.parse(b.files.get('witness/cloud-witness/cosignature.json'))
  const chain = parseChainText(real)
  assert.equal(c.size, chain.blocks.length)
  assert.equal(c.hash, chain.blocks.at(-1).hash)
  assert.equal(c.origin, ORIGIN)
  assert.equal(c.signedAt, '2026-10-17T17:00:00Z')
  assert.equal(verifyCosignature(c, key.publicKey), true)
  assert.deepEqual(JSON.parse(b.files.get('witness/cloud-witness/state.json')), { size: chain.blocks.length, hash: chain.blocks.at(-1).hash })
  assert.equal(b.logs[0].event, 'witness_signed')
  assert.ok(!JSON.stringify([...b.files.values(), b.logs]).includes('PRIVATE'))        // the private key is never written or logged
})

test('it signs again when nothing changed, but refuses a chain that does not verify, a shorter one, or a different history', async () => {
  const b = bucket()
  await go(b, real)
  assert.equal(await go(b, real, { now: new Date('2026-10-17T23:00:00Z') }), 0)
  assert.equal(JSON.parse(b.files.get('witness/cloud-witness/cosignature.json')).signedAt, '2026-10-17T23:00:00Z')
  const before = b.files.get('witness/cloud-witness/cosignature.json')
  // edited contents: the stored hash no longer matches
  assert.equal(await go(b, real.replace('"count": 1512', '"count": 1513')), 2)
  assert.equal(b.logs.at(-1).event, 'witness_refused')
  // a shorter chain than the head already signed
  const chain = parseChainText(real)
  const shorter = JSON.stringify({ ...JSON.parse(real), blocks: JSON.parse(real).blocks.slice(0, 10) })
  assert.equal(await go(b, shorter), 2)
  assert.match(b.logs.at(-1).reason, /shorter/)
  // a different valid-looking history at a position already signed: the witness's state is pinned to a head this chain does not have
  const b2 = bucket()
  b2.files.set('witness/cloud-witness/state.json', JSON.stringify({ size: chain.blocks.length, hash: 'ab'.repeat(32) }))
  assert.equal(await go(b2, real), 3)
  assert.equal(b2.logs.at(-1).event, 'witness_conflict')
  assert.match(b2.logs.at(-1).reason, /CONFLICT/)
  assert.equal(b2.files.has('witness/cloud-witness/cosignature.json'), false)       // nothing signed
  assert.equal(b.files.get('witness/cloud-witness/cosignature.json'), before)       // the earlier good signature was not overwritten by a refusal
})

test('an unreachable or broken source is a clean failure that signs nothing, and a bad name is refused', async () => {
  const b = bucket()
  assert.equal(await runWitness({ name: 'cloud-witness', pem: key.privateKeyPem, readObject: b.readObject, writeObject: b.writeObject, fetchChainText: async () => { throw new Error('offline') }, now: NOW, log: b.log }), 1)
  assert.equal(await go(b, 'this is not json'), 2)
  assert.equal(b.files.size, 0)
  await assert.rejects(go(b, real, { name: '../evil' }), /bad witness name/)
  await assert.rejects(runWitness({ name: 'cloud-witness', pem: key.privateKeyPem, readObject: async () => { throw new Error('boom') }, writeObject: b.writeObject, fetchChainText: async () => real, now: NOW, log: b.log }), /state/)
})

test('the job\'s copy of the witness module is byte-for-byte the public script', () => {
  assert.equal(readFileSync(new URL('../../witness-job/witness.mjs', import.meta.url), 'utf8'), readFileSync(new URL('../../../scripts/witness.mjs', import.meta.url), 'utf8'), 'run: cp scripts/witness.mjs workers/witness-job/witness.mjs')
})
