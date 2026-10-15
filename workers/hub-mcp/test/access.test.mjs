import assert from 'node:assert/strict'
import test from 'node:test'
import { RATE, classify, clientIp, hubKeyName, makeLimiter, parseKeyHashes, sha256 } from '../src/access.mjs'

const KEY = 'hub_' + 'A1b2'.repeat(10)

test('no header is anonymous; a recognised key is a key; anything else is refused, not anonymous', () => {
  assert.deepEqual(classify(undefined), { kind: 'none' })
  assert.deepEqual(classify(''), { kind: 'none' })
  assert.deepEqual(classify(`Bearer ${KEY}`), { kind: 'hub', key: KEY })
  assert.deepEqual(classify('Bearer rbk_' + 'x'.repeat(24)), { kind: 'rbk', key: 'rbk_' + 'x'.repeat(24) })
  for (const bad of ['Bearer nope', `Basic ${KEY}`, `Bearer ${KEY} extra`, 'Bearer hub_short', 'bearer ' + KEY]) assert.deepEqual(classify(bad), { kind: 'bad' }, bad)
})

test('key hashes parse strictly and a key matches only its own hash', () => {
  const good = sha256(KEY)
  const hashes = parseKeyHashes(`laptop:${good}, bad entry, Upper:${good}, short:abc, phone:${sha256('hub_' + 'Z'.repeat(40))}`)
  assert.equal(hashes.size, 2)
  assert.equal(hubKeyName(hashes, KEY), 'laptop')
  assert.equal(hubKeyName(hashes, 'hub_' + 'Q'.repeat(40)), null)
  assert.equal(parseKeyHashes(undefined).size, 0)
  assert.equal(hubKeyName(new Map(), KEY), null)
})

test('the client address is the last X-Forwarded-For entry, which a client cannot forge', () => {
  assert.equal(clientIp('1.1.1.1, 203.0.113.9', '10.0.0.1'), '203.0.113.9')
  assert.equal(clientIp('203.0.113.9', '10.0.0.1'), '203.0.113.9')
  assert.equal(clientIp('2001:db8::1', '10.0.0.1'), '2001:db8::1')
  assert.equal(clientIp(undefined, '10.0.0.1'), '10.0.0.1')
  assert.equal(clientIp('<script>', '10.0.0.1'), '10.0.0.1')
})

test('the limiter counts a sliding minute per id and forgets old calls', () => {
  let t = 1_000_000
  const limiter = makeLimiter(() => t)
  for (let i = 0; i < RATE.publicPerIp; i++) assert.equal(limiter.hit('ip:a', RATE.publicPerIp), false)
  assert.equal(limiter.hit('ip:a', RATE.publicPerIp), true)           // the 21st call in the minute
  assert.equal(limiter.hit('ip:b', RATE.publicPerIp), false)          // another address is unaffected
  t += RATE.windowMs + 1
  assert.equal(limiter.hit('ip:a', RATE.publicPerIp), false)          // the window moved on
})

test('a key gets a higher limit than an anonymous caller', () => {
  assert.ok(RATE.keyPerKey > RATE.publicPerIp)
})
