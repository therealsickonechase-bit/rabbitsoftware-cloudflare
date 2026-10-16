// Wallet watcher: a Cloud Run job that records what the RabbitOS wallet addresses have received, in a PRIVATE bucket, and raises an alert when money arrives.
// It only READS public networks and writes one private state file. It has no signing permission and cannot move anything.
//   Watched: the two donation addresses (from wallet.json: Bitcoin, Ethereum) and the two anchoring fee accounts (Ethereum, XRP Ledger; read from the public anchors/chains.json).
//   Output:  gs://<reports bucket>/wallet/state.json (private): balances, total ever received on Bitcoin, and the last 50 receipts.
//   Alert:   a log line with event "wallet_received" (WARNING). A log-based metric and an email alert policy are set up by Setup-GcpWalletWatch.ps1.
// Exit codes: 0 ok (including "nothing new"), 1 a network or the bucket could not be read.
import { readFile } from 'node:fs/promises'
import { formatEth } from './src/eth-tx.mjs'
import { formatBtc } from './src/btc-tx.mjs'
import { BTC_API, ETH_RPC } from './src/rpc.mjs'
import { XRPL_RPC } from './src/xrpl-rpc.mjs'

const KEEP = 50
const drops = (d) => `${d / 1_000_000n}.${(d % 1_000_000n).toString().padStart(6, '0')}`

async function jsonOf(fetchImpl, url, init) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), ...init })
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`)
  return res.json()
}

/** Each reader returns { balance: BigInt (smallest unit), received: BigInt|null (total ever received, when the network can say), text: (BigInt)=>string, unit }. */
export const READERS = {
  async bitcoin(address, fetchImpl) {
    const a = await jsonOf(fetchImpl, `${BTC_API}/address/${address}`)
    const c = a.chain_stats, m = a.mempool_stats
    const received = BigInt(c.funded_txo_sum) + BigInt(m.funded_txo_sum)
    const spent = BigInt(c.spent_txo_sum) + BigInt(m.spent_txo_sum)
    return { balance: received - spent, received, text: formatBtc, unit: 'BTC' }
  },
  async ethereum(address, fetchImpl) {
    const r = await jsonOf(fetchImpl, ETH_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }) })
    if (r.error) throw new Error('Ethereum node refused eth_getBalance')
    return { balance: BigInt(r.result), received: null, text: formatEth, unit: 'ETH' }
  },
  async xrpl(address, fetchImpl) {
    const r = await jsonOf(fetchImpl, XRPL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'account_info', params: [{ account: address, ledger_index: 'current' }] }) })
    const res = r.result ?? {}
    if (res.error === 'actNotFound') return { balance: 0n, received: null, text: drops, unit: 'XRP' }
    if (!res.account_data) throw new Error('XRP Ledger gave no account data')
    return { balance: BigInt(res.account_data.Balance), received: null, text: drops, unit: 'XRP' }
  },
}

/** deps: { sources:[{id,chain,address,role}], fetchImpl, readState()->obj|null, writeState(obj), now, log } */
export async function run(deps) {
  const { sources, fetchImpl = fetch, readState, writeState, now = new Date(), log = () => {} } = deps
  const prev = (await readState()) ?? { accounts: {}, receipts: [] }
  const next = { updatedAt: now.toISOString(), accounts: {}, receipts: [...(prev.receipts ?? [])] }
  let failed = 0
  for (const s of sources) {
    const before = prev.accounts?.[s.id]
    try {
      const r = await READERS[s.chain](s.address, fetchImpl)
      const acct = { chain: s.chain, role: s.role, address: s.address, unit: r.unit, balance: r.balance.toString(), balanceText: r.text(r.balance), received: r.received === null ? null : r.received.toString(), checkedAt: now.toISOString() }
      // new money = more total received (Bitcoin knows this exactly) or a higher balance (Ethereum and XRP)
      const gain = r.received !== null && before?.received != null ? r.received - BigInt(before.received) : before ? r.balance - BigInt(before.balance) : 0n
      if (!before) log('wallet_baseline', { id: s.id, balance: acct.balanceText, unit: r.unit })
      else if (gain > 0n) {
        const receipt = { at: now.toISOString(), id: s.id, role: s.role, chain: s.chain, amount: r.text(gain), unit: r.unit, balanceAfter: acct.balanceText }
        next.receipts.unshift(receipt)
        log('wallet_received', { id: s.id, role: s.role, amount: receipt.amount, unit: r.unit, balanceAfter: acct.balanceText })
      }
      next.accounts[s.id] = acct
    } catch (e) {
      failed++
      next.accounts[s.id] = before ?? { chain: s.chain, role: s.role, address: s.address, error: true }
      log('wallet_watch_failed', { id: s.id, reason: String(e.message).slice(0, 120) })
    }
  }
  next.receipts = next.receipts.slice(0, KEEP)
  await writeState(next)
  log('wallet_watch_done', { checked: sources.length, failed, receipts: next.receipts.length })
  return { code: failed === sources.length ? 1 : 0, state: next }
}

async function main() {
  const reports = process.env.REPORTS_BUCKET || 'rabbitsoftware-io-reports'
  const ledger = process.env.LEDGER_BUCKET || 'rabbitsoftware-io-ledger-public'
  for (const b of [reports, ledger]) if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(b)) throw new Error('bad bucket name')
  const token = (await (await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } })).json()).access_token
  const wallet = JSON.parse(await readFile(new URL('./wallet.json', import.meta.url), 'utf8'))
  const chains = await (await fetch(`https://${ledger}.storage.googleapis.com/anchors/chains.json?cb=${Date.now()}`)).json().catch(() => ({}))
  const sources = [
    { id: 'donation-bitcoin', chain: 'bitcoin', role: 'donation wallet', address: wallet.bitcoin.address },
    { id: 'donation-ethereum', chain: 'ethereum', role: 'donation wallet', address: wallet.ethereum.address },
    ...(chains.ethereum?.address ? [{ id: 'anchor-ethereum', chain: 'ethereum', role: 'anchoring fees', address: chains.ethereum.address }] : []),
    ...(chains.xrpl?.address ? [{ id: 'anchor-xrpl', chain: 'xrpl', role: 'anchoring fees', address: chains.xrpl.address }] : []),
  ]
  const OBJ = 'wallet/state.json'
  const url = (q) => `https://storage.googleapis.com/${q}`
  const readState = async () => {
    const r = await fetch(url(`storage/v1/b/${reports}/o/${encodeURIComponent(OBJ)}?alt=media`), { headers: { Authorization: `Bearer ${token}` } })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`bucket read ${r.status}`)
    return r.json()
  }
  const writeState = async (obj) => {
    const r = await fetch(url(`upload/storage/v1/b/${reports}/o?uploadType=media&name=${encodeURIComponent(OBJ)}`), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj, null, 1) })
    if (!r.ok) throw new Error(`bucket write ${r.status}`)
  }
  const log = (event, fields) => console.log(JSON.stringify({ severity: event === 'wallet_received' ? 'WARNING' : event.endsWith('_failed') ? 'ERROR' : 'INFO', event, ...fields }))
  return (await run({ sources, readState, writeState, log })).code
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()) && process.env.CLOUD_RUN_JOB) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(JSON.stringify({ severity: 'ERROR', event: 'wallet_watch_failed', reason: String(e.message).slice(0, 160) })); process.exit(1) })
}
