// Minimal secp256k1 for checking and recovering signatures (the key itself lives in Cloud KMS and is never here). BigInt, affine points, tested with published vectors.
export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
}
const mod = (a, m = P) => ((a % m) + m) % m

function inv(a, m = P) {
  let [r0, r1] = [mod(a, m), m]
  let [s0, s1] = [1n, 0n]
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1] }
  if (r0 !== 1n) throw new Error('no inverse')
  return mod(s0, m)
}

export function add(p, q) {
  if (!p) return q
  if (!q) return p
  if (p.x === q.x) {
    if (mod(p.y + q.y) === 0n) return null
    const l = mod(3n * p.x * p.x * inv(2n * p.y))
    const x = mod(l * l - 2n * p.x)
    return { x, y: mod(l * (p.x - x) - p.y) }
  }
  const l = mod((q.y - p.y) * inv(q.x - p.x))
  const x = mod(l * l - p.x - q.x)
  return { x, y: mod(l * (p.x - x) - p.y) }
}

export function mul(k, p = G) {
  let r = null, a = p
  for (let n = mod(k, N); n > 0n; n >>= 1n) { if (n & 1n) r = add(r, a); a = add(a, a) }
  return r
}

export const isOnCurve = (p) => !!p && mod(p.y * p.y - (p.x * p.x * p.x + 7n)) === 0n && p.x > 0n && p.x < P && p.y > 0n && p.y < P

const powmod = (b, e, m) => { let r = 1n; b = mod(b, m); for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m } return r }

export function liftX(x, odd) {
  const y2 = mod(x * x * x + 7n)
  let y = powmod(y2, (P + 1n) / 4n, P)
  if (mod(y * y) !== y2) throw new Error('x is not on the curve')
  if ((y & 1n) !== (odd ? 1n : 0n)) y = P - y
  return { x, y }
}

export const toBytes = (n, len = 32) => Buffer.from(n.toString(16).padStart(len * 2, '0'), 'hex')
export const fromBytes = (b) => BigInt('0x' + Buffer.from(b).toString('hex'))

/** 65-byte uncompressed (04||x||y) or 33-byte compressed point to {x,y}. */
export function parsePoint(buf) {
  const b = Buffer.from(buf)
  let p
  if (b.length === 65 && b[0] === 4) p = { x: fromBytes(b.subarray(1, 33)), y: fromBytes(b.subarray(33)) }
  else if (b.length === 33 && (b[0] === 2 || b[0] === 3)) p = liftX(fromBytes(b.subarray(1)), b[0] === 3)
  else throw new Error('not a secp256k1 public key')
  if (!isOnCurve(p)) throw new Error('point is not on the curve')
  return p
}
export const uncompressed = (p) => Buffer.concat([Buffer.from([4]), toBytes(p.x), toBytes(p.y)])
export const compressed = (p) => Buffer.concat([Buffer.from([p.y & 1n ? 3 : 2]), toBytes(p.x)])

/** ECDSA verify of a 32-byte digest. */
export function verify(hash, r, s, pub) {
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false
  const z = fromBytes(hash)
  const w = inv(s, N)
  const pt = add(mul(mod(z * w, N)), mul(mod(r * w, N), pub))
  return !!pt && mod(pt.x, N) === r
}

/** Recover the public key that produced (r,s) over `hash` with recovery id v (0 or 1). Returns null if none. */
export function recover(hash, r, s, v) {
  try {
    const R = liftX(r, v === 1)
    const z = fromBytes(hash)
    const rInv = inv(r, N)
    const sR = mul(s, R)
    const zG = mul(mod(-z, N))
    const pub = mul(rInv, add(sR, zG))
    return pub && verify(hash, r, s, pub) ? pub : null
  } catch { return null }
}

/** DER ECDSA signature to {r, s}. Strict enough to reject junk. */
export function parseDer(der) {
  const b = Buffer.from(der)
  if (b[0] !== 0x30 || b[1] !== b.length - 2 || b[2] !== 0x02) throw new Error('not a DER signature')
  const rl = b[3]
  if (b[4 + rl] !== 0x02) throw new Error('not a DER signature')
  const sl = b[5 + rl]
  if (6 + rl + sl !== b.length) throw new Error('not a DER signature')
  return { r: fromBytes(b.subarray(4, 4 + rl)), s: fromBytes(b.subarray(6 + rl, 6 + rl + sl)) }
}

/** Bitcoin and Ethereum only accept the "low s" form. */
export const lowS = (s) => (s > N / 2n ? N - s : s)

/** Software signing for TESTS ONLY (fixed k). Production signing happens inside Cloud KMS. */
export function signForTest(hash, d, k) {
  const R = mul(k)
  const r = mod(R.x, N)
  const s = mod(inv(k, N) * (fromBytes(hash) + r * d), N)
  return { r, s: lowS(s) }
}
