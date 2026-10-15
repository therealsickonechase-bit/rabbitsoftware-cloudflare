import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { checkProof, proveControl } from '../src/proof.mjs'
import { signDigest } from '../src/kms.mjs'
import { N, fromBytes, mul, signForTest, toBytes } from '../src/secp256k1.mjs'

const d = 0x0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1dn // a throwaway test key; the real key exists only inside the HSM
const pub = mul(d)
const enc = (n) => { let b = toBytes(n).toString('hex').replace(/^(00)+/, ''); if (b.length % 2) b = '0' + b; if (parseInt(b.slice(0, 2), 16) >= 128) b = '00' + b; return Buffer.from(b, 'hex') }
const der = ({ r, s }) => { const rb = enc(r), sb = enc(s); return Buffer.concat([Buffer.from([0x30, 4 + rb.length + sb.length, 2, rb.length]), rb, Buffer.from([2, sb.length]), sb]) }
// a signer like KMS: sometimes returns the high-s form, which the proof must normalise
const softwareSigner = (highS = false) => async (digest) => {
  const sig = signForTest(digest, d, 0x1badc0de1badc0de1badc0den)
  return der(highS ? { r: sig.r, s: N - sig.s } : sig)
}

test('a signature from the key proves control of both addresses, and an independent check agrees', async () => {
  const proof = await proveControl(pub, softwareSigner(), 'hello rabbit')
  assert.deepEqual(checkProof(proof, pub), { ethOk: true, btcOk: true })
  assert.match(proof.ethereum.signature, /^0x[0-9a-f]{130}$/)
})

test('high-s signatures from the HSM are normalised and still verify', async () => {
  const proof = await proveControl(pub, softwareSigner(true), 'hello rabbit')
  assert.deepEqual(checkProof(proof, pub), { ethOk: true, btcOk: true })
})

test('a signature from a different key is refused', async () => {
  const other = async (digest) => der(signForTest(digest, d + 1n, 0x1badc0de1badc0de1badc0den))
  await assert.rejects(proveControl(pub, other, 'hello rabbit'), /does not recover/)
})

test('a tampered proof does not check out', async () => {
  const proof = await proveControl(pub, softwareSigner(), 'hello rabbit')
  const forged = { ...proof, message: 'send me the money' }
  assert.deepEqual(checkProof(forged, pub), { ethOk: false, btcOk: false })
})

test('the KMS client only signs 32-byte digests and sends nothing secret', async () => {
  await assert.rejects(signDigest(Buffer.alloc(10)), /32 bytes/)
  let sent
  const sig = await signDigest(createHash('sha256').update('x').digest(), {
    tokenFn: () => 'tok',
    fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return new Response(JSON.stringify({ signature: Buffer.from('abc').toString('base64') })) },
  })
  assert.equal(sig.toString(), 'abc')
  assert.match(sent.url, /cloudkms\.googleapis\.com\/v1\/projects\/rabbitsoftware-io\/.*cryptoKeyVersions\/1:asymmetricSign$/)
  assert.deepEqual(Object.keys(sent.body), ['digest'])
  assert.equal(fromBytes(Buffer.from(sent.body.digest.sha256, 'base64')) > 0n, true)
})
