// Bitcoin and Ethereum receive addresses from one secp256k1 public key. Public data only: this file never sees a private key.
import { createHash } from 'node:crypto'
import { keccak256 } from './keccak.mjs'
import { compressed, parsePoint, uncompressed } from './secp256k1.mjs'

const sha256 = (b) => createHash('sha256').update(b).digest()
const ripemd160 = (b) => createHash('ripemd160').update(b).digest()

/** The 64 bytes after the 0x04 prefix of an uncompressed key, hashed; the last 20 bytes are the address. */
export function ethereumAddress(pub) {
  const raw = keccak256(uncompressed(pub).subarray(1)).subarray(12)
  return eip55('0x' + raw.toString('hex'))
}

/** EIP-55 mixed-case checksum. */
export function eip55(address) {
  const a = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error('not an Ethereum address')
  const h = keccak256(Buffer.from(a, 'ascii')).toString('hex')
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')
}

export function isValidEthereumAddress(s) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false
  const body = s.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true // no checksum to check
  return eip55(s) === s
}

// ---- bech32 (BIP173) for native SegWit (P2WPKH) addresses ----
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const polymod = (values) => {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) { const top = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i] }
  return chk
}
const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31))
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0
  const out = [], max = (1 << to) - 1
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max) } }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max)
  return out
}
export function bech32Encode(hrp, version, program) {
  const data = [version, ...convertBits(program, 8, 5, true)]
  const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1 // bech32 (version 0); not bech32m
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31)
  return hrp + '1' + data.concat(checksum).map((d) => CHARSET[d]).join('')
}
export function bech32Decode(addr) {
  const s = addr.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || pos + 7 > s.length || s.length > 90 || addr !== s && addr !== addr.toUpperCase()) throw new Error('bad bech32')
  const hrp = s.slice(0, pos)
  const data = [...s.slice(pos + 1)].map((c) => CHARSET.indexOf(c))
  if (data.includes(-1)) throw new Error('bad bech32 character')
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error('bad bech32 checksum')
  return { hrp, version: data[0], program: Buffer.from(convertBits(data.slice(1, -6), 5, 8, false)) }
}

/** hash160 of the COMPRESSED public key, as a native SegWit v0 address (bc1q...). */
export function bitcoinAddress(pub, hrp = 'bc') {
  return bech32Encode(hrp, 0, ripemd160(sha256(compressed(pub))))
}

export function isValidBitcoinAddress(addr) {
  try {
    const { hrp, version, program } = bech32Decode(addr)
    return hrp === 'bc' && version === 0 && (program.length === 20 || program.length === 32)
  } catch { return false }
}

/** SubjectPublicKeyInfo PEM (what Cloud KMS returns) to a point. Accepts only secp256k1. */
export function pubFromPem(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Buffer.from(b64, 'base64')
  const oidSecp256k1 = Buffer.from('2b8104000a', 'hex')
  if (!der.includes(oidSecp256k1)) throw new Error('this is not a secp256k1 key')
  return parsePoint(der.subarray(der.length - 65))
}
