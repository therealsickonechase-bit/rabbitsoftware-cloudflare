// Ethereum mainnet transfer (EIP-1559, type 2) from the wallet address. Plain value transfers only: no contract data, no access list.
// Signing is delegated to `sign(digest32) -> DER signature`, which in production is Cloud KMS. No private key is ever here.
import { ethereumAddress, isValidEthereumAddress } from './addresses.mjs'
import { keccak256 } from './keccak.mjs'
import { encodeRlp } from './rlp.mjs'
import { fromBytes, lowS, parseDer, recover, toBytes } from './secp256k1.mjs'

export const CHAIN_ID = 1n               // Ethereum mainnet only. A transaction for another network is refused.
export const TRANSFER_GAS = 21000n       // a plain transfer to an ordinary address uses exactly this
const WEI = 10n ** 18n

/** "0.015" -> wei (BigInt). Rejects more than 18 decimals, signs, exponents and anything that is not a plain decimal number. */
export function parseEth(text) {
  if (!/^\d+(\.\d{1,18})?$/.test(String(text))) throw new Error('amount must be a plain decimal ETH number, for example 0.015')
  const [whole, frac = ''] = String(text).split('.')
  return BigInt(whole) * WEI + BigInt(frac.padEnd(18, '0'))
}
export function formatEth(wei) {
  const s = wei.toString().padStart(19, '0')
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '') || '0'
}

const addrBytes = (a) => Buffer.from(a.replace(/^0x/, ''), 'hex')

/** The fields that get signed. maxFeePerGas must cover maxPriorityFeePerGas. */
export function buildTransfer({ nonce, maxPriorityFeePerGas, maxFeePerGas, to, value, gasLimit = TRANSFER_GAS, chainId = CHAIN_ID }) {
  if (chainId !== CHAIN_ID) throw new Error('only Ethereum mainnet (chain id 1) is supported')
  if (!isValidEthereumAddress(to)) throw new Error('the destination is not a valid Ethereum address (check the capitals: a wrong checksum is refused)')
  if (value <= 0n) throw new Error('the amount must be greater than zero')
  if (maxFeePerGas < maxPriorityFeePerGas) throw new Error('maxFeePerGas must be at least maxPriorityFeePerGas')
  if (gasLimit !== TRANSFER_GAS) throw new Error('only plain transfers (21000 gas) are supported')
  const fields = [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, addrBytes(to), value, Buffer.alloc(0), []]
  return { nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, fields, signingHash: keccak256(Buffer.concat([Buffer.from([2]), encodeRlp(fields)])) }
}

/** The most this transfer can cost the wallet in total (amount plus the worst-case fee). */
export const maxCost = (tx) => tx.value + tx.gasLimit * tx.maxFeePerGas

/** Signs with `sign`, finds the recovery id by checking which one gives back the wallet's own address, and returns the raw transaction. */
export async function signTransfer(tx, sign, pub) {
  const { r, s: rawS } = parseDer(await sign(tx.signingHash))
  const s = lowS(rawS)
  const v = [0, 1].find((x) => { const q = recover(tx.signingHash, r, s, x); return q && q.x === pub.x && q.y === pub.y })
  if (v === undefined) throw new Error('the signature does not belong to the wallet key; nothing was built')
  const raw = Buffer.concat([Buffer.from([2]), encodeRlp([...tx.fields, v, r, s])])
  return { raw: '0x' + raw.toString('hex'), hash: '0x' + keccak256(raw).toString('hex'), from: ethereumAddress(pub), r: toBytes(r).toString('hex'), s: toBytes(s).toString('hex'), v }
}

/** Independent check of a raw transaction: decode nothing, just recompute the signing hash from the fields and recover the sender. */
export function senderOf(tx, signed) {
  const q = recover(tx.signingHash, fromBytes(Buffer.from(signed.r, 'hex')), fromBytes(Buffer.from(signed.s, 'hex')), signed.v)
  return q && ethereumAddress(q)
}
