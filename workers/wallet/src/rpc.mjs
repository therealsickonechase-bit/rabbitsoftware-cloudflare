// Read and broadcast helpers for public networks. Every function takes `fetchImpl` so tests run without a network.
// Ethereum: a public JSON-RPC endpoint. Bitcoin: the mempool.space REST API. Neither is given any key or secret.
export const ETH_RPC = 'https://ethereum-rpc.publicnode.com'
export const BTC_API = 'https://mempool.space/api'

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), ...init })
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`)
  return res
}

async function rpc(fetchImpl, method, params, url = ETH_RPC) {
  const res = await getJson(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = await res.json()
  if (body.error) throw new Error(`Ethereum node refused ${method}: ${String(body.error.message).slice(0, 120)}`)
  return body.result
}
const big = (hex) => BigInt(hex)

/** Nonce (counting pending transactions), balance, and fee suggestions. maxFeePerGas = 2 x base fee + tip, the usual safe margin. */
export async function ethState(address, fetchImpl = fetch) {
  const [nonce, balance, block, tip] = await Promise.all([
    rpc(fetchImpl, 'eth_getTransactionCount', [address, 'pending']),
    rpc(fetchImpl, 'eth_getBalance', [address, 'latest']),
    rpc(fetchImpl, 'eth_getBlockByNumber', ['latest', false]),
    rpc(fetchImpl, 'eth_maxPriorityFeePerGas', []),
  ])
  const base = big(block.baseFeePerGas)
  const priority = big(tip) > 1_000_000_000n ? big(tip) : 1_000_000_000n
  return { nonce: big(nonce), balance: big(balance), baseFeePerGas: base, maxPriorityFeePerGas: priority, maxFeePerGas: 2n * base + priority }
}
export async function ethBroadcast(rawHex, fetchImpl = fetch) { return rpc(fetchImpl, 'eth_sendRawTransaction', [rawHex]) }

/** Confirmed coins only: spending an unconfirmed coin can be undone by its parent. */
export async function btcCoins(address, fetchImpl = fetch) {
  const list = await (await getJson(fetchImpl, `${BTC_API}/address/${address}/utxo`)).json()
  if (!Array.isArray(list)) throw new Error('unexpected answer for the unspent coins')
  return list.filter((u) => u.status && u.status.confirmed).map((u) => ({ txid: String(u.txid), vout: Number(u.vout), value: BigInt(u.value) }))
}
export async function btcFeeRates(fetchImpl = fetch) {
  const f = await (await getJson(fetchImpl, `${BTC_API}/v1/fees/recommended`)).json()
  return { fast: Number(f.fastestFee), normal: Number(f.halfHourFee), slow: Number(f.hourFee) }
}
export async function btcBroadcast(hex, fetchImpl = fetch) {
  const res = await getJson(fetchImpl, `${BTC_API}/tx`, { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' } })
  return (await res.text()).trim()
}
