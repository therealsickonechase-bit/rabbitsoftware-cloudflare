import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { bitcoinAddress, ethereumAddress } from '../src/addresses.mjs'
import { destinationScript, formatBtc, ownScript, parseBtc, planPayment, sighashP2wpkh, signPayment } from '../src/btc-tx.mjs'
import { buildTransfer, formatEth, maxCost, parseEth, senderOf, signTransfer } from '../src/eth-tx.mjs'
import { keccak256 } from '../src/keccak.mjs'
import { encodeRlp } from '../src/rlp.mjs'
import { N, fromBytes, mul, signForTest, toBytes, verify } from '../src/secp256k1.mjs'

const hex = (b) => Buffer.from(b).toString('hex')
const enc = (n) => { let b = toBytes(n).toString('hex').replace(/^(00)+/, ''); if (b.length % 2) b = '0' + b; if (parseInt(b.slice(0, 2), 16) >= 128) b = '00' + b; return Buffer.from(b, 'hex') }
const der = ({ r, s }) => { const rb = enc(r), sb = enc(s); return Buffer.concat([Buffer.from([0x30, 4 + rb.length + sb.length, 2, rb.length]), rb, Buffer.from([2, sb.length]), sb]) }
// A software stand-in for the hardware key, used in tests only (k fixed). It sometimes returns the high-s form, as the HSM can.
const TEST_KEY = 0x0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1dn
const pub = mul(TEST_KEY)
const signer = (highS = false) => async (digest) => { const sig = signForTest(digest, TEST_KEY, 0x1badc0de1badc0de1badc0den); return der(highS ? { r: sig.r, s: N - sig.s } : sig) }

test('RLP matches the published examples', () => {
  assert.equal(hex(encodeRlp(Buffer.from('dog'))), '83646f67')
  assert.equal(hex(encodeRlp([Buffer.from('cat'), Buffer.from('dog')])), 'c88363617483646f67')
  assert.equal(hex(encodeRlp(0)), '80')
  assert.equal(hex(encodeRlp(15)), '0f')
  assert.equal(hex(encodeRlp(1024)), '820400')
  assert.equal(hex(encodeRlp([])), 'c0')
  assert.equal(hex(encodeRlp(Buffer.from('Lorem ipsum dolor sit amet, consectetur adipisicing elit'))), 'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974')
})

test('the EIP-155 example transaction serializes and hashes to the published values (RLP + keccak are right)', () => {
  const fields = [9, 20n * 10n ** 9n, 21000, Buffer.from('3535353535353535353535353535353535353535', 'hex'), 10n ** 18n, Buffer.alloc(0), 1, 0, 0]
  const payload = encodeRlp(fields)
  assert.equal(hex(payload), 'ec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080')
  assert.equal(hex(keccak256(payload)), 'daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53')
})

test('ETH amounts parse exactly and refuse anything odd', () => {
  assert.equal(parseEth('1'), 10n ** 18n)
  assert.equal(parseEth('0.015'), 15n * 10n ** 15n)
  assert.equal(parseEth('0.000000000000000001'), 1n)
  assert.equal(formatEth(15n * 10n ** 15n), '0.015')
  for (const bad of ['-1', '1e3', '0.0000000000000000001', '', 'abc', '1,5', '+1']) assert.throws(() => parseEth(bad), /plain decimal/, bad)
})

test('an Ethereum transfer is built, signed through the "key", and the sender recovers to the wallet address', async () => {
  const from = ethereumAddress(pub)
  const to = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const tx = buildTransfer({ nonce: 3n, maxPriorityFeePerGas: 1_500_000_000n, maxFeePerGas: 30_000_000_000n, to, value: parseEth('0.01') })
  assert.equal(maxCost(tx), parseEth('0.01') + 21000n * 30_000_000_000n)
  for (const high of [false, true]) {
    const signed = await signTransfer(tx, signer(high), pub)
    assert.equal(signed.from, from)
    assert.equal(senderOf(tx, signed), from)
    assert.match(signed.raw, /^0x02[0-9a-f]+$/)
    assert.match(signed.hash, /^0x[0-9a-f]{64}$/)
    assert.equal(signed.raw.length > 2 + 2 * 60, true)
  }
})

test('Ethereum safety rules: right chain only, valid checksummed destination, plain transfers, sane fees', () => {
  const ok = { nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, to: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', value: 1n }
  assert.ok(buildTransfer(ok))
  assert.throws(() => buildTransfer({ ...ok, chainId: 5n }), /mainnet/)
  assert.throws(() => buildTransfer({ ...ok, to: '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' }), /valid Ethereum address/)
  assert.throws(() => buildTransfer({ ...ok, to: '0x123' }), /valid Ethereum address/)
  assert.throws(() => buildTransfer({ ...ok, value: 0n }), /greater than zero/)
  assert.throws(() => buildTransfer({ ...ok, maxFeePerGas: 0n }), /maxFeePerGas/)
  assert.throws(() => buildTransfer({ ...ok, gasLimit: 100000n }), /plain transfers/)
})

test('BIP143 native P2WPKH example: hashPrevouts, hashSequence, hashOutputs and the signature hash match the specification', () => {
  const inputs = [
    { outpoint: Buffer.from('fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000', 'hex'), sequence: 0xffffffee, value: 625000000 },
    { outpoint: Buffer.from('ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a01000000', 'hex'), sequence: 0xffffffff, value: 600000000 },
  ]
  const outputs = [
    { value: 112340000, script: Buffer.from('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac', 'hex') },
    { value: 223450000, script: Buffer.from('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac', 'hex') },
  ]
  const pubkey = Buffer.from('025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357', 'hex')
  const pubkeyHash = createHash('ripemd160').update(createHash('sha256').update(pubkey).digest()).digest()
  assert.equal(hex(pubkeyHash), '1d0f172a0ecb48aee1be1f2687d2963ae33f71a1')
  const r = sighashP2wpkh({ version: 1, locktime: 17, inputs, outputs, index: 1, pubkeyHash })
  assert.equal(hex(r.hashPrevouts), '96b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd37')
  assert.equal(hex(r.hashSequence), '52b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3b')
  assert.equal(hex(r.hashOutputs), '863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e5')
  assert.equal(hex(r.hash), 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670')
})

test('BTC amounts parse exactly and refuse anything odd', () => {
  assert.equal(parseBtc('0.0015'), 150000n)
  assert.equal(parseBtc('1'), 100000000n)
  assert.equal(formatBtc(150000n), '0.00150000')
  for (const bad of ['-1', '1e3', '0.000000001', '', 'x']) assert.throws(() => parseBtc(bad), /plain decimal/, bad)
})

const coin = (n, value) => ({ txid: (n.toString(16).padStart(2, '0')).repeat(32), vout: n, value })

test('BTC destinations: native SegWit mainnet only', () => {
  assert.equal(hex(destinationScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').script), '0014751e76e8199196d454941c45d1b3a323f1433bd6')
  for (const bad of ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'hello']) assert.throws(() => destinationScript(bad), /Bitcoin|SegWit/, bad)
})

test('a BTC payment with change: inputs cover amount and fee, change returns to the wallet, fee matches the rate', () => {
  const to = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const plan = planPayment({ utxos: [coin(1, 50_000), coin(2, 200_000)], pub, destination: to, amountSats: 120_000n, feeRate: 10 })
  assert.equal(plan.inputs.length, 1)                        // the larger coin alone is enough
  const total = plan.inputs.reduce((n, i) => n + i.value, 0n)
  const out = plan.outputs.reduce((n, o) => n + o.value, 0n)
  assert.equal(total, out + plan.fee)
  assert.equal(plan.outputs.length, 2)
  assert.equal(hex(plan.outputs[1].script), hex(ownScript(pub)))   // change goes back to the wallet
  assert.equal(plan.fee, BigInt(Math.ceil(plan.vsize * 10)))
})

test('a BTC sweep sends everything minus the fee in one output; tiny change becomes fee; too-small balances are refused', () => {
  const to = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const sweep = planPayment({ utxos: [coin(1, 50_000), coin(2, 200_000)], pub, destination: to, amountSats: null, feeRate: 5 })
  assert.equal(sweep.outputs.length, 1)
  assert.equal(sweep.outputs[0].value + sweep.fee, 250_000n)
  const exact = planPayment({ utxos: [coin(1, 100_300)], pub, destination: to, amountSats: 100_000n, feeRate: 1 })
  assert.equal(exact.outputs.length, 1)                       // change would be dust: folded into the fee
  assert.equal(exact.outputs[0].value + exact.fee, 100_300n)
  assert.throws(() => planPayment({ utxos: [coin(1, 100)], pub, destination: to, amountSats: null, feeRate: 10 }), /fee/)
  assert.throws(() => planPayment({ utxos: [coin(1, 10_000)], pub, destination: to, amountSats: 20_000n, feeRate: 2 }), /balance/)
  assert.throws(() => planPayment({ utxos: [], pub, destination: to, amountSats: 1000n, feeRate: 2 }), /no spendable/)
  assert.throws(() => planPayment({ utxos: [coin(1, 5_000_000)], pub, destination: to, amountSats: null, feeRate: 5000 }), /safety limit/)
  assert.throws(() => planPayment({ utxos: [coin(1, 10_000)], pub, destination: to, amountSats: 100n, feeRate: 2 }), /dust/)
})

test('a signed BTC transaction has valid signatures for every input, the right structure and a txid', async () => {
  const to = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const plan = planPayment({ utxos: [coin(1, 60_000), coin(2, 70_000)], pub, destination: to, amountSats: 100_000n, feeRate: 8 })
  assert.equal(plan.inputs.length, 2)
  for (const high of [false, true]) {
    const tx = await signPayment(plan, signer(high), pub)
    assert.match(tx.hex, /^02000000000102/)                   // version 2, segwit marker, two inputs
    assert.match(tx.txid, /^[0-9a-f]{64}$/)
    assert.ok(tx.hex.endsWith('00000000'))                    // locktime
    assert.ok(Math.abs(tx.vbytes - plan.vsize) <= 2, `estimated ${plan.vsize} vs actual ${tx.vbytes}`)
  }
  await assert.rejects(signPayment(plan, async (d) => der(signForTest(d, TEST_KEY + 1n, 0x1badc0den)), pub), /does not belong/)
})

test('the same wallet key gives both addresses used above', () => {
  assert.match(bitcoinAddress(pub), /^bc1q/)
  assert.match(ethereumAddress(pub), /^0x/)
  assert.ok(verify(keccak256(Buffer.from('x')), ...(() => { const s = signForTest(keccak256(Buffer.from('x')), TEST_KEY, 5n); return [s.r, s.s] })(), pub))
  assert.equal(fromBytes(toBytes(5n)), 5n)
})
