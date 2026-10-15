// Reads D1, KV and R2 through the Cloudflare REST API with a read-only token. GET requests only, apart from the D1 export request,
// which asks Cloudflare to prepare a copy and changes nothing. `fetchImpl` is injected so this is tested without a network.

const API = 'https://api.cloudflare.com/client/v4'

export function client({ token, fetchImpl = fetch }) {
  if (!token) throw new Error('no Cloudflare token')
  const call = async (path, { method = 'GET', body, raw = false } = {}) => {
    const res = await fetchImpl(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`Cloudflare ${method} ${path.split('?')[0]} -> HTTP ${res.status}`)
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json()
  }
  return { call, fetchImpl }
}

export async function accountId(cf) {
  const r = await cf.call('/accounts')
  const id = r.result?.[0]?.id
  if (!id) throw new Error('the token sees no account')
  return id
}

/** Every D1 database as an SQL text file, using Cloudflare's polling export. */
export async function exportD1(cf, account, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPolls = 60 } = {}) {
  const list = (await cf.call(`/accounts/${account}/d1/database?per_page=100`)).result ?? []
  const files = []
  for (const db of list) {
    let bookmark
    let url = null
    for (let i = 0; i < maxPolls && !url; i++) {
      const r = await cf.call(`/accounts/${account}/d1/database/${db.uuid}/export`, { method: 'POST', body: { output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) } })
      const res = r.result ?? {}
      if (res.status === 'complete' && res.result?.signed_url) url = res.result.signed_url
      else if (res.status === 'error') throw new Error(`D1 export of ${db.name} failed`)
      else { bookmark = res.at_bookmark ?? bookmark; await sleep(2000) }
    }
    if (!url) throw new Error(`D1 export of ${db.name} did not finish`)
    const dl = await cf.fetchImpl(url, { signal: AbortSignal.timeout(120_000) })   // a short-lived signed address Cloudflare prepared
    if (!dl.ok) throw new Error(`D1 download of ${db.name} -> HTTP ${dl.status}`)
    files.push({ name: `${db.name}.sql`, body: Buffer.from(await dl.arrayBuffer()) })
  }
  return files
}

/** Every KV namespace: its key list and each value. */
export async function exportKv(cf, account) {
  const namespaces = (await cf.call(`/accounts/${account}/storage/kv/namespaces?per_page=100`)).result ?? []
  const parts = []
  let keysTotal = 0
  for (const ns of namespaces) {
    const keys = []
    let cursor = ''
    do {
      const r = await cf.call(`/accounts/${account}/storage/kv/namespaces/${ns.id}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      keys.push(...(r.result ?? []))
      cursor = r.result_info?.cursor ?? ''
    } while (cursor)
    const title = ns.title.replace(/[^A-Za-z0-9_-]/g, '_')
    const files = [{ name: `${title}/_keys.json`, body: Buffer.from(JSON.stringify(keys, null, 1)) }]
    let i = 0
    for (const k of keys) {
      i++; keysTotal++
      files.push({ name: `${title}/${String(i).padStart(4, '0')}.value`, body: await cf.call(`/accounts/${account}/storage/kv/namespaces/${ns.id}/values/${encodeURIComponent(k.name)}`, { raw: true }) })
    }
    parts.push(...files)
  }
  return { files: parts, namespaces: namespaces.length, keys: keysTotal }
}

/** Every R2 bucket's objects (listing and download through the API). Yields files one at a time so memory stays small. */
export async function* exportR2(cf, account) {
  const buckets = (await cf.call(`/accounts/${account}/r2/buckets`)).result?.buckets ?? []
  for (const b of buckets) {
    let cursor = ''
    do {
      const r = await cf.call(`/accounts/${account}/r2/buckets/${b.name}/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      for (const o of r.result ?? []) {
        yield { name: `${b.name}/${o.key}`, body: await cf.call(`/accounts/${account}/r2/buckets/${b.name}/objects/${encodeURIComponent(o.key)}`, { raw: true }) }
      }
      cursor = r.result_info?.cursor ?? ''
    } while (cursor)
  }
}
