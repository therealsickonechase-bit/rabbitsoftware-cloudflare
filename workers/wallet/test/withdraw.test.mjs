import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bitcoinAddress, ethereumAddress } from '../src/addresses.mjs'
import { confirmed, loadDestinations, logAction } from '../src/guard.mjs'
import { N, mul, signForTest, toBytes } from '../src/secp256k1.mjs'
import { main } from '../withdraw.mjs'

const KEY = 0x0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1dn
const pub = mul(KEY)
const FROM_ETH = ethereumAddress(pub), FROM_BTC = bitcoinAddress(pub)
const KNOWN_ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', OTHER_ETH = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
const KNOWN_BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const enc = (n) => { let b = toBytes(n).toString('hex').replace(/^(00)+/, ''); if (b.length % 2) b = '0' + b; if (parseInt(b.slice(0, 2), 16) >= 128) b = '00' + b; return Buffer.from(b, 'hex') }
const der = ({ r, s }) => { const rb = enc(r), sb = enc(s); return Buffer.concat([Buffer.from([0x30, 4 + rb.length + sb.length, 2, rb.length]), rb, Buffer.from([2, sb.length]), sb]) }

function world({ ethBalance = 10n ** 18n, baseFee = 10_000_000_000n, coins } = {}) {
  const calls = { sign: 0, ethSend: [], btcSend: [] }
  const hex = (n) => '0x' + n.toString(16)
  const fetchImpl = async (url, init = {}) => {
    const json = (b) => new Response(JSON.stringify(b))
    if (url.includes('publicnode')) {
      const { method, params } = JSON.parse(init.body)
      const results = { eth_getTransactionCount: () => '0x3', eth_getBalance: () => hex(ethBalance), eth_getBlockByNumber: () => ({ baseFeePerGas: hex(baseFee) }), eth_maxPriorityFeePerGas: () => '0x59682f00', eth_sendRawTransaction: () => { calls.ethSend.push(params[0]); return '0x' + 'ab'.repeat(32) } }
      return json({ result: results[method]() })
    }
    if (url.endsWith('/utxo')) return json(coins ?? [{ txid: '11'.repeat(32), vout: 0, value: 400_000, status: { confirmed: true } }, { txid: '22'.repeat(32), vout: 1, value: 9_000_000, status: { confirmed: false } }])
    if (url.endsWith('/fees/recommended')) return json({ fastestFee: 30, halfHourFee: 12, hourFee: 4 })
    if (url.endsWith('/tx')) { calls.btcSend.push(init.body); return new Response('cd'.repeat(32)) }
    throw new Error('unexpected ' + url)
  }
  const sign = async (d) => { calls.sign++; return der(signForTest(d, KEY, 0x1badc0de1badc0de1badc0den)) }
  return { calls, fetchImpl, sign }
}
const run = async (args, { answers = [], tty = true, w = world(), allow = {}, limits } = {}) => {
  const lines = [], logs = []
  const queue = [...answers]
  const code = await main(args, {
    out: (t) => lines.push(t), fetchImpl: w.fetchImpl, sign: w.sign, pub, isTTY: tty, ask: async () => queue.shift() ?? '', log: (e) => logs.push(e),
    destinations: { ethereum: allow.ethereum ?? [{ address: KNOWN_ETH, label: 'cold' }], bitcoin: allow.bitcoin ?? [{ address: KNOWN_BTC, label: 'cold' }], limits: limits ?? { maxEth: '0.1', maxBtc: '0.01', maxFeeGwei: 200, maxFeeRateSatPerVb: 200 } },
  })
  return { code, text: lines.join('\n'), logs, calls: w.calls }
}

test('status reads balances and counts only confirmed Bitcoin coins', async () => {
  const r = await run(['status'])
  assert.equal(r.code, 0)
  assert.match(r.text, new RegExp(FROM_ETH))
  assert.match(r.text, /balance 1 ETH/)
  assert.match(r.text, /confirmed coins 1 .*0\.00400000 BTC/)       // the 9,000,000-sat coin is unconfirmed and ignored
})

test('a dry run shows the plan and signs and sends nothing', async () => {
  const r = await run(['eth', '--to', KNOWN_ETH, '--amount', '0.01'])
  assert.equal(r.code, 0)
  assert.match(r.text, /Send 0\.01 ETH/)
  assert.match(r.text, /Dry run only/)
  assert.equal(r.calls.sign, 0)
  assert.deepEqual(r.calls.ethSend, [])
})

test('a destination that is not on the allowlist stops everything, and the wallet itself is never a destination', async () => {
  const r = await run(['eth', '--to', OTHER_ETH, '--amount', '0.01', '--sign'])
  assert.equal(r.code, 2)
  assert.match(r.text, /not in your allowlist/)
  assert.equal(r.calls.sign, 0)
  const self = await run(['eth', '--to', FROM_ETH, '--amount', '0.01', '--sign'], { allow: { ethereum: [{ address: FROM_ETH }] } })
  assert.equal(self.code, 2)
  assert.match(self.text, /the wallet itself/)
  assert.equal(self.calls.sign, 0)
})

test('--new-destination allows an unknown address but --sign still sends nothing', async () => {
  const r = await run(['eth', '--to', OTHER_ETH, '--amount', '0.01', '--sign', '--new-destination'])
  assert.equal(r.code, 0)
  assert.match(r.text, /NOT on your allowlist/)
  assert.match(r.text, /Signed \(not sent\)[\s\S]*0x02[0-9a-f]+/)
  assert.equal(r.calls.sign, 1)
  assert.deepEqual(r.calls.ethSend, [])
})

test('limits stop an oversized amount, an expensive fee, and a balance that cannot cover amount plus fee', async () => {
  assert.match((await run(['eth', '--to', KNOWN_ETH, '--amount', '0.5', '--sign'])).text, /above your per-withdrawal limit/)
  assert.match((await run(['eth', '--to', KNOWN_ETH, '--amount', '0.01', '--sign'], { w: world({ baseFee: 500_000_000_000n }) })).text, /fee is above your safety limit/)
  const poor = await run(['eth', '--to', KNOWN_ETH, '--amount', '0.01', '--sign'], { w: world({ ethBalance: 10n ** 16n }) })
  assert.equal(poor.code, 2)
  assert.match(poor.text, /does not cover/)
  assert.equal(poor.calls.sign, 0)
})

test('sending needs a real terminal and the exact confirmation; anything else cancels before signing', async () => {
  const noTty = await run(['eth', '--to', KNOWN_ETH, '--amount', '0.01', '--broadcast'], { tty: false })
  assert.equal(noTty.code, 2)
  assert.match(noTty.text, /real terminal/)
  assert.equal(noTty.calls.sign, 0)
  for (const answers of [['', ''], [KNOWN_ETH.slice(-8), 'send'], ['12345678', 'SEND'], [KNOWN_ETH.slice(-8), '']]) {
    const r = await run(['eth', '--to', KNOWN_ETH, '--amount', '0.01', '--broadcast'], { answers })
    assert.equal(r.code, 3, JSON.stringify(answers))
    assert.equal(r.calls.sign, 0)
    assert.deepEqual(r.calls.ethSend, [])
    assert.ok(r.logs.some((l) => l.action === 'cancelled'))
  }
})

test('a confirmed Ethereum send signs once, broadcasts once, and logs ids but no raw transaction or signature', async () => {
  const r = await run(['eth', '--to', KNOWN_ETH, '--amount', '0.01', '--broadcast'], { answers: [KNOWN_ETH.slice(-8), 'SEND'] })
  assert.equal(r.code, 0)
  assert.equal(r.calls.sign, 1)
  assert.equal(r.calls.ethSend.length, 1)
  assert.match(r.calls.ethSend[0], /^0x02/)
  assert.match(r.text, /etherscan\.io\/tx\/0xabab/)
  const actions = r.logs.map((l) => l.action)
  assert.deepEqual(actions, ['signed', 'broadcast'])
  assert.ok(!JSON.stringify(r.logs).includes(r.calls.ethSend[0]))
})

test('a new destination needs the WHOLE address retyped', async () => {
  const short = await run(['eth', '--to', OTHER_ETH, '--amount', '0.01', '--broadcast', '--new-destination'], { answers: [OTHER_ETH.slice(-8), 'SEND'] })
  assert.equal(short.code, 3)
  const whole = await run(['eth', '--to', OTHER_ETH, '--amount', '0.01', '--broadcast', '--new-destination'], { answers: [OTHER_ETH, 'SEND'] })
  assert.equal(whole.code, 0)
  assert.equal(confirmed('abc', 'SEND', 'xxxxabc', false), false)
})

test('Bitcoin: a sweep dry run, then a confirmed send of a payment with change', async () => {
  const dry = await run(['btc', '--to', KNOWN_BTC, '--sweep'], { limits: { maxEth: '0.1', maxBtc: '0.01', maxFeeGwei: 200, maxFeeRateSatPerVb: 200 } })
  assert.equal(dry.code, 0)
  assert.match(dry.text, /everything, minus the fee/)
  assert.match(dry.text, /fee .* sats at 12 sat\/vB/)
  assert.equal(dry.calls.sign, 0)
  const pay = await run(['btc', '--to', KNOWN_BTC, '--amount', '0.002', '--fee-rate', '15', '--broadcast'], { answers: [KNOWN_BTC.slice(-8), 'SEND'] })
  assert.equal(pay.code, 0)
  assert.equal(pay.calls.sign, 1)
  assert.equal(pay.calls.btcSend.length, 1)
  assert.match(pay.calls.btcSend[0], /^02000000000101/)
  assert.match(pay.text, /mempool\.space\/tx\/cdcd/)
  const over = await run(['btc', '--to', KNOWN_BTC, '--amount', '0.02', '--sign'])
  assert.match(over.text, /balance does not cover|above your per-withdrawal limit/)
  assert.equal(over.calls.sign, 0)
  const rich = await run(['btc', '--to', KNOWN_BTC, '--amount', '0.002', '--fee-rate', '500', '--sign'])
  assert.match(rich.text + '', /safety limit/)
})

test('the allowlist file and the log: a missing file means an empty list with default limits; the log is one JSON line per action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-'))
  const none = loadDestinations(join(dir, 'missing.json'))
  assert.deepEqual([none.ethereum, none.bitcoin], [[], []])
  assert.equal(none.limits.maxEth, '0.1')
  logAction({ action: 'signed', chain: 'ethereum', id: '0x1' }, join(dir, 'logs', 'w.log'))
  logAction({ action: 'broadcast', chain: 'ethereum', id: '0x1' }, join(dir, 'logs', 'w.log'))
  const lines = readFileSync(join(dir, 'logs', 'w.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.ok(lines[0].time && lines[0].action === 'signed')
  assert.ok(existsSync(join(dir, 'logs')))
})
