// Uploads one object to Cloud Storage with the identity of the Cloud Run job (the metadata server gives a short-lived token). No libraries, no keys.
import { PREFIX } from './plan.mjs'

const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

export async function accessToken(fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`metadata token ${res.status}`)
  return (await res.json()).access_token
}

export async function upload({ bucket, name, body, token, fetchImpl = fetch }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket)) throw new Error('bad bucket name')
  if (!name.startsWith(`${PREFIX}/`) || name.includes('..') || name.length > 400) throw new Error('bad object name')
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`
  const res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`upload ${name}: HTTP ${res.status}`)
  return true
}
