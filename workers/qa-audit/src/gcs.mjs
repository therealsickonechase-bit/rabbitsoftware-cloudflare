// Upload one object to Cloud Storage using the identity of the Cloud Run job that runs this code (the metadata server gives a short-lived token).
// No libraries, no keys. Only used when REPORT_BUCKET is set.
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

export async function accessToken(fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`metadata token ${res.status}`)
  return (await res.json()).access_token
}

/** Object names are checked so a bad name can never write outside the intended report layout. */
export function validName(name) {
  return typeof name === 'string' && /^(?:\d{4}\/\d{2}\/\d{2}\/)?[a-z0-9._-]{1,60}$/i.test(name) && !name.includes('..')
}

export async function uploadObject({ bucket, name, body, contentType, fetchImpl = fetch, token }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket)) throw new Error('bad bucket name')
  if (!validName(name)) throw new Error('bad object name')
  const auth = token ?? await accessToken(fetchImpl)
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`
  const res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': contentType }, body, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`upload ${name}: HTTP ${res.status}`)
  return true
}
