// Talks to Cloud KMS over REST. The private key never leaves the HSM; this code can only ask it to SIGN a 32-byte digest and read the PUBLIC key.
import { execFileSync } from 'node:child_process'

export const KEY_VERSION = 'projects/rabbitsoftware-io/locations/us-west2/keyRings/rabbit-wallet/cryptoKeys/maxwell-donations/cryptoKeyVersions/1'

/** Your own gcloud sign-in (this runs on your PC) or, inside Google Cloud, the metadata server. Never logged. */
export function gcloudToken() {
  return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
}

async function call(path, body, { tokenFn = gcloudToken, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://cloudkms.googleapis.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${tokenFn()}`, 'Content-Type': 'application/json', 'x-goog-user-project': 'rabbitsoftware-io' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Cloud KMS ${path.split(':').pop()} -> HTTP ${res.status}`)
  return res.json()
}

/** The public key as PEM, straight from KMS. `opts.keyVersion` selects another key (the anchoring key); the default is the donation wallet key. */
export async function getPublicKeyPem(opts) {
  const r = await call(`${opts?.keyVersion ?? KEY_VERSION}/publicKey`, null, opts)
  if (r.algorithm !== 'EC_SIGN_SECP256K1_SHA256') throw new Error(`unexpected key algorithm ${r.algorithm}`)
  return r.pem
}

/** Signs a 32-byte digest. Returns the DER signature bytes. */
export async function signDigest(digest, opts) {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) throw new Error('digest must be exactly 32 bytes')
  const r = await call(`${opts?.keyVersion ?? KEY_VERSION}:asymmetricSign`, { digest: { sha256: digest.toString('base64') } }, opts)
  return Buffer.from(r.signature, 'base64')
}
