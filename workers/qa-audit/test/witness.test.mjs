import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_POLICY, HELLO_WORLD, ORIGIN, blockHash, cosign, evaluate, generateKey, keyIdOf, parseChainText, pythonJson, verifyChain, verifyCosignature, witnessStep } from '../../../scripts/witness.mjs'

const SCRIPT = new URL('../../../scripts/witness.mjs', import.meta.url)
const realText = readFileSync(new URL('./fixtures/maxwell_chain.json', import.meta.url), 'utf8')
const NOW = new Date('2026-10-17T16:00:00Z')

// A small honest chain built with the module's own hashing, plus a way to fork it.
function mine(index, transactions, previous_hash, timestamp, difficulty = 2) {
  const raw = (s) => parseChainText(String(s))
  const b = { index: raw(index), timestamp: raw(timestamp), transactions, previous_hash, nonce: raw(0) }
  for (let n = 0; ; n++) {
    b.nonce = raw(n)
    const h = blockHash(b)
    if (h.startsWith('0'.repeat(difficulty))) return { ...b, hash: h }
  }
}
function chainOf(extra = []) {
  const g = { index: parseChainText('0'), timestamp: parseChainText('1792000000.5'), transactions: [{ sender: 'MAXWELL_GENESIS', immutable_anchor_sha: HELLO_WORLD }], previous_hash: '0'.repeat(64), nonce: parseChainText('0') }
  g.hash = blockHash(g)
  const blocks = [g]
  for (const [i, note] of extra.entries()) blocks.push(mine(i + 1, [{ sender: 'RESEARCH_ANCHOR', note, count: parseChainText('3') }], blocks[i].hash, `${1792000100 + i}.25`))
  return { difficulty: parseChainText('2'), blocks }
}
const clone = (c) => parseChainText(pythonJson(c))

test('Python-style JSON text is reproduced exactly: separators, key order, ASCII escapes, surrogate pairs, number text', () => {
  const v = parseChainText('{"b": 1.0, "a": ["é", " ", "x\\"y", "😀", "tab\\t"], "c": null, "d": true, "e": [], "f": {}, "g": 1792190554.8155015}')
  assert.equal(pythonJson(v), '{"a": ["\\u00e9", "\\u2028", "x\\"y", "\\ud83d\\ude00", "tab\\t"], "b": 1.0, "c": null, "d": true, "e": [], "f": {}, "g": 1792190554.8155015}')
})

test('every block hash of the REAL live chain is reproduced, so a witness written in JavaScript agrees with the Python miners', () => {
  const chain = parseChainText(realText)
  assert.ok(chain.blocks.length >= 16)
  const bad = chain.blocks.filter((b) => blockHash(b) !== b.hash).map((b) => Number(b.index.source))
  assert.deepEqual(bad, [])
  const v = verifyChain(chain)
  assert.deepEqual(v.problems, [])
  assert.equal(v.ok, true)
  assert.equal(v.size, chain.blocks.length)
})

test('tampering, broken links, missing work, a wrong genesis and garbage are all caught', () => {
  const ok = chainOf(['a', 'b', 'c'])
  assert.equal(verifyChain(ok).ok, true)
  const edited = clone(ok); edited.blocks[2].transactions[0].note = 'changed'
  assert.match(verifyChain(edited).problems.join('|'), /block 2: the stored hash does not match/)
  const relinked = clone(ok); relinked.blocks[3].previous_hash = 'f'.repeat(64)
  assert.match(verifyChain(relinked).problems.join('|'), /block 3: previous_hash does not link/)
  const lazy = clone(ok); let b = lazy.blocks[1]
  for (let n = 1; blockHash(b).startsWith('00') || true; n++) { b.nonce = parseChainText(String(n)); if (!blockHash(b).startsWith('0')) break }
  b.hash = blockHash(b)
  assert.match(verifyChain(lazy).problems.join('|'), /work target/)
  const wrongGenesis = clone(ok); wrongGenesis.blocks[0].transactions[0].immutable_anchor_sha = '0'.repeat(64)
  assert.match(verifyChain(wrongGenesis).problems.join('|'), /hello world/)
  const gap = clone(ok); gap.blocks.splice(1, 1)
  assert.equal(verifyChain(gap).ok, false)
  for (const junk of [null, {}, { blocks: [] }, { blocks: [{}] }, { blocks: 'x' }]) assert.equal(verifyChain(junk).ok, false)
})

test('a witness signs a chain it verified, advances, and refuses a shorter chain, a broken one, and a different history', () => {
  const longChain = chainOf(['a', 'b', 'c', 'd'])
  const first = witnessStep({ chain: longChain, state: null })
  assert.equal(first.sign, true)
  assert.deepEqual(first.checkpoint, { origin: ORIGIN, size: 5, hash: longChain.blocks[4].hash })
  // a later, longer chain that extends it is fine
  const longer = chainOf(['a', 'b', 'c', 'd', 'e'])
  assert.equal(witnessStep({ chain: longer, state: first.state }).sign, true)
  // a shorter chain than already seen: rollback
  const rolled = witnessStep({ chain: chainOf(['a', 'b']), state: first.state })
  assert.equal(rolled.sign, false)
  assert.match(rolled.reason, /shorter/)
  // a different history of the same or greater length: split view / rewrite
  const forked = chainOf(['a', 'b', 'X', 'd', 'e'])
  const f = witnessStep({ chain: forked, state: first.state })
  assert.equal(f.sign, false)
  assert.equal(f.conflict, true)
  assert.match(f.reason, /CONFLICT: block 4/)
  // a chain that does not verify is never signed, even for a witness that has seen nothing
  const broken = clone(longer); broken.blocks[2].transactions[0].note = 'edited'
  const b = witnessStep({ chain: broken, state: null })
  assert.equal(b.sign, false)
  assert.ok(b.problems.length > 0)
})

test('cosignatures verify with the right key only, and any change to what was signed breaks them', () => {
  const k = generateKey(), other = generateKey()
  const cp = { origin: ORIGIN, size: 7, hash: 'ab'.repeat(32) }
  const c = cosign({ name: 'alice', checkpoint: cp, privateKeyPem: k.privateKeyPem, publicKey: k.publicKey, now: NOW })
  assert.equal(c.signedAt, '2026-10-17T16:00:00Z')
  assert.equal(c.keyId, k.keyId)
  assert.equal(verifyCosignature(c, k.publicKey), true)
  assert.equal(verifyCosignature(c, other.publicKey), false)
  for (const change of [{ size: 8 }, { hash: 'cd'.repeat(32) }, { witness: 'bob' }, { signedAt: '2026-10-17T16:00:01Z' }, { origin: 'example.org/other' }, { v: 2 }]) assert.equal(verifyCosignature({ ...c, ...change }, k.publicKey), false, JSON.stringify(change))
  assert.equal(verifyCosignature(null, k.publicKey), false)
  assert.equal(verifyCosignature({ ...c, signature: 'AAAA' }, k.publicKey), false)
  assert.equal(keyIdOf(k.publicKey), k.keyId)
  for (const bad of ['', 'UPPER', 'a b', 'x'.repeat(41), '../etc']) assert.throws(() => cosign({ name: bad, checkpoint: cp, privateKeyPem: k.privateKeyPem, publicKey: k.publicKey }), /witness name/)
})

test('the quorum counts only distinct, valid, current witnesses, and a conflict withholds trust', () => {
  const chain = chainOf(['a', 'b', 'c', 'd'])        // 5 blocks
  const keys = Object.fromEntries(['p', 'q', 'r', 's', 't', 'u', 'v'].map((n) => [n, generateKey()]))
  const registry = { witnesses: Object.entries(keys).map(([name, k]) => ({ name, publicKey: k.publicKey, kind: name === 'p' ? 'project' : 'external' })) }
  const sign = (name, size, hash, when = NOW, key = keys[name]) => cosign({ name, checkpoint: { origin: ORIGIN, size, hash }, privateKeyPem: key.privateKeyPem, publicKey: key.publicKey, now: when })
  const head = chain.blocks[4].hash
  const cosigs = {
    p: sign('p', 5, head),                                                                     // agrees
    q: sign('q', 5, head),                                                                     // agrees
    r: sign('r', 3, chain.blocks[2].hash),                                                     // behind: an earlier head that is still part of this chain
    s: sign('s', 5, head, new Date(NOW.getTime() - 100 * 3_600_000)),                          // stale: too old
    t: { ...sign('t', 5, head), size: 4 },                                                     // invalid: altered after signing
    u: sign('u', 5, 'ee'.repeat(32)),                                                          // conflict: signed a hash that is not this chain's
    // v: missing
  }
  const r = evaluate({ registry, cosigs, chain, now: NOW, policy: { k: 2, maxAgeHours: 48 } })
  assert.deepEqual(r.rows.map((x) => [x.name, x.status]), [['p', 'agrees'], ['q', 'agrees'], ['r', 'behind'], ['s', 'stale'], ['t', 'invalid'], ['u', 'conflict'], ['v', 'missing']])
  assert.equal(r.agreeing, 2)
  assert.equal(r.conflicts, 1)
  assert.equal(r.trusted, false)                                                              // enough signatures, but one witness saw a different history
  assert.match(r.summary, /not this chain: investigate/)
  delete cosigs.u
  const clean = evaluate({ registry, cosigs, chain, now: NOW, policy: { k: 2, maxAgeHours: 48 } })
  assert.equal(clean.trusted, true)
  assert.match(clean.summary, /2 of 7 witnesses signed the current head, which meets the rule of 2/)
  assert.equal(evaluate({ registry, cosigs, chain, now: NOW, policy: { k: 3, maxAgeHours: 48 } }).trusted, false)
  // one key registered under two names counts once
  const twin = { witnesses: [{ name: 'p', publicKey: keys.p.publicKey }, { name: 'p2', publicKey: keys.p.publicKey }] }
  const twinSigs = { p: sign('p', 5, head), p2: cosign({ name: 'p2', checkpoint: { origin: ORIGIN, size: 5, hash: head }, privateKeyPem: keys.p.privateKeyPem, publicKey: keys.p.publicKey, now: NOW }) }
  assert.equal(evaluate({ registry: twin, cosigs: twinSigs, chain, now: NOW }).agreeing, 1)
  // a cosignature signed with someone else's key under a registered name is invalid
  assert.equal(evaluate({ registry: { witnesses: [{ name: 'p', publicKey: keys.p.publicKey }] }, cosigs: { p: sign('p', 5, head, NOW, keys.q) }, chain, now: NOW }).rows[0].status, 'invalid')
  // a chain that does not verify gives no trust at all
  const broken = clone(chain); broken.blocks[1].transactions[0].note = 'edited'
  const none = evaluate({ registry, cosigs: { p: sign('p', 5, head) }, chain: broken, now: NOW })
  assert.equal(none.trusted, false)
  assert.equal(none.chainOk, false)
  assert.deepEqual(DEFAULT_POLICY, { k: 2, maxAgeHours: 48 })
})

test('the command line: keygen, run, advance, and exit 3 on a conflicting history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'))
  const run = (...a) => spawnSync(process.execPath, [SCRIPT.pathname.replace(/^\/([A-Z]:)/, '$1'), ...a], { cwd: dir, encoding: 'utf8' })
  assert.equal(run('keygen', '--name', 'dana').status, 0)
  const pub = JSON.parse(readFileSync(join(dir, 'dana.pub'), 'utf8'))
  assert.equal(pub.name, 'dana')
  const honest = chainOf(['a', 'b', 'c'])
  writeFileSync(join(dir, 'chain1.json'), pythonJson(honest))
  const r1 = run('run', '--name', 'dana', '--key', 'dana.key', '--chain', 'chain1.json')
  assert.equal(r1.status, 0, r1.stderr)
  const c = JSON.parse(readFileSync(join(dir, 'dana.cosignature.json'), 'utf8'))
  assert.equal(c.size, 4)
  assert.equal(verifyCosignature(c, pub.publicKey), true)
  writeFileSync(join(dir, 'chain2.json'), pythonJson(chainOf(['a', 'b', 'c', 'd'])))
  assert.equal(run('run', '--name', 'dana', '--key', 'dana.key', '--chain', 'chain2.json').status, 0)
  assert.equal(JSON.parse(readFileSync(join(dir, 'dana.cosignature.json'), 'utf8')).size, 5)
  writeFileSync(join(dir, 'chain3.json'), pythonJson(chainOf(['a', 'b', 'Z', 'd', 'e'])))
  const r3 = run('run', '--name', 'dana', '--key', 'dana.key', '--chain', 'chain3.json')
  assert.equal(r3.status, 3)
  assert.match(r3.stderr, /CONFLICT/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'dana.cosignature.json'), 'utf8')).size, 5)      // nothing new was signed
  assert.equal(run('nonsense').status, 2)
})
