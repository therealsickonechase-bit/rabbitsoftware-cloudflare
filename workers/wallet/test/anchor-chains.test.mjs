import assert from 'node:assert/strict'
import test from 'node:test'
import { ethereumAddress } from '../src/addresses.mjs'
import { run } from '../anchor-chains.mjs'
import { anchorData, buildAnchorTransaction } from '../src/eth-anchor.mjs'
import { senderOf, signTransfer } from '../src/eth-tx.mjs'
import { N, mul, signForTest, toBytes } from '../src/secp256k1.mjs'
import { buildAnchorTx, decodeAddress, encodeAddress, isValidXrplAddress, signAnchorTx, xrplAddress } from '../src/xrpl.mjs'

const enc = (n) => { let b = toBytes(n).toString('hex').replace(/^(00)+/, ''); if (b.length % 2) b = '0' + b; if (parseInt(b.slice(0, 2), 16) >= 128) b = '00' + b; return Buffer.from(b, 'hex') }
const der = ({ r, s }) => { const rb = enc(r), sb = enc(s); return Buffer.concat([Buffer.from([0x30, 4 + rb.length + sb.length, 2, rb.length]), rb, Buffer.from([2, sb.length]), sb]) }
const KEY = 0x1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988n
const pub = mul(KEY)
const sign = async (digest) => { const sig = signForTest(digest, KEY, 0x5555n); return der({ r: sig.r, s: N - sig.s }) } // high-s on purpose: the code must normalise it

test('XRP Ledger address and signed AccountSet match the values produced by the official xrpl library', async () => {
  assert.equal(xrplAddress(pub), 'r3FsvzxASL5DKzmQtmrpWsB5rAuH3MDhGG')
  assert.equal(encodeAddress(decodeAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')), 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh') // the well-known genesis account
  assert.ok(isValidXrplAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'))
  assert.ok(!isValidXrplAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTx'))
  const memoData = Buffer.concat([Buffer.from('RBOS'), Buffer.from([1]), Buffer.alloc(32, 7)])
  const tx = buildAnchorTx({ account: xrplAddress(pub), sequence: 5, lastLedger: 99999999, fee: 12, memoData })
  const signed = await signAnchorTx(tx, async (d) => { const sig = signForTest(d, KEY, 0x5555n); return der(sig) }, pub)
  assert.equal(signed.blob, '12000322800000002400000005201B05F5E0FF68400000000000000C732102085FE2CA7A5758957EA811BD8E743D9CEE6BC20072F1470A888C43A1091A8E8B7446304402200584F8DA84800D91682F229D374DB4CF675BB772108DB9200DF667D6AA7E675702206BF0F0161388250286EDE1728B4BD4C94562A5E45C95A5B76B27E33CA097CD51811455AEE09C5FF4A05242E51C98C69E873D53CC8011F9EA7C0F7261626269746F732D616E63686F727D2552424F530107070707070707070707070707070707070707070707070707070707070707077E186170706C69636174696F6E2F6F637465742D73747265616DE1F1')
  assert.equal(signed.hash, '1396105CA029EE0002CF67EF657E979721B790246A205A0B6345636ECAE9863C')
})

test('XRP Ledger transactions refuse a wrong key, a big fee and oversized memos', async () => {
  const other = mul(KEY + 1n)
  const tx = buildAnchorTx({ account: xrplAddress(pub), sequence: 1, lastLedger: 100, fee: 10, memoData: Buffer.from('x') })
  await assert.rejects(signAnchorTx(tx, sign, other), /does not belong/)
  assert.throws(() => buildAnchorTx({ account: xrplAddress(pub), sequence: 1, lastLedger: 100, fee: 5000, memoData: Buffer.from('x') }), /fee must be/)
  assert.throws(() => buildAnchorTx({ account: xrplAddress(pub), sequence: 1, lastLedger: 100, fee: 10, memoData: Buffer.alloc(200) }), /memo data/)
})

test('the Ethereum anchor is a zero-value transaction to itself carrying RBOS + version + digest, and it recovers to the sender', async () => {
  const self = ethereumAddress(pub)
  const digest = Buffer.alloc(32, 9)
  assert.equal(anchorData(digest).toString('hex'), '5242 4f53 01'.replace(/ /g, '') + '09'.repeat(32))
  const tx = buildAnchorTransaction({ nonce: 3n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 30_000_000_000n, self, digest })
  assert.equal(tx.value, 0n)
  assert.equal(tx.to, self)
  const signed = await signTransfer(tx, sign, pub)
  assert.equal(senderOf(tx, signed), self)
  assert.throws(() => anchorData(Buffer.alloc(31)), /32 bytes/)
  assert.throws(() => buildAnchorTransaction({ nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, self, digest, chainId: 5n }), /mainnet/)
})

// ---- the whole job against a pretend network and bucket ----
const ETH = ethereumAddress(pub), DIGEST = 'ab'.repeat(32)
function world({ ethBalance = 0n, xrpBalance = null, gwei = 20n, xrpFee = '10' } = {}) {
  const calls = []
  const bucket = new Map([['anchors/index.json', [{ id: '2026-10-15T214050Z', digest: DIGEST, status: 'pending' }]]])
  const w = { calls, bucket, eth: { balance: ethBalance, receipts: new Map() }, xrp: { balance: xrpBalance, validated: new Set() } }
  w.fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const reply = (result) => ({ ok: true, json: async () => (url.includes('xrplcluster') ? { result } : { result }) })
    if (url.includes('xrplcluster')) {
      calls.push('xrpl:' + body.method)
      const p = body.params[0]
      if (body.method === 'account_info') return reply(w.xrp.balance === null ? { status: 'error', error: 'actNotFound' } : { account_data: { Balance: String(w.xrp.balance), Sequence: 7, OwnerCount: 0 } })
      if (body.method === 'server_info') return reply({ info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, seq: 1000 } } })
      if (body.method === 'fee') return reply({ drops: { open_ledger_fee: xrpFee, base_fee: '10' } })
      if (body.method === 'submit') { w.xrp.submitted = p.tx_blob; return reply({ engine_result: 'tesSUCCESS', tx_json: { hash: 'X' } }) }
      if (body.method === 'tx') return w.xrp.validated.has(p.transaction) ? reply({ validated: true, ledger_index: 1010, meta: { TransactionResult: 'tesSUCCESS' } }) : reply({ status: 'error', error: 'txnNotFound' })
    }
    calls.push('eth:' + body.method)
    const hex = (n) => '0x' + BigInt(n).toString(16)
    const answers = {
      eth_getTransactionCount: () => hex(4), eth_getBalance: () => hex(w.eth.balance), eth_getBlockByNumber: () => ({ baseFeePerGas: hex(gwei * 1_000_000_000n) }),
      eth_maxPriorityFeePerGas: () => hex(1_000_000_000n), eth_sendRawTransaction: () => { w.eth.sent = body.params[0]; return '0x' + 'cd'.repeat(32) },
      eth_getTransactionReceipt: () => w.eth.receipts.get(body.params[0]) ?? null,
    }
    return reply(answers[body.method]())
  }
  w.deps = (now) => ({ read: async (p) => w.bucket.get(p) ?? null, write: async (p, o) => { w.bucket.set(p, JSON.parse(JSON.stringify(o))) }, fetchImpl: w.fetchImpl, sign, pub, now: new Date(now) })
  return w
}

test('nothing is sent while the addresses are unfunded, and the public summary says so', async () => {
  const w = world()
  const { code, results } = await run(w.deps('2026-10-16T00:00:00Z'))
  assert.equal(code, 0)
  assert.match(results.ethereum, /waiting for funds/)
  assert.match(results.xrpl, /waiting for funds/)
  assert.ok(!w.calls.includes('eth:eth_sendRawTransaction') && !w.calls.includes('xrpl:submit'))
  const s = w.bucket.get('anchors/chains.json')
  assert.equal(s.ethereum.address, ETH)
  assert.equal(s.xrpl.address, xrplAddress(pub))
  assert.equal(s.ethereum.funded, false)
})

test('when funded it posts the digest once on each chain, then recognises it as done', async () => {
  const w = world({ ethBalance: 10n ** 16n, xrpBalance: 5_000_000n })
  const first = await run(w.deps('2026-10-16T00:00:00Z'))
  assert.equal(first.code, 0)
  assert.match(first.results.ethereum, /^sent 0x/)
  assert.match(first.results.xrpl, /^sent [0-9A-F]{64}$/)
  assert.ok(w.eth.sent.startsWith('0x02'))
  assert.ok(w.xrp.submitted.toUpperCase().includes('52424F5301' + 'AB'.repeat(32).toUpperCase()), 'the memo carries the digest')
  assert.ok(w.bucket.has('anchors/2026-10-15T214050Z/ethereum.json') && w.bucket.has('anchors/2026-10-15T214050Z/xrpl.json'))
  const again = await run(w.deps('2026-10-16T01:00:00Z'))
  assert.equal(again.results.ethereum, 'already anchored')
  assert.equal(again.results.xrpl, 'already anchored')
})

test('submitted transactions become confirmed once the networks report them', async () => {
  const w = world({ ethBalance: 10n ** 16n, xrpBalance: 5_000_000n })
  await run(w.deps('2026-10-16T00:00:00Z'))
  const s = w.bucket.get('anchors/chains.json')
  w.eth.receipts.set(s.ethereum.recent[0].txid, { status: '0x1', blockNumber: '0x10' })
  w.xrp.validated.add(s.xrpl.recent[0].txid)
  await run(w.deps('2026-10-16T02:00:00Z'))
  const t = w.bucket.get('anchors/chains.json')
  assert.equal(t.ethereum.recent[0].status, 'confirmed')
  assert.equal(t.ethereum.recent[0].block, 16)
  assert.equal(t.xrpl.recent[0].status, 'confirmed')
  assert.equal(w.bucket.get('anchors/2026-10-15T214050Z/ethereum.json').status, 'confirmed')
})

test('high gas, a small XRP balance, and the 20-hour spacing each stop a send', async () => {
  const dear = world({ ethBalance: 10n ** 18n, xrpBalance: 1_100_000n, gwei: 200n })
  const r = await run(dear.deps('2026-10-16T00:00:00Z'))
  assert.match(r.results.ethereum, /gas is high/)
  assert.match(r.results.xrpl, /waiting for funds/)
  const spaced = world({ ethBalance: 10n ** 16n, xrpBalance: 5_000_000n })
  await run(spaced.deps('2026-10-16T00:00:00Z'))
  spaced.bucket.set('anchors/index.json', [{ id: '2026-10-16T050000Z', digest: 'cd'.repeat(32), status: 'pending' }, ...spaced.bucket.get('anchors/index.json')])
  const next = await run(spaced.deps('2026-10-16T05:00:00Z'))
  assert.match(next.results.ethereum, /waiting: last transaction/)
  assert.match(next.results.xrpl, /waiting: last transaction/)
})

test('only anchors/ objects can be written by the job entry point', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../anchor-chains.mjs', import.meta.url), 'utf8')
  assert.match(src, /objects may only be written under anchors\//)
})
