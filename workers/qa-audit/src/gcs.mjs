// Upload one object to Cloud Storage using the identity of the Cloud Run job that runs this code (the metadata server gives a short-lived token).
// No libraries, no keys. Only used when a bucket is configured.
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

export async function accessToken(fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`metadata token ${res.status}`)
  return (await res.json()).access_token
}

/** Object names are checked so a bad name can never write outside the intended layout: either a dated report (2026/10/15/report.html) or a status object (status/latest.json). */
export function validName(name) {
  return typeof name === 'string' && /^(?:\d{4}\/\d{2}\/\d{2}\/|status\/)?[a-z0-9._-]{1,60}$/i.test(name) && !name.includes('..')
}

/**
 * Uploads `body`. With `cacheControl` the object is sent as multipart (metadata + content) so browsers re-check it; without it, a plain media upload.
 */
export async function uploadObject({ bucket, name, body, contentType, cacheControl, fetchImpl = fetch, token }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket)) throw new Error('bad bucket name')
  if (!validName(name)) throw new Error('bad object name')
  const auth = token ?? await accessToken(fetchImpl)
  let url, headers, payload
  if (cacheControl) {
    const boundary = `rabbit${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart`
    headers = { Authorization: `Bearer ${auth}`, 'Content-Type': `multipart/related; boundary=${boundary}` }
    payload = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, contentType, cacheControl })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${body}\r\n--${boundary}--`
  } else {
    url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`
    headers = { Authorization: `Bearer ${auth}`, 'Content-Type': contentType }
    payload = body
  }
  const res = await fetchImpl(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`upload ${name}: HTTP ${res.status}`)
  return true
}
