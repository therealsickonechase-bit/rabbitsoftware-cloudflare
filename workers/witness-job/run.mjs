// The cloud witness: a Cloud Run job that independently checks the PUBLIC Maxwell chain and signs the head it verified.
// It is a separate peer from the owner's PC witness: its own Ed25519 key (kept only in Secret Manager), its own machine, its own run times.
// It reads only the public chain, remembers the last head it signed, and refuses a chain that does not verify, is shorter than before, or has a different history at a position
// it already signed (logged as an ERROR, exit 3, so an alert can fire). It writes two small public files under witness/<name>/ in the public ledger bucket and nothing else.
// See docs/peer-review.md.   Exit codes: 0 signed, 2 refused (chain does not verify / shorter), 3 conflict, 1 could not read or write something.
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { CHAIN_URL, cosign, parseChainText, witnessStep } from './witness.mjs'

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/

/** deps: { name, pem, readObject(path)->string|null, writeObject(path, string), fetchChainText()->string, now, log } */
export async function runWitness({ name, pem, readObject, writeObject, fetchChainText, now = new Date(), log = () => {} }) {
  if (!NAME_RE.test(name)) throw new Error('bad witness name')
  const publicKey = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).toString('base64')
  const base = `witness/${name}`
  let state = null
  try { const raw = await readObject(`${base}/state.json`); state = raw ? JSON.parse(raw) : null } catch { throw new Error('could not read this witness\'s state') }
  let text
  try { text = await fetchChainText() } catch { log('witness_failed', { reason: 'could not read the public chain' }); return 1 }
  let chain
  try { chain = parseChainText(text) } catch { log('witness_failed', { reason: 'the public chain is not valid JSON' }); return 2 }
  const step = witnessStep({ chain, state })
  if (!step.sign) {
    log(step.conflict ? 'witness_conflict' : 'witness_refused', { reason: step.reason, problems: (step.problems ?? []).slice(0, 5) })
    return step.conflict ? 3 : 2
  }
  const c = cosign({ name, checkpoint: step.checkpoint, privateKeyPem: pem, publicKey, now })
  await writeObject(`${base}/cosignature.json`, JSON.stringify(c, null, 2) + '\n')
  await writeObject(`${base}/state.json`, JSON.stringify(step.state) + '\n')
  log('witness_signed', { name, size: c.size, head: c.hash.slice(0, 16), keyId: c.keyId })
  return 0
}

async function main() {
  const name = process.env.WITNESS_NAME || 'cloud-witness'
  const pem = process.env.WITNESS_KEY_PEM
  const bucket = process.env.LEDGER_BUCKET || 'rabbitsoftware-io-ledger-public'
  if (!pem || !/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket)) throw new Error('missing key or bad bucket')
  const meta = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } })
  const token = (await meta.json()).access_token
  const safe = (p) => { if (!p.startsWith(`witness/${name}/`) || p.includes('..') || p.length > 120) throw new Error('objects may only be read or written under witness/<name>/'); return p }
  const readObject = async (p) => {
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(safe(p))}?alt=media`, { headers: { Authorization: `Bearer ${token}` } })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`bucket read ${r.status}`)
    return r.text()
  }
  const writeObject = async (p, body) => {
    const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(safe(p))}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body })
    if (!r.ok) throw new Error(`bucket write ${r.status}`)
  }
  const fetchChainText = async () => {
    const r = await fetch(`${CHAIN_URL}?cb=${Date.now()}`, { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`chain ${r.status}`)
    return r.text()
  }
  const log = (event, fields) => console.log(JSON.stringify({ severity: /conflict|failed|refused/.test(event) ? 'ERROR' : 'INFO', event, ...fields }))
  return runWitness({ name, pem, readObject, writeObject, fetchChainText, log })
}

if (process.env.CLOUD_RUN_JOB) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(JSON.stringify({ severity: 'ERROR', event: 'witness_failed', reason: String(e.message).slice(0, 160) })); process.exit(1) })
}
