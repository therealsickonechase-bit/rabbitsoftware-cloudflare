// Bitcoin mainnet payment from the wallet's single native SegWit address (P2WPKH), signed with BIP143. Pure functions: no network, no keys.
// Signing is delegated to `sign(digest32) -> DER signature` (Cloud KMS in production).
import { createHash } from 'node:crypto'
import { bech32Decode } from './addresses.mjs'
import { compressed, lowS, parseDer, toBytes, verify, fromBytes } from './secp256k1.mjs'

const sha256 = (b) => createHash('sha256').update(b).digest()
const sha256d = (b) => sha256(sha256(b))
const hash160 = (b) => createHash('ripemd160').update(sha256(b)).digest()
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
export const varint = (n) => {
  if (n < 0xfd) return Buffer.from([n])
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b
}
const withLen = (b) => Buffer.concat([varint(b.length), b])

export const SATS_PER_BTC = 100_000_000n
export const DUST = 294n                 // outputs below this are not relayed for P2WPKH
export const RBF_SEQUENCE = 0xfffffffd   // lets the fee be raised later if a payment is stuck

/** "0.0015" -> satoshis (BigInt). At most 8 decimals, no signs or exponents. */
export function parseBtc(text) {
  if (!/^\d+(\.\d{1,8})?$/.test(String(text))) throw new Error('amount must be a plain decimal BTC number, for example 0.0015')
  const [whole, frac = ''] = String(text).split('.')
  return BigInt(whole) * SATS_PER_BTC + BigInt(frac.padEnd(8, '0'))
}
export const formatBtc = (sats) => `${sats / SATS_PER_BTC}.${(sats % SATS_PER_BTC).toString().padStart(8, '0')}`

/** scriptPubKey for our own address: OP_0 <hash160(compressed pubkey)>. */
export const ownScript = (pub) => Buffer.concat([Buffer.from([0x00, 0x14]), hash160(compressed(pub))])

/** Destination: native SegWit v0 only (bc1q...). Taproot, legacy and nested addresses are refused rather than guessed at. */
export function destinationScript(address) {
  let d
  try { d = bech32Decode(address) } catch { throw new Error('the destination is not a valid Bitcoin address') }
  if (d.hrp !== 'bc') throw new Error('the destination is not a Bitcoin mainnet address')
  if (d.version !== 0 || ![20, 32].includes(d.program.length)) throw new Error('only native SegWit (bc1q...) destinations are supported')
  return { script: Buffer.concat([Buffer.from([0x00, d.program.length]), d.program]), outputVbytes: d.program.length === 20 ? 31 : 43 }
}

const outpointOf = (u) => Buffer.concat([Buffer.from(u.txid, 'hex').reverse(), le32(u.vout)])

/**
 * Chooses inputs and outputs. amountSats = null means sweep everything to the destination (no change).
 * Fee = ceil(vsize x feeRate). A change amount below dust is added to the fee instead of creating a useless output.
 */
export function planPayment({ utxos, pub, destination, amountSats = null, feeRate, maxFeeSats = 200_000n }) {
  if (!(feeRate >= 1)) throw new Error('the fee rate must be at least 1 sat/vB')
  if (!utxos.length) throw new Error('the wallet has no spendable coins')
  const dest = destinationScript(destination)
  const own = ownScript(pub)
  const sorted = [...utxos].sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)))
  const vsizeOf = (nIn, outputVb) => Math.ceil(10.5 + 68 * nIn + outputVb)
  const feeFor = (nIn, outputVb) => BigInt(Math.ceil(vsizeOf(nIn, outputVb) * feeRate))
  let chosen, outputs, fee

  if (amountSats === null) {
    chosen = sorted
    const total = chosen.reduce((n, u) => n + BigInt(u.value), 0n)
    fee = feeFor(chosen.length, dest.outputVbytes)
    if (total - fee < DUST) throw new Error('the balance does not cover the fee')
    outputs = [{ script: dest.script, value: total - fee }]
  } else {
    if (amountSats < DUST) throw new Error('the amount is below the dust limit')
    chosen = []
    let total = 0n
    for (const u of sorted) {
      chosen.push(u); total += BigInt(u.value)
      if (total >= amountSats + feeFor(chosen.length, dest.outputVbytes + 31)) break
    }
    const feeWithChange = feeFor(chosen.length, dest.outputVbytes + 31)
    const feeNoChange = feeFor(chosen.length, dest.outputVbytes)
    if (total < amountSats + feeNoChange) throw new Error('the balance does not cover the amount plus the fee')
    const change = total - amountSats - feeWithChange
    if (change >= DUST) { outputs = [{ script: dest.script, value: amountSats }, { script: own, value: change }]; fee = feeWithChange }
    else { outputs = [{ script: dest.script, value: amountSats }]; fee = total - amountSats }
  }
  if (fee > maxFeeSats) throw new Error(`the fee (${fee} sats) is above the safety limit (${maxFeeSats} sats)`)
  const vsize = vsizeOf(chosen.length, outputs.reduce((n, o) => n + (o.script.length === 22 ? 31 : 43), 0))
  return { inputs: chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), outpoint: outpointOf(u), sequence: RBF_SEQUENCE })), outputs, fee, vsize, version: 2, locktime: 0 }
}

/** BIP143 signature hash for one P2WPKH input. `inputs[i]` = { outpoint (36 bytes), sequence, value }, `outputs[i]` = { script, value }. */
export function sighashP2wpkh({ version, locktime, inputs, outputs, index, pubkeyHash }) {
  const hashPrevouts = sha256d(Buffer.concat(inputs.map((i) => i.outpoint)))
  const hashSequence = sha256d(Buffer.concat(inputs.map((i) => le32(i.sequence))))
  const hashOutputs = sha256d(Buffer.concat(outputs.map((o) => Buffer.concat([le64(o.value), withLen(o.script)]))))
  const scriptCode = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), pubkeyHash, Buffer.from([0x88, 0xac])])
  const i = inputs[index]
  const preimage = Buffer.concat([le32(version), hashPrevouts, hashSequence, i.outpoint, withLen(scriptCode), le64(i.value), le32(i.sequence), hashOutputs, le32(locktime), le32(1)])
  return { hash: sha256d(preimage), hashPrevouts, hashSequence, hashOutputs }
}

const encodeDer = (r, s) => {
  const int = (n) => { let b = toBytes(n); let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b }
  const rb = int(r), sb = int(s)
  return Buffer.concat([Buffer.from([0x30, 4 + rb.length + sb.length, 2, rb.length]), rb, Buffer.from([2, sb.length]), sb])
}

/** Signs every input through `sign`, checks each signature against the wallet key, and returns the finished transaction. */
export async function signPayment(plan, sign, pub) {
  const pk = compressed(pub)
  const pubkeyHash = hash160(pk)
  const witnesses = []
  for (let index = 0; index < plan.inputs.length; index++) {
    const { hash } = sighashP2wpkh({ version: plan.version, locktime: plan.locktime, inputs: plan.inputs, outputs: plan.outputs, index, pubkeyHash })
    const { r, s: raw } = parseDer(await sign(hash))
    const s = lowS(raw)
    if (!verify(hash, r, s, pub)) throw new Error('a signature does not belong to the wallet key; nothing was built')
    witnesses.push(Buffer.concat([encodeDer(r, s), Buffer.from([1])]))
  }
  return serialize(plan, witnesses, pk)
}

export function serialize(plan, witnesses, pk) {
  const vin = Buffer.concat([varint(plan.inputs.length), ...plan.inputs.map((i) => Buffer.concat([i.outpoint, Buffer.from([0]), le32(i.sequence)]))])
  const vout = Buffer.concat([varint(plan.outputs.length), ...plan.outputs.map((o) => Buffer.concat([le64(o.value), withLen(o.script)]))])
  const base = Buffer.concat([le32(plan.version), vin, vout, le32(plan.locktime)])
  const witness = Buffer.concat(witnesses.map((w) => Buffer.concat([Buffer.from([2]), withLen(w), withLen(pk)])))
  const full = Buffer.concat([le32(plan.version), Buffer.from([0, 1]), vin, vout, witness, le32(plan.locktime)])
  return { hex: full.toString('hex'), txid: sha256d(base).reverse().toString('hex'), vbytes: Math.ceil((base.length * 3 + full.length) / 4) }
}
