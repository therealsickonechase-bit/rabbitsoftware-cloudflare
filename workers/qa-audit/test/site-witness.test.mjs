import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { WITNESS_URL, witnessView } from '../../../site/proof-view.mjs'

const NOW = Date.parse('2026-10-17T16:00:00Z')
const data = (over = {}) => ({
  version: 1, generatedAt: '2026-10-17T15:57:00Z', chainOk: true, head: { size: 16, hash: 'a'.repeat(64) }, rule: { k: 2, n: 3, maxAgeHours: 48 }, agreeing: 2, conflicts: 0, trusted: true,
  witnesses: [
    { name: 'pc-witness', kind: 'project', keyId: '0c8d2ae65323c735', status: 'agrees', size: 16, signedAt: '2026-10-17T15:25:14Z', note: "The owner's PC" },
    { name: 'cloud-witness', kind: 'project', keyId: '1c8d2ae65323c735', status: 'agrees', size: 16, signedAt: '2026-10-17T15:30:00Z', note: '' },
    { name: 'alice', kind: 'external', keyId: '2c8d2ae65323c735', status: 'missing', size: null, signedAt: null, note: '' },
  ], ...over,
})

test('the witness file is read from the public status bucket', () => {
  assert.equal(WITNESS_URL, 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/witness.json')
})

test('a healthy circle says how many peers signed the head, who they are, and what each one did', () => {
  const v = witnessView(data(), NOW)
  assert.equal(v.state, 'ok')
  assert.match(v.headline, /2 of 3 witnesses signed the current head \(16 blocks\), which meets the rule of 2\./)
  assert.deepEqual(v.rows.map((r) => [r.name, r.kind, r.status]), [['pc-witness', 'run by the project', 'signed the current head'], ['cloud-witness', 'run by the project', 'signed the current head'], ['alice', 'outside peer', 'could not be read just now']])
  assert.match(v.rows[0].signed, /minutes? ago|hour/)
  assert.match(v.when, /Updated 3 minutes ago/)
  assert.match(v.rule, /2 different registered witnesses/)
})

test('a witness that is ahead of the copy we read is shown as waiting, not as an alarm', () => {
  const v = witnessView(data({ conflicts: 0, trusted: false, agreeing: 0, witnesses: [{ name: 'pc-witness', kind: 'project', keyId: '0c8d2ae65323c735', status: 'ahead', size: 17, signedAt: '2026-10-17T15:25:14Z' }] }), NOW)
  assert.equal(v.state, 'wait')
  assert.equal(v.rows[0].state, 'wait')
  assert.match(v.rows[0].status, /longer chain than the copy we read/)
})

test('too few witnesses is a waiting state, a conflict or a broken chain is a loud one, and a bad file shows nothing rather than guessing', () => {
  const wait = witnessView(data({ agreeing: 1, trusted: false, rule: { k: 2, n: 1, maxAgeHours: 48 } }), NOW)
  assert.equal(wait.state, 'wait')
  assert.match(wait.headline, /1 of 1 witnesses signed the current head \(16 blocks\); the rule needs 2\./)
  const bad = witnessView(data({ conflicts: 1, trusted: false, witnesses: [{ name: 'alice', kind: 'external', keyId: 'x', status: 'conflict' }] }), NOW)
  assert.equal(bad.state, 'bad')
  assert.match(bad.headline, /different history/)
  assert.equal(bad.rows[0].state, 'bad')
  assert.equal(witnessView(data({ chainOk: false }), NOW).state, 'bad')
  assert.match(witnessView(data({ generatedAt: '2026-10-17T10:00:00Z' }), NOW).when, /may be out of date/)
  for (const broken of [null, {}, { version: 2 }, { version: 1, witnesses: 'x', rule: {} }]) assert.equal(witnessView(broken, NOW).state, 'unknown')
})

test('hostile names and notes are limited, and the pages that show the witnesses have the elements they need', () => {
  const v = witnessView(data({ witnesses: [{ name: '<img src=x onerror=alert(1)>', status: 'agrees' }, { name: 'ok', kind: 'external', keyId: 'zz', status: 'agrees', note: 'n'.repeat(500) }] }), NOW)
  assert.deepEqual(v.rows.map((r) => r.name), ['ok'])
  assert.equal(v.rows[0].keyId, '?')
  assert.equal(v.rows[0].note.length, 160)
  const proofJs = readFileSync(new URL('../../../site/proof.js', import.meta.url), 'utf8'), proofHtml = readFileSync(new URL('../../../site/proof.html', import.meta.url), 'utf8')
  for (const id of ['witness-headline', 'witness-when', 'witness-rule', 'witness-list']) { assert.ok(proofJs.includes(`$('${id}')`), id); assert.ok(proofHtml.includes(`id="${id}"`), id) }
  const netJs = readFileSync(new URL('../../../site/network.js', import.meta.url), 'utf8'), netHtml = readFileSync(new URL('../../../site/network.html', import.meta.url), 'utf8')
  assert.ok(netJs.includes("$('net-witness')") && netHtml.includes('id="net-witness"'))
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(proofJs + netJs))
})
