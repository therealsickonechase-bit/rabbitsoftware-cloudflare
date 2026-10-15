// Safety rules around withdrawals. Pure functions plus two small file helpers. These decide whether a transaction may be SIGNED or BROADCAST;
// they cannot be switched off by a flag except the ones named in the messages.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_LIMITS = Object.freeze({ maxEth: '0.1', maxBtc: '0.01', maxFeeGwei: 200, maxFeeRateSatPerVb: 200 })
export const destinationsPath = () => process.env.WALLET_DESTINATIONS || join(homedir(), 'RabbitOS', 'wallet-destinations.json')
export const logPath = () => process.env.WALLET_LOG || join(homedir(), 'RabbitOS', 'logs', 'wallet-withdrawals.log')

/** The allowlist file lives outside the repository, on the owner's computer: { ethereum: [{address,label}], bitcoin: [...], limits: {maxEth,maxBtc,maxFeeGwei,maxFeeRateSatPerVb} } */
export function loadDestinations(path = destinationsPath()) {
  if (!existsSync(path)) return { ethereum: [], bitcoin: [], limits: { ...DEFAULT_LIMITS } }
  let j
  try { j = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error(`the destinations file is not valid JSON: ${path}`) }
  const list = (x) => (Array.isArray(x) ? x.filter((e) => e && typeof e.address === 'string').map((e) => ({ address: e.address.trim(), label: String(e.label ?? '') })) : [])
  return { ethereum: list(j.ethereum), bitcoin: list(j.bitcoin), limits: { ...DEFAULT_LIMITS, ...(j.limits || {}) } }
}

const same = (chain, a, b) => (chain === 'ethereum' ? a.toLowerCase() === b.toLowerCase() : a.toLowerCase() === b.toLowerCase())
export const isAllowlisted = (dest, chain, address) => dest[chain].some((e) => same(chain, e.address, address))

/** The checks every withdrawal passes before anything is signed. Returns a list of reasons it must stop (empty = fine). */
export function checkWithdrawal({ chain, destination, ownAddress, amount, cap, allowlist, allowNewDestination, balance, needs, feeOk }) {
  const problems = []
  if (same(chain, destination, ownAddress)) problems.push('the destination is the wallet itself')
  if (!isAllowlisted(allowlist, chain, destination) && !allowNewDestination) problems.push('the destination is not in your allowlist (add it to the destinations file, or use --new-destination and confirm it)')
  if (amount > cap) problems.push(`the amount is above your per-withdrawal limit (${cap}); raise "limits" in the destinations file if you really mean it`)
  if (needs > balance) problems.push('the wallet balance does not cover the amount plus the worst-case fee')
  if (feeOk === false) problems.push('the fee is above your safety limit')
  return problems
}

/** What the person must type to allow a broadcast. A new destination needs the whole address; a known one needs its last 8 characters. */
export function confirmationPhrase(destination, isNew) { return isNew ? destination : destination.slice(-8) }
export function confirmed(typedAddress, typedWord, destination, isNew) {
  return typedWord === 'SEND' && typedAddress.trim() === confirmationPhrase(destination, isNew)
}

/** One JSON line per action. Addresses, amounts and ids only; no keys, no signatures. */
export function logAction(entry, path = logPath()) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n')
}
