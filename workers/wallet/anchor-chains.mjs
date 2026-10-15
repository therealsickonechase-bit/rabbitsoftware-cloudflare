// Ethereum and XRP Ledger anchoring for the RabbitOS chains, as a Cloud Run job. The Bitcoin anchor (OpenTimestamps) is the separate rabbit-anchor job; this posts the SAME digest
// (the sha256 of anchors/<id>/anchor.json) into one Ethereum transaction and one XRP Ledger transaction, signed by a dedicated Cloud KMS key that holds only a little gas money.
// It never touches the donation wallet key. Public output under anchors/ in the public ledger bucket:
//   anchors/<id>/ethereum.json  anchors/<id>/xrpl.json   one per chain per anchor: txid, status, block or ledger
//   anchors/chains.json                                  the two addresses, whether they are funded, and the newest anchors
// Guards: unfunded or too-expensive means "wait" (nothing is sent); at most one transaction per chain per 20 hours; Ethereum fee cap 60 gwei, XRPL fee cap 1000 drops.
// Exit codes: 0 ok (including "waiting for funds"), 1 a source, the key or the bucket could not be reached.
import { ethereumAddress, pubFromPem } from './src/addresses.mjs'
import { ANCHOR_GAS_LIMIT, buildAnchorTransaction, maxGasCost } from './src/eth-anchor.mjs'
import { formatEth, senderOf, signTransfer } from './src/eth-tx.mjs'
import { ethBroadcast, ethReceipt, ethState } from './src/rpc.mjs'
import { buildAnchorTx, signAnchorTx, xrplAddress } from './src/xrpl.mjs'
import { xrplState, xrplSubmit, xrplTx } from './src/xrpl-rpc.mjs'

export const ANCHOR_KEY_VERSION = 'projects/rabbitsoftware-io/locations/us-west2/keyRings/rabbit-wallet/cryptoKeys/anchor-signer/cryptoKeyVersions/1'
export const MAX_ETH_FEE_GWEI = 60n
export const MIN_HOURS_BETWEEN = 20
export const XRPL_SAFETY_DROPS = 200_000n   // keep this much above the reserve so the account never dips below it

const HEX64 = /^[0-9a-f]{64}$/
const hoursSince = (iso, now) => (iso ? (now - new Date(iso)) / 3_600_000 : Infinity)

/**
 * deps: { read(path)->object|null, write(path, object), fetchImpl, sign(digest)->DER, pub, now, log }
 * Returns { code, results }.
 */
export async function run(deps) {
  const { read, write, fetchImpl = fetch, sign, pub, now = new Date(), log = () => {} } = deps
  const eth = ethereumAddress(pub), xrp = xrplAddress(pub)
  const index = (await read('anchors/index.json')) ?? []
  const entry = index[0]
  const summary = (await read('anchors/chains.json')) ?? {}
  const state = { ethereum: { address: eth, ...(summary.ethereum ?? {}) }, xrpl: { address: xrp, ...(summary.xrpl ?? {}) } }
  state.ethereum.address = eth; state.xrpl.address = xrp
  const results = {}

  // 1. refresh the status of anything already sent
  for (const [chain, check] of [['ethereum', checkEth], ['xrpl', checkXrpl]]) {
    for (const rec of state[chain].recent ?? []) {
      if (rec.status === 'confirmed' || !rec.txid) continue
      try {
        const upd = await check(rec.txid, fetchImpl)
        if (upd) { Object.assign(rec, upd); await write(`anchors/${rec.id}/${chain}.json`, { chain, ...rec }) }
      } catch (e) { log('status_check_failed', { chain, reason: String(e.message).slice(0, 120) }) }
    }
  }

  // 2. post the newest anchor's digest where it has not been posted
  if (entry && HEX64.test(entry.digest ?? '')) {
    const digest = Buffer.from(entry.digest, 'hex')
    for (const [chain, post] of [['ethereum', postEth], ['xrpl', postXrpl]]) {
      const s = state[chain]
      const done = (s.recent ?? []).some((r) => r.id === entry.id && r.txid)
      if (done) { results[chain] = 'already anchored'; continue }
      if (hoursSince(s.lastSentAt, now) < MIN_HOURS_BETWEEN) { results[chain] = `waiting: last transaction under ${MIN_HOURS_BETWEEN} hours ago`; continue }
      try {
        const out = await post({ entry, digest, sign, pub, fetchImpl, now })
        results[chain] = out.note
        s.funded = out.funded; s.balance = out.balance
        if (out.sent) {
          const rec = { id: entry.id, digest: entry.digest, txid: out.txid, status: 'submitted', sentAt: now.toISOString(), explorer: out.explorer }
          s.recent = [rec, ...(s.recent ?? [])].slice(0, 20); s.lastSentAt = rec.sentAt
          await write(`anchors/${entry.id}/${chain}.json`, { chain, ...rec })
        }
      } catch (e) { results[chain] = 'failed: ' + String(e.message).slice(0, 120); log('post_failed', { chain, reason: results[chain] }) }
    }
  } else results.note = 'no anchor yet'

  state.updatedAt = now.toISOString()
  await write('anchors/chains.json', state)
  log('anchor_chains_done', results)
  return { code: Object.values(results).some((r) => String(r).startsWith('failed')) ? 1 : 0, results }
}

async function checkEth(txid, fetchImpl) {
  const r = await ethReceipt(txid, fetchImpl)
  return r ? { status: r.ok ? 'confirmed' : 'failed', block: r.block } : null
}
async function checkXrpl(txid, fetchImpl) {
  const t = await xrplTx(txid, fetchImpl)
  if (!t.found || !t.validated) return null
  return { status: t.result === 'tesSUCCESS' ? 'confirmed' : 'failed', ledger: t.ledger }
}

async function postEth({ digest, sign, pub, fetchImpl }) {
  const address = ethereumAddress(pub)
  const st = await ethState(address, fetchImpl)
  const fee = st.maxFeePerGas
  const bal = formatEth(st.balance)
  if (fee > MAX_ETH_FEE_GWEI * 1_000_000_000n) return { sent: false, funded: st.balance > 0n, balance: bal, note: `waiting: gas is high (${fee / 1_000_000_000n} gwei, cap ${MAX_ETH_FEE_GWEI})` }
  const tx = buildAnchorTransaction({ nonce: st.nonce, maxPriorityFeePerGas: st.maxPriorityFeePerGas, maxFeePerGas: fee, self: address, digest })
  if (st.balance < maxGasCost(tx)) return { sent: false, funded: st.balance > 0n, balance: bal, note: `waiting for funds: needs about ${formatEth(maxGasCost(tx))} ETH, has ${bal}` }
  const signed = await signTransfer(tx, sign, pub)
  if (senderOf(tx, signed) !== address) throw new Error('signature does not recover to the anchoring address')
  const id = (await ethBroadcast(signed.raw, fetchImpl)) || signed.hash
  return { sent: true, funded: true, balance: bal, txid: id, explorer: `https://etherscan.io/tx/${id}`, note: `sent ${id}` }
}

async function postXrpl({ digest, sign, pub, fetchImpl }) {
  const address = xrplAddress(pub)
  const st = await xrplState(address, fetchImpl)
  if (!st.funded) return { sent: false, funded: false, balance: '0', note: 'waiting for funds: the XRP Ledger account does not exist yet (send at least 2 XRP to activate it)' }
  const fee = st.openLedgerFee > st.baseFee ? st.openLedgerFee : st.baseFee
  const reserve = st.reserveBase + BigInt(st.ownerCount) * st.reserveInc
  const bal = (Number(st.balance) / 1e6).toString()
  if (fee > 1000n) return { sent: false, funded: true, balance: bal, note: `waiting: the network fee is high (${fee} drops)` }
  if (st.balance < reserve + fee + XRPL_SAFETY_DROPS) return { sent: false, funded: true, balance: bal, note: `waiting for funds: ${bal} XRP, reserve ${Number(reserve) / 1e6}` }
  const memo = Buffer.concat([Buffer.from('RBOS'), Buffer.from([1]), digest])
  const tx = buildAnchorTx({ account: address, sequence: st.sequence, lastLedger: st.ledger + 20, fee, memoData: memo })
  const signed = await signAnchorTx(tx, sign, pub)
  const r = await xrplSubmit(signed.blob, fetchImpl)
  if (!/^(tesSUCCESS|terQUEUED)$/.test(r.engine ?? '')) throw new Error(`XRP Ledger did not accept it: ${r.engine} ${String(r.message ?? '').slice(0, 80)}`)
  return { sent: true, funded: true, balance: bal, txid: signed.hash, explorer: `https://livenet.xrpl.org/transactions/${signed.hash}`, note: `sent ${signed.hash}` }
}

// ---------------------------------------------------------------- Cloud Run entry (runs only when started directly)
async function main() {
  const { getPublicKeyPem, signDigest } = await import('./src/kms.mjs')
  const bucket = process.env.LEDGER_BUCKET || 'rabbitsoftware-io-ledger-public'
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket)) throw new Error('bad bucket name')
  const metaToken = async () => (await (await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } })).json()).access_token
  const token = await metaToken()
  const opts = { keyVersion: ANCHOR_KEY_VERSION, tokenFn: () => token }
  const pub = pubFromPem(await getPublicKeyPem(opts))
  const safe = (p) => { if (!/^anchors\/[A-Za-z0-9._\/-]{1,120}$/.test(p) || p.includes('..')) throw new Error('objects may only be written under anchors/'); return p }
  const read = async (path) => {
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(safe(path))}?alt=media`, { headers: { Authorization: `Bearer ${token}` } })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`bucket read ${r.status}`)
    return r.json()
  }
  const write = async (path, obj) => {
    const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(safe(path))}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify(obj, null, 1) })
    if (!r.ok) throw new Error(`bucket write ${r.status}`)
  }
  const log = (event, fields) => console.log(JSON.stringify({ severity: event.endsWith('_failed') ? 'ERROR' : 'INFO', event, ...fields }))
  const { code } = await run({ read, write, sign: (d) => signDigest(d, opts), pub, log })
  return code
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()) && process.env.CLOUD_RUN_JOB) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(JSON.stringify({ severity: 'ERROR', event: 'anchor_chains_failed', reason: String(e.message).slice(0, 160) })); process.exit(1) })
}
