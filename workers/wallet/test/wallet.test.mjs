import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bech32Decode, bitcoinAddress, eip55, ethereumAddress, isValidBitcoinAddress, isValidEthereumAddress, pubFromPem } from '../src/addresses.mjs'
import { keccak256 } from '../src/keccak.mjs'
import { G, N, add, compressed, fromBytes, isOnCurve, lowS, mul, parseDer, parsePoint, recover, signForTest, toBytes, uncompressed, verify } from '../src/secp256k1.mjs'

const hex = (b) => Buffer.from(b).toString('hex')

test('keccak256 matches the published vectors (and is not NIST SHA3)', () => {
  assert.equal(hex(keccak256(Buffer.alloc(0))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
  assert.equal(hex(keccak256(Buffer.from('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
  assert.equal(hex(keccak256(Buffer.from('a'.repeat(200)))).length, 64) // spans two blocks
  assert.equal(hex(keccak256(Buffer.from('The quick brown fox jumps over the lazy dog'))), '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15')
})

test('curve arithmetic: G is on the curve, n*G is infinity, 2G is the known point', () => {
  assert.ok(isOnCurve(G))
  assert.equal(mul(N), null)
  const two = mul(2n)
  assert.equal(two.x.toString(16), 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5')
  assert.deepEqual(add(G, G), two)
})

test('addresses for private key 1 and 2 match the published values', () => {
  assert.equal(ethereumAddress(mul(1n)), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
  assert.equal(ethereumAddress(mul(2n)), '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF')
  assert.equal(bitcoinAddress(mul(1n)), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4') // BIP173 example
})

test('EIP-55 checksum vectors and validation', () => {
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    assert.equal(eip55(a.toLowerCase()), a)
    assert.ok(isValidEthereumAddress(a))
  }
  assert.ok(!isValidEthereumAddress('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), 'one wrong capital letter must fail')
  assert.ok(!isValidEthereumAddress('0x123'))
})

test('Bitcoin address validation (BIP173): good, upper-case, bad checksum, wrong network, mixed case', () => {
  assert.ok(isValidBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'))
  assert.ok(isValidBitcoinAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'))
  assert.ok(!isValidBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'))
  assert.ok(!isValidBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'))
  assert.ok(!isValidBitcoinAddress('Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'))
  assert.equal(bech32Decode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').program.length, 20)
})

test('point encodings round-trip and junk is refused', () => {
  const p = mul(123456789n)
  assert.deepEqual(parsePoint(uncompressed(p)), p)
  assert.deepEqual(parsePoint(compressed(p)), p)
  assert.throws(() => parsePoint(Buffer.alloc(65, 4)))
  assert.throws(() => parsePoint(Buffer.from('1234', 'hex')))
})

test('signatures verify, recover to the signer, and low-s is enforced', () => {
  const d = 0x1234567890abcdefn
  const pub = mul(d)
  const hash = keccak256(Buffer.from('hello'))
  const { r, s } = signForTest(hash, d, 0xdeadbeefn)
  assert.ok(verify(hash, r, s, pub))
  assert.ok(!verify(keccak256(Buffer.from('other')), r, s, pub))
  const found = [0, 1].map((v) => recover(hash, r, s, v)).filter(Boolean)
  assert.ok(found.some((q) => q.x === pub.x && q.y === pub.y))
  assert.equal(lowS(N - 5n), 5n)
  assert.equal(lowS(5n), 5n)
})

test('DER signatures parse and junk does not', () => {
  const r = 0x1234n, s = 0x5678n
  const enc = (n) => { let b = toBytes(n).toString('hex').replace(/^(00)+/, ''); if (b.length % 2) b = '0' + b; if (parseInt(b.slice(0, 2), 16) >= 128) b = '00' + b; return Buffer.from(b, 'hex') }
  const rb = enc(r), sb = enc(s)
  const der = Buffer.concat([Buffer.from([0x30, 4 + rb.length + sb.length, 2, rb.length]), rb, Buffer.from([2, sb.length]), sb])
  assert.deepEqual(parseDer(der), { r, s })
  assert.throws(() => parseDer(Buffer.from('3000', 'hex')))
  assert.throws(() => parseDer(Buffer.from('deadbeef', 'hex')))
})

test('the real Cloud KMS public key is secp256k1 and gives well-formed addresses', () => {
  const pem = readFileSync(new URL('../public-key.pem', import.meta.url), 'utf8')
  const pub = pubFromPem(pem)
  assert.ok(isOnCurve(pub))
  assert.ok(isValidEthereumAddress(ethereumAddress(pub)))
  assert.ok(isValidBitcoinAddress(bitcoinAddress(pub)))
  assert.throws(() => pubFromPem('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----'))
})
