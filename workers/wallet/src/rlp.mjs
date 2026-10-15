// Minimal RLP encoder (Ethereum's serialization). Encode only; tested against the published vectors.
const bytesOf = (n) => {
  if (typeof n === 'number') n = BigInt(n)
  if (typeof n !== 'bigint' || n < 0n) throw new Error('RLP integers must be non-negative')
  if (n === 0n) return Buffer.alloc(0)
  let h = n.toString(16)
  if (h.length % 2) h = '0' + h
  return Buffer.from(h, 'hex')
}

function lengthPrefix(len, offset) {
  if (len < 56) return Buffer.from([offset + len])
  const l = bytesOf(len)
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l])
}

/** item: Buffer | Uint8Array | number | bigint | array of items. Integers are written big-endian with no leading zeros (zero is the empty string). */
export function encodeRlp(item) {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(encodeRlp))
    return Buffer.concat([lengthPrefix(body.length, 0xc0), body])
  }
  const b = typeof item === 'number' || typeof item === 'bigint' ? bytesOf(item) : Buffer.from(item)
  if (b.length === 1 && b[0] < 0x80) return b
  return Buffer.concat([lengthPrefix(b.length, 0x80), b])
}
