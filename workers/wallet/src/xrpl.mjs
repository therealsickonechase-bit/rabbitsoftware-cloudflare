// XRP Ledger anchoring support: classic address from a secp256k1 public key, and an AccountSet transaction that carries a memo (no payment, no destination).
// Signing is delegated to `sign(digest32) -> DER signature` (Cloud KMS in production). Only secp256k1 keys, only AccountSet with one memo, only the main network.
import { createHash } from 'node:crypto'
import { compressed, lowS, parseDer, toBytes, verify } from './secp256k1.mjs'

const sha256 = (b) => createHash('sha256').update(b).digest()
const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'

export function sha512Half(buf) { return createHash('sha512').update(buf).digest().subarray(0, 32) }

export function base58(buf) {
  let n = BigInt('0x' + buf.toString('hex') || '0')
  let out = ''
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n }
  for (const b of buf) { if (b === 0) out = ALPHABET[0] + out; else break }
  return out
}
export function unbase58(text) {
  let n = 0n
  for (const c of text) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error('not an XRP Ledger address'); n = n * 58n + BigInt(i) }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex
  const body = Buffer.from(hex === '0' ? '' : hex, 'hex')
  let zeros = 0; for (const c of text) { if (c === ALPHABET[0]) zeros++; else break }
  return Buffer.concat([Buffer.alloc(zeros), body])
}

/** 20-byte account id: RIPEMD160(SHA256(compressed public key)). */
export const accountId = (pub) => createHash('ripemd160').update(sha256(compressed(pub))).digest()

export function encodeAddress(id20) {
  const payload = Buffer.concat([Buffer.from([0]), id20])
  return base58(Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]))
}
export const xrplAddress = (pub) => encodeAddress(accountId(pub))

export function decodeAddress(address) {
  const raw = unbase58(address)
  if (raw.length !== 25 || raw[0] !== 0) throw new Error('not an XRP Ledger address')
  const payload = raw.subarray(0, 21)
  if (!sha256(sha256(payload)).subarray(0, 4).equals(raw.subarray(21))) throw new Error('bad XRP Ledger address checksum')
  return raw.subarray(1, 21)
}
export const isValidXrplAddress = (a) => { try { decodeAddress(a); return /^r/.test(a) } catch { return false } }

// ---- binary serialization (only the fields an AccountSet-with-memo needs, in canonical order) ----
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const vl = (b) => {
  if (b.length <= 192) return Buffer.concat([Buffer.from([b.length]), b])
  if (b.length <= 12480) { const n = b.length - 193; return Buffer.concat([Buffer.from([193 + (n >> 8), n & 255]), b]) }
  throw new Error('field too long')
}
const drops = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(0x4000000000000000n | BigInt(n)); return b }

export const NETWORK_MEMO_TYPE = 'rabbitos-anchor'
const MAX_MEMO_DATA = 128

/** Everything except the signature. `fee` is in drops. The memo type/data are plain ASCII/hex bytes. */
export function buildAnchorTx({ account, sequence, lastLedger, fee, memoData }) {
  if (!isValidXrplAddress(account)) throw new Error('bad account')
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('bad sequence')
  if (!Number.isInteger(lastLedger) || lastLedger < 1) throw new Error('bad ledger')
  const feeN = BigInt(fee)
  if (feeN < 10n || feeN > 1000n) throw new Error('fee must be 10 to 1000 drops (at most 0.001 XRP)')
  const data = Buffer.from(memoData)
  if (data.length === 0 || data.length > MAX_MEMO_DATA) throw new Error('memo data must be 1 to 128 bytes')
  return { account, sequence, lastLedger, fee: feeN, memoData: data }
}

function serialize(tx, pubKey, signature) {
  const memo = Buffer.concat([Buffer.from([0xea]), Buffer.from([0x7c]), vl(Buffer.from(NETWORK_MEMO_TYPE)), Buffer.from([0x7d]), vl(tx.memoData), Buffer.from([0x7e]), vl(Buffer.from('application/octet-stream')), Buffer.from([0xe1])])
  return Buffer.concat([
    Buffer.from([0x12]), u16(3),                       // TransactionType = AccountSet
    Buffer.from([0x22]), u32(0x80000000),              // Flags = tfFullyCanonicalSig
    Buffer.from([0x24]), u32(tx.sequence),
    Buffer.from([0x20, 0x1b]), u32(tx.lastLedger),     // LastLedgerSequence
    Buffer.from([0x68]), drops(tx.fee),                // Fee
    Buffer.from([0x73]), vl(pubKey),                   // SigningPubKey
    ...(signature ? [Buffer.from([0x74]), vl(signature)] : []),
    Buffer.from([0x81, 0x14]), decodeAddress(tx.account), // Account
    Buffer.from([0xf9]), memo, Buffer.from([0xf1]),    // Memos
  ])
}

/** DER-encodes a low-S signature the way the XRP Ledger requires (canonical). */
function derOf(r, s) {
  const int = (n) => { let b = toBytes(n); while (b.length > 1 && b[0] === 0) b = b.subarray(1); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]) }
  const body = Buffer.concat([int(r), int(s)])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

/** Returns { blob (uppercase hex), hash, signingHash }. The signing key must be the account's own key (the account id is checked). */
export async function signAnchorTx(tx, sign, pub) {
  if (xrplAddress(pub) !== tx.account) throw new Error('the signing key does not belong to this XRP Ledger account')
  const pubKey = compressed(pub)
  const unsigned = serialize(tx, pubKey, null)
  const signingHash = sha512Half(Buffer.concat([Buffer.from('53545800', 'hex'), unsigned]))
  const { r, s: rawS } = parseDer(await sign(signingHash))
  const s = lowS(rawS)
  if (!verify(signingHash, r, s, pub)) throw new Error('the signature does not verify for this key; nothing was built')
  const der = derOf(r, s)
  const blob = serialize(tx, pubKey, der)
  return { blob: blob.toString('hex').toUpperCase(), hash: sha512Half(Buffer.concat([Buffer.from('54584e00', 'hex'), blob])).toString('hex').toUpperCase(), signingHash }
}
