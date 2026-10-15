// Keccak-256 (the hash Ethereum uses; NOT the same as NIST SHA3-256, which pads differently). Plain BigInt implementation, tested against published vectors.
const MASK = (1n << 64n) - 1n
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
] // ROT[x][y]
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK)

function keccakF(a) {
  for (let round = 0; round < 24; round++) {
    const c = []
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d
    }
    const b = new Array(25)
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x][y])
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] = (b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & MASK & b[(x + 2) % 5 + 5 * y])) & MASK
    a[0] ^= RC[round]
  }
}

/** @param {Uint8Array|Buffer} input @returns {Buffer} 32 bytes */
export function keccak256(input) {
  const rate = 136
  const data = Buffer.from(input)
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / rate) * rate)
  data.copy(padded)
  padded[data.length] ^= 0x01
  padded[padded.length - 1] ^= 0x80
  const a = new Array(25).fill(0n)
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) a[i] ^= padded.readBigUInt64LE(off + i * 8)
    keccakF(a)
  }
  const out = Buffer.alloc(32)
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(a[i], i * 8)
  return out
}
