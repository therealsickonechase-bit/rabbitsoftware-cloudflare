// Withdrawals from the RabbitOS wallet. The private key stays inside Cloud KMS: this tool builds a transaction, asks the hardware key to sign its hash, and (only if you say so) sends it.
//
//   node withdraw.mjs status
//   node withdraw.mjs eth --to 0x... --amount 0.01                  dry run: shows the plan, signs nothing
//   node withdraw.mjs eth --to 0x... --amount 0.01 --sign           signs and prints the raw transaction, sends nothing
//   node withdraw.mjs eth --to 0x... --amount 0.01 --broadcast      signs, asks you to retype the destination, then sends
//   node withdraw.mjs btc --to bc1q... --amount 0.001 [--fee-rate 12] [--sign|--broadcast]
//   node withdraw.mjs btc --to bc1q... --sweep                      everything the wallet holds, minus the fee
//
// Guards: the destination must be in ~/RabbitOS/wallet-destinations.json (or --new-destination, which makes you retype the WHOLE address); per-withdrawal limits; fee limits;
// only confirmed Bitcoin coins; Ethereum mainnet only; a broadcast needs a real terminal. Every signing and sending is logged to ~/RabbitOS/logs/wallet-withdrawals.log (no keys).
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { bitcoinAddress, ethereumAddress, pubFromPem } from './src/addresses.mjs'
import { formatBtc, parseBtc, planPayment, signPayment } from './src/btc-tx.mjs'
import { buildTransfer, formatEth, maxCost, parseEth, signTransfer } from './src/eth-tx.mjs'
import { checkWithdrawal, confirmationPhrase, confirmed, isAllowlisted, loadDestinations, logAction } from './src/guard.mjs'
import { btcBroadcast, btcCoins, btcFeeRates, ethBroadcast, ethState } from './src/rpc.mjs'
import { signDigest } from './src/kms.mjs'

const OPTIONS = { to: { type: 'string' }, amount: { type: 'string' }, sweep: { type: 'boolean' }, 'fee-rate': { type: 'string' }, 'max-fee-gwei': { type: 'string' }, sign: { type: 'boolean' }, broadcast: { type: 'boolean' }, 'new-destination': { type: 'boolean' } }

export async function main(argv, deps = {}) {
  const out = deps.out ?? ((t) => console.log(t))
  const fetchImpl = deps.fetchImpl ?? fetch
  const sign = deps.sign ?? ((d) => signDigest(d))
  const log = deps.log ?? logAction
  const pub = deps.pub ?? pubFromPem(await readFile(new URL('./public-key.pem', import.meta.url), 'utf8'))
  const destinations = deps.destinations ?? loadDestinations()
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const ask = deps.ask ?? (async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q) } finally { rl.close() } })
  const { positionals, values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  const [command] = positionals
  const ethAddress = ethereumAddress(pub), btcAddress = bitcoinAddress(pub)
  if (deps.expect && (deps.expect.ethereum !== ethAddress || deps.expect.bitcoin !== btcAddress)) throw new Error('the key does not match the published wallet addresses')

  if (command === 'status') {
    const [e, coins] = await Promise.all([ethState(ethAddress, fetchImpl), btcCoins(btcAddress, fetchImpl)])
    out(`Ethereum ${ethAddress}\n  balance ${formatEth(e.balance)} ETH   next nonce ${e.nonce}`)
    out(`Bitcoin  ${btcAddress}\n  confirmed coins ${coins.length}   balance ${formatBtc(coins.reduce((n, c) => n + c.value, 0n))} BTC`)
    out(`\nDestinations on your allowlist: ethereum ${destinations.ethereum.length}, bitcoin ${destinations.bitcoin.length}`)
    return 0
  }
  if (command !== 'eth' && command !== 'btc') { out('Usage: node withdraw.mjs status | eth --to ADDRESS --amount ETH | btc --to ADDRESS (--amount BTC | --sweep)   [--sign | --broadcast]'); return 1 }
  if (!values.to) throw new Error('--to is required')
  const chain = command === 'eth' ? 'ethereum' : 'bitcoin'
  const isNew = !isAllowlisted(destinations, chain, values.to)

  let plan
  if (command === 'eth') {
    if (!values.amount) throw new Error('--amount is required')
    const amount = parseEth(values.amount)
    const state = await ethState(ethAddress, fetchImpl)
    const maxFeeGwei = BigInt(values['max-fee-gwei'] ?? destinations.limits.maxFeeGwei)
    const tx = buildTransfer({ nonce: state.nonce, maxPriorityFeePerGas: state.maxPriorityFeePerGas, maxFeePerGas: state.maxFeePerGas, to: values.to, value: amount })
    const problems = checkWithdrawal({ chain, destination: values.to, ownAddress: ethAddress, amount, cap: parseEth(String(destinations.limits.maxEth)), allowlist: destinations, allowNewDestination: values['new-destination'], balance: state.balance, needs: maxCost(tx), feeOk: state.maxFeePerGas <= maxFeeGwei * 1_000_000_000n })
    out(`Send ${formatEth(amount)} ETH\n  from   ${ethAddress}\n  to     ${values.to}${isNew ? '   (NOT on your allowlist)' : ''}\n  fee    up to ${formatEth(tx.gasLimit * tx.maxFeePerGas)} ETH (max ${state.maxFeePerGas / 1_000_000_000n} gwei per gas, 21000 gas)\n  total  up to ${formatEth(maxCost(tx))} ETH of ${formatEth(state.balance)} ETH   nonce ${state.nonce}`)
    if (problems.length) { for (const p of problems) out(`STOP: ${p}`); return 2 }
    plan = { summary: `${formatEth(amount)} ETH`, build: async () => { const s = await signTransfer(tx, sign, pub); return { id: s.hash, raw: s.raw } }, broadcast: (raw) => ethBroadcast(raw, fetchImpl), explorer: (id) => `https://etherscan.io/tx/${id}` }
  } else {
    if (!values.amount === !values.sweep) throw new Error('give exactly one of --amount or --sweep')
    const coins = await btcCoins(btcAddress, fetchImpl)
    const rates = await btcFeeRates(fetchImpl)
    const feeRate = values['fee-rate'] ? Number(values['fee-rate']) : rates.normal
    const amountSats = values.sweep ? null : parseBtc(values.amount)
    const balance = coins.reduce((n, c) => n + c.value, 0n)
    let p
    try { p = planPayment({ utxos: coins, pub, destination: values.to, amountSats, feeRate }) } catch (e) { out(`STOP: ${e.message}`); return 2 }
    const sent = p.outputs[0].value
    const problems = checkWithdrawal({ chain, destination: values.to, ownAddress: btcAddress, amount: sent, cap: parseBtc(String(destinations.limits.maxBtc)), allowlist: destinations, allowNewDestination: values['new-destination'], balance, needs: sent + p.fee, feeOk: feeRate <= Number(destinations.limits.maxFeeRateSatPerVb) })
    out(`Send ${formatBtc(sent)} BTC${values.sweep ? ' (everything, minus the fee)' : ''}\n  from   ${btcAddress}\n  to     ${values.to}${isNew ? '   (NOT on your allowlist)' : ''}\n  fee    ${p.fee} sats at ${feeRate} sat/vB (about ${p.vsize} vB, ${p.inputs.length} coin(s)); suggested rates now: slow ${rates.slow}, normal ${rates.normal}, fast ${rates.fast}\n  change ${p.outputs.length > 1 ? formatBtc(p.outputs[1].value) + ' BTC back to the wallet' : 'none'}`)
    if (problems.length) { for (const q of problems) out(`STOP: ${q}`); return 2 }
    plan = { summary: `${formatBtc(sent)} BTC`, build: async () => { const t = await signPayment(p, sign, pub); return { id: t.txid, raw: t.hex } }, broadcast: (raw) => btcBroadcast(raw, fetchImpl), explorer: (id) => `https://mempool.space/tx/${id}` }
  }

  if (!values.sign && !values.broadcast) { out('\nDry run only: nothing was signed or sent. Add --sign to sign, or --broadcast to sign and send.'); return 0 }
  if (values.broadcast && !isTTY) { out('STOP: sending needs a real terminal where you can type the confirmation.'); return 2 }
  if (values.broadcast) {
    const typedAddress = await ask(`\nType ${isNew ? 'the WHOLE destination address' : 'the last 8 characters of the destination'} to continue: `)
    const typedWord = await ask(`Type SEND to send ${plan.summary} to ${values.to} (this cannot be undone): `)
    if (!confirmed(typedAddress, typedWord, values.to, isNew)) { out('Not confirmed. Nothing was signed or sent.'); log({ action: 'cancelled', chain, to: values.to, amount: plan.summary }); return 3 }
  }
  const built = await plan.build()
  log({ action: 'signed', chain, to: values.to, amount: plan.summary, id: built.id })
  if (!values.broadcast) { out(`\nSigned (not sent). Id: ${built.id}\nRaw transaction:\n${built.raw}`); return 0 }
  const sentId = await plan.broadcast(built.raw)
  log({ action: 'broadcast', chain, to: values.to, amount: plan.summary, id: sentId || built.id })
  out(`\nSent. Id: ${sentId || built.id}\n${plan.explorer(sentId || built.id)}`)
  return 0
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main(process.argv.slice(2), { expect: undefined }).then((c) => process.exit(c)).catch((e) => { console.error('STOPPED: ' + e.message); process.exit(1) })
}
