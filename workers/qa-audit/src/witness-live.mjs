// status/witness.json for rabbitsoftware.io: who has independently checked the Maxwell chain, and do enough of them agree on its current head?
// The status job reads the public registry of witnesses (site/witness/registry.json, edited through the public repository), fetches each witness's published cosignature,
// verifies every signature itself, checks each signed head against the chain it just downloaded, and writes the result. See docs/peer-review.md.
// Everything here is public. A witness that cannot be reached shows as "missing", never as a failure of the chain.
import { DEFAULT_POLICY, evaluate, parseChainText } from './witness.mjs'

const REGISTRY_URL = 'https://rabbitsoftware.io/witness/registry.json'
const CHAIN_URL = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json'
export const MAX_WITNESSES = 25

async function getText(fetchImpl, url, timeoutMs, maxBytes) {
  if (!/^https:\/\//.test(url)) throw new Error('only https addresses are read')
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'rabbitos-status/1.0 (+https://rabbitsoftware.io)' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > maxBytes) throw new Error('too large')
  return text
}

/** Returns the object to publish, or null when the registry or the chain cannot be read (the previous file then stays). */
export async function buildWitnessLive({ fetchImpl = fetch, now = new Date(), registryUrl = REGISTRY_URL, chainUrl = CHAIN_URL, timeoutMs = 12_000 } = {}) {
  let registry, chain
  try { registry = JSON.parse(await getText(fetchImpl, registryUrl, timeoutMs, 200_000)) } catch { return null }
  if (!registry || !Array.isArray(registry.witnesses)) return null      // not a registry at all: keep the last good file rather than publish "0 witnesses"
  try { chain = parseChainText(await getText(fetchImpl, `${chainUrl}?cb=${Math.floor(now / 1000)}`, timeoutMs, 5_000_000)) } catch { return null }
  const witnesses = (Array.isArray(registry?.witnesses) ? registry.witnesses : []).filter((w) => w && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(w.name)) && typeof w.publicKey === 'string' && typeof w.url === 'string').slice(0, MAX_WITNESSES)
  const cosigs = {}
  await Promise.all(witnesses.map(async (w) => {
    try { cosigs[w.name] = JSON.parse(await getText(fetchImpl, w.url, timeoutMs, 20_000)) } catch { cosigs[w.name] = null }
  }))
  const k = Number.isInteger(registry.k) && registry.k >= 1 && registry.k <= 10 ? registry.k : DEFAULT_POLICY.k
  const r = evaluate({ registry: { witnesses }, cosigs, chain, now, policy: { ...DEFAULT_POLICY, k } })
  return {
    version: 1, generatedAt: now.toISOString(), origin: 'rabbitsoftware.io/maxwell',
    head: r.head, chainOk: r.chainOk, rule: { k: r.policy.k, n: r.policy.n, maxAgeHours: r.policy.maxAgeHours },
    agreeing: r.agreeing, conflicts: r.conflicts, trusted: r.trusted, summary: r.summary,
    witnesses: r.rows.map((row, i) => ({ name: row.name, kind: row.kind === 'project' ? 'project' : 'external', keyId: row.keyId, status: row.status, size: row.size, signedAt: row.signedAt, note: String(witnesses[i]?.note ?? '').slice(0, 160) })),
  }
}
