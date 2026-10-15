// XRP Ledger public JSON-RPC. Every function takes `fetchImpl` so tests run without a network. No key or secret is sent: submit only carries an already-signed blob.
export const XRPL_RPC = 'https://xrplcluster.com'

async function call(fetchImpl, method, params = {}, url = XRPL_RPC) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`XRP Ledger server answered HTTP ${res.status}`)
  const body = (await res.json()).result ?? {}
  if (body.status === 'error' && body.error !== 'actNotFound' && body.error !== 'txnNotFound') throw new Error(`XRP Ledger refused ${method}: ${String(body.error_message || body.error).slice(0, 120)}`)
  return body
}

/** Balance in drops (1 XRP = 1,000,000 drops), the next sequence, and the reserve. A never-funded account reports funded:false. */
export async function xrplState(address, fetchImpl = fetch) {
  const [acct, info, fee] = await Promise.all([call(fetchImpl, 'account_info', { account: address, ledger_index: 'current' }), call(fetchImpl, 'server_info'), call(fetchImpl, 'fee')])
  const v = info.info?.validated_ledger ?? {}
  const reserveBase = BigInt(Math.round(Number(v.reserve_base_xrp ?? 1) * 1e6)), reserveInc = BigInt(Math.round(Number(v.reserve_inc_xrp ?? 0.2) * 1e6))
  const ledger = Number(v.seq ?? 0)
  const common = { reserveBase, reserveInc, ledger, openLedgerFee: BigInt(fee.drops?.open_ledger_fee ?? '10'), baseFee: BigInt(fee.drops?.base_fee ?? '10') }
  if (acct.error === 'actNotFound' || !acct.account_data) return { funded: false, balance: 0n, sequence: 1, ownerCount: 0, ...common }
  return { funded: true, balance: BigInt(acct.account_data.Balance), sequence: Number(acct.account_data.Sequence), ownerCount: Number(acct.account_data.OwnerCount ?? 0), ...common }
}
export async function xrplSubmit(blobHex, fetchImpl = fetch) {
  const r = await call(fetchImpl, 'submit', { tx_blob: blobHex })
  return { engine: r.engine_result, message: r.engine_result_message, hash: r.tx_json?.hash, accepted: Boolean(r.accepted) }
}
export async function xrplTx(hash, fetchImpl = fetch) {
  const r = await call(fetchImpl, 'tx', { transaction: hash, binary: false })
  if (r.error === 'txnNotFound') return { found: false }
  return { found: true, validated: Boolean(r.validated), result: r.meta?.TransactionResult, ledger: r.ledger_index }
}
