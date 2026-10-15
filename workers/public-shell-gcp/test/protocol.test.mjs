import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_FRAME_BYTES, PTY_PROTOCOL, SIZE, clampSize, parseClientFrame, parseStartFrame, signBridgeToken, tokenFromProtocols, verifyBridgeToken } from '../src/protocol.mjs'

const SECRET = 'synthetic-secret-for-tests-0123456789abcdef'
const NOW = 1_800_000_000_000

test('a signed token verifies once and carries the session id and expiry', () => {
  const token = signBridgeToken(SECRET, 'abc12345', NOW + 60_000)
  assert.deepEqual(verifyBridgeToken(SECRET, token, NOW), { sid: 'abc12345', expiresAt: NOW + 60_000 })
})

test('expired, tampered, wrong-secret and malformed tokens are refused', () => {
  const token = signBridgeToken(SECRET, 'abc12345', NOW + 60_000)
  assert.equal(verifyBridgeToken(SECRET, token, NOW + 60_001), null)
  assert.equal(verifyBridgeToken(SECRET, token.replace('abc12345', 'abc12346'), NOW), null)
  assert.equal(verifyBridgeToken(SECRET, token.replace(/\d{10,}/, String(NOW + 9_999_999)), NOW), null)
  assert.equal(verifyBridgeToken('another-synthetic-secret-0123456789abcdef', token, NOW), null)
  for (const bad of [undefined, null, '', 'v1.a.b.c', 'v2.abc12345.1800000060000.x', 'x'.repeat(300), 'v1.abc12345.1800000060000.' + 'A'.repeat(43)]) {
    assert.equal(verifyBridgeToken(SECRET, bad, NOW), null)
  }
  assert.equal(verifyBridgeToken('short', token, NOW), null)
})

test('signing refuses a short secret and a bad session id', () => {
  assert.throws(() => signBridgeToken('short', 'abc12345', NOW))
  assert.throws(() => signBridgeToken(SECRET, 'a b', NOW))
})

test('the token travels as a subprotocol next to the protocol name', () => {
  assert.equal(tokenFromProtocols(`${PTY_PROTOCOL}, tok.en`), 'tok.en')
  assert.equal(tokenFromProtocols('tok.en'), null)
  assert.equal(tokenFromProtocols(undefined), null)
})

test('the start frame is size-limited, typed and clamped', () => {
  const ok = parseStartFrame(JSON.stringify({ t: 'start', cols: 5000, rows: 1, keys: { ANTHROPIC_API_KEY: 'x' } }))
  assert.equal(ok.ok, true)
  assert.equal(ok.cols, SIZE.maxCols)
  assert.equal(ok.rows, SIZE.minRows)
  assert.deepEqual(ok.keys, { ANTHROPIC_API_KEY: 'x' })
  for (const bad of ['{', '[]', JSON.stringify({ t: 'i', d: 'x' }), 'x'.repeat(9000), JSON.stringify({ cols: 80 })]) assert.equal(parseStartFrame(bad).ok, false)
})

test('later frames accept only input and resize', () => {
  assert.deepEqual(parseClientFrame(JSON.stringify({ t: 'i', d: 'ls\r' })), { ok: true, t: 'i', d: 'ls\r' })
  assert.deepEqual(parseClientFrame(JSON.stringify({ t: 'r', cols: 100, rows: 30 })), { ok: true, t: 'r', cols: 100, rows: 30 })
  for (const bad of [JSON.stringify({ t: 'start' }), JSON.stringify({ t: 'i', d: 5 }), '{', 'x'.repeat(MAX_FRAME_BYTES + 1), JSON.stringify({ t: 'exec', d: 'rm' })]) {
    assert.equal(parseClientFrame(bad).ok, false)
  }
})

test('clampSize handles junk numbers', () => {
  assert.deepEqual(clampSize(NaN, undefined), { cols: SIZE.minCols, rows: SIZE.minRows })
  assert.deepEqual(clampSize(80.9, 24.2), { cols: 80, rows: 24 })
})
