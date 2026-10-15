// Proof of control: sign a plain message with the KMS key and check, with independent math, that the signature belongs to the published addresses.
// If this passes, the key in the HSM really is the key behind the Bitcoin and Ethereum addresses, and it can sign.
import { createHash } from 'node:crypto'
import { bitcoinAddress, ethereumAddress } from './addresses.mjs'
import { keccak256 } from './keccak.mjs'
import { fromBytes, lowS, parseDer, recover, toBytes, verify } from './secp256k1.mjs'

const sha256 = (b) => createHash('sha256').update(b).digest()
const varint = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 255, n >> 8]))

/** What Ethereum wallets sign for personal_sign / signMessage. */
export const ethMessageHash = (msg) => keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(msg)}`), Buffer.from(msg)]))
/** What Bitcoin wallets sign for "Sign message" (double SHA-256 with the Bitcoin Signed Message prefix). */
export const btcMessageHash = (msg) => {
  const m = Buffer.from(msg)
  return sha256(sha256(Buffer.concat([Buffer.from('\x18Bitcoin Signed Message:\n'), varint(m.length), m])))
}

/** @param {{x:bigint,y:bigint}} pub  @param {(digest:Buffer)=>Promise<Buffer>} sign returns a DER signature */
export async function proveControl(pub, sign, message) {
  const out = { message, ethereum: { address: ethereumAddress(pub) }, bitcoin: { address: bitcoinAddress(pub) } }

  const eh = ethMessageHash(message)
  let { r, s } = parseDer(await sign(eh))
  s = lowS(s)
  const v = [0, 1].find((x) => { const q = recover(eh, r, s, x); return q && q.x === pub.x && q.y === pub.y })
  if (v === undefined) throw new Error('the Ethereum signature does not recover to the published public key')
  const recovered = recover(eh, r, s, v)
  if (ethereumAddress(recovered) !== out.ethereum.address) throw new Error('recovered Ethereum address differs from the published address')
  out.ethereum.signature = '0x' + toBytes(r).toString('hex') + toBytes(s).toString('hex') + (27 + v).toString(16)
  out.ethereum.messageHash = '0x' + eh.toString('hex')

  const bh = btcMessageHash(message)
  const sig2 = parseDer(await sign(bh))
  const s2 = lowS(sig2.s)
  if (!verify(bh, sig2.r, s2, pub)) throw new Error('the Bitcoin signature does not verify against the published public key')
  out.bitcoin.messageHash = bh.toString('hex')
  out.bitcoin.signature = { r: toBytes(sig2.r).toString('hex'), s: toBytes(s2).toString('hex') }
  out.verifiedAt = new Date().toISOString()
  return out
}

/** Independent re-check of a published proof (no KMS needed). Anyone can do the equivalent with any Ethereum library. */
export function checkProof(proof, pub) {
  const eh = ethMessageHash(proof.message)
  const sig = proof.ethereum.signature.replace(/^0x/, '')
  const r = fromBytes(Buffer.from(sig.slice(0, 64), 'hex')), s = fromBytes(Buffer.from(sig.slice(64, 128), 'hex')), v = parseInt(sig.slice(128), 16) - 27
  const q = recover(eh, r, s, v)
  const ethOk = !!q && ethereumAddress(q) === proof.ethereum.address
  const bh = btcMessageHash(proof.message)
  const btcOk = verify(bh, fromBytes(Buffer.from(proof.bitcoin.signature.r, 'hex')), fromBytes(Buffer.from(proof.bitcoin.signature.s, 'hex')), pub) && bitcoinAddress(pub) === proof.bitcoin.address
  return { ethOk, btcOk }
}
