import assert from 'node:assert/strict'
import test from 'node:test'
import { run } from '../wallet-watch.mjs'

const sources = [
  { id: 'donation-bitcoin', chain: 'bitcoin', role: 'donation wallet', address: 'bc1qxxxx' },
  { id: 'donation-ethereum', chain: 'ethereum', role: 'donation wallet', address: '0xabc' },
  { id: 'anchor-xrpl', chain: 'xrpl', role: 'anchoring fees', address: 'rXYZ' },
]
function world() {
  const w = { btcFunded: 0, btcSpent: 0, ethWei: 0n, xrpDrops: null, down: new Set(), state: null, logs: [] }
  w.fetchImpl = async (url, init) => {
    const host = new URL(url).host
    if (w.down.has(host)) return { ok: false, status: 503, json: async () => ({}) }
    if (host === 'mempool.space') return { ok: true, json: async () => ({ chain_stats: { funded_txo_sum: w.btcFunded, spent_txo_sum: w.btcSpent }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }) }
    const body = JSON.parse(init.body)
    if (body.method === 'eth_getBalance') return { ok: true, json: async () => ({ result: '0x' + w.ethWei.toString(16) }) }
    if (body.method === 'account_info') return { ok: true, json: async () => ({ result: w.xrpDrops === null ? { status: 'error', error: 'actNotFound' } : { account_data: { Balance: String(w.xrpDrops) } } }) }
    throw new Error('unexpected ' + url)
  }
  w.deps = (now = '2026-10-16T01:00:00Z') => ({ sources, fetchImpl: w.fetchImpl, readState: async () => w.state, writeState: async (s) => { w.state = JSON.parse(JSON.stringify(s)) }, now: new Date(now), log: (e, f) => w.logs.push([e, f]) })
  return w
}
const events = (w) => w.logs.map((l) => l[0])

test('the first run records a baseline and raises no alert', async () => {
  const w = world()
  const { code } = await run(w.deps())
  assert.equal(code, 0)
  assert.ok(!events(w).includes('wallet_received'))
  assert.equal(w.state.accounts['donation-bitcoin'].balanceText, '0.00000000')
  assert.equal(w.state.accounts['anchor-xrpl'].balanceText, '0.000000')
})

test('money arriving on each network is reported once, with the amount', async () => {
  const w = world()
  await run(w.deps())
  w.logs.length = 0
  w.btcFunded = 150_000; w.ethWei = 3n * 10n ** 15n; w.xrpDrops = 2_500_000
  await run(w.deps('2026-10-16T02:00:00Z'))
  const got = Object.fromEntries(w.logs.filter((l) => l[0] === 'wallet_received').map((l) => [l[1].id, l[1].amount + ' ' + l[1].unit]))
  assert.deepEqual(got, { 'donation-bitcoin': '0.00150000 BTC', 'donation-ethereum': '0.003 ETH', 'anchor-xrpl': '2.500000 XRP' })
  assert.equal(w.state.receipts.length, 3)
  w.logs.length = 0
  await run(w.deps('2026-10-16T03:00:00Z'))
  assert.ok(!events(w).includes('wallet_received'), 'no repeat alert when nothing changed')
})

test('Bitcoin counts a receipt even if the money was spent in between; spending alone is not a receipt', async () => {
  const w = world()
  w.btcFunded = 100_000
  await run(w.deps())
  w.logs.length = 0
  w.btcSpent = 100_000          // everything sent out
  await run(w.deps('2026-10-16T02:00:00Z'))
  assert.ok(!events(w).includes('wallet_received'))
  w.btcFunded = 130_000         // 30,000 more arrived, balance is only 30,000 now
  await run(w.deps('2026-10-16T03:00:00Z'))
  assert.equal(w.logs.find((l) => l[0] === 'wallet_received')[1].amount, '0.00030000')
})

test('a falling balance (money sent out) is never reported as received', async () => {
  const w = world()
  w.ethWei = 5n * 10n ** 15n
  await run(w.deps())
  w.logs.length = 0
  w.ethWei = 1n * 10n ** 15n
  await run(w.deps('2026-10-16T02:00:00Z'))
  assert.ok(!events(w).includes('wallet_received'))
})

test('one network being down keeps the last known state and still records the others; all down fails the run', async () => {
  const w = world()
  w.ethWei = 10n ** 15n
  await run(w.deps())
  w.down.add('mempool.space')
  w.ethWei = 2n * 10n ** 15n
  const partial = await run(w.deps('2026-10-16T02:00:00Z'))
  assert.equal(partial.code, 0)
  assert.ok(events(w).includes('wallet_watch_failed'))
  assert.equal(w.state.accounts['donation-ethereum'].balanceText, '0.002')
  assert.ok(w.state.accounts['donation-bitcoin'].balanceText, 'previous Bitcoin reading is kept')
  w.down.add('ethereum-rpc.publicnode.com'); w.down.add('xrplcluster.com')
  assert.equal((await run(w.deps('2026-10-16T03:00:00Z'))).code, 1)
})

test('only the last 50 receipts are kept', async () => {
  const w = world()
  await run(w.deps())
  for (let i = 1; i <= 55; i++) { w.ethWei = BigInt(i) * 10n ** 15n; await run(w.deps(`2026-10-16T${String(i % 24).padStart(2, '0')}:00:00Z`)) }
  assert.equal(w.state.receipts.length, 50)
})
