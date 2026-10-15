// Ethereum anchoring: a zero-value EIP-1559 transaction from the anchoring key to ITSELF whose data is a fixed tag plus the 32-byte anchor digest.
// No contract is called and no money moves; the only cost is the gas. Signing and checking reuse signTransfer/senderOf from eth-tx.mjs.
import { keccak256 } from './keccak.mjs'
import { encodeRlp } from './rlp.mjs'
import { CHAIN_ID } from './eth-tx.mjs'
import { isValidEthereumAddress } from './addresses.mjs'

export const TAG = Buffer.from('RBOS')          // "RabbitOS"
export const VERSION = 1
export const ANCHOR_DATA_LENGTH = 4 + 1 + 32
export const ANCHOR_GAS_LIMIT = 25_000n         // 21000 + 16 gas per non-zero data byte (37 bytes at most = 592) leaves a margin

export function anchorData(digest) {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) throw new Error('the digest must be exactly 32 bytes')
  return Buffer.concat([TAG, Buffer.from([VERSION]), digest])
}

/** Same shape signTransfer expects (fields + signingHash). The destination is always the sender's own address. */
export function buildAnchorTransaction({ nonce, maxPriorityFeePerGas, maxFeePerGas, self, digest, chainId = CHAIN_ID }) {
  if (chainId !== CHAIN_ID) throw new Error('only Ethereum mainnet (chain id 1) is supported')
  if (!isValidEthereumAddress(self)) throw new Error('bad address')
  if (maxFeePerGas < maxPriorityFeePerGas) throw new Error('maxFeePerGas must be at least maxPriorityFeePerGas')
  const data = anchorData(digest)
  const fields = [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, ANCHOR_GAS_LIMIT, Buffer.from(self.replace(/^0x/, ''), 'hex'), 0n, data, []]
  return { nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit: ANCHOR_GAS_LIMIT, to: self, value: 0n, data, fields, signingHash: keccak256(Buffer.concat([Buffer.from([2]), encodeRlp(fields)])) }
}

/** The most this can cost in gas. */
export const maxGasCost = (tx) => tx.gasLimit * tx.maxFeePerGas
