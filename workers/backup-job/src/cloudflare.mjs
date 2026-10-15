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
    let body
    try { body = await exportD1Polling(cf, account, db, { sleep, maxPolls }) }
    catch (e) {
      // Cloudflare's export needs write permission. A read-only token can still read the data with ordinary queries, so build the same kind of SQL file from those.
      if (!/HTTP (401|403)\b/.test(String(e.message))) throw e
      body = await dumpD1ByQuery(cf, account, db)
    }
    files.push({ name: `${db.name}.sql`, body })
  }
  return files
}

async function exportD1Polling(cf, account, db, { sleep, maxPolls }) {
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
  return Buffer.from(await dl.arrayBuffer())
}

/** One SQL literal. Strings are single-quoted with quotes doubled; byte arrays become X'..' blobs; nothing is ever evaluated. */
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return `X'${Buffer.from(v).toString('hex')}'`
  return `'${String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/'/g, "''")}'`
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`

/** Schema + rows of a D1 database, read with SELECT only (works with a read-only token). Large tables are read in pages of 1000 rows. */
export async function dumpD1ByQuery(cf, account, db, { pageSize = 1000, maxRows = 2_000_000 } = {}) {
  const query = async (sql) => {
    const r = await cf.call(`/accounts/${account}/d1/database/${db.uuid}/query`, { method: 'POST', body: { sql, params: [] } })
    return r.result?.[0]?.results ?? []
  }
  const objects = await query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name")
  const out = [`-- ${db.name}: schema and rows read with SELECT queries (read-only backup).`, 'PRAGMA defer_foreign_keys=TRUE;']
  for (const o of objects.filter((x) => x.type === 'table')) out.push(`${o.sql};`)
  for (const o of objects.filter((x) => x.type === 'table')) {
    let offset = 0
    for (;;) {
      let rows
      try { rows = await query(`SELECT * FROM ${quoteIdent(o.name)} ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`) }
      catch (e) {
        // WITHOUT ROWID tables have no rowid: read them whole, once.
        if (offset > 0 || !/HTTP (400|500)\b/.test(String(e.message))) throw e
        rows = await query(`SELECT * FROM ${quoteIdent(o.name)}`)
        for (const row of rows) { const cols = Object.keys(row); out.push(`INSERT INTO ${quoteIdent(o.name)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`) }
        break
      }
      for (const row of rows) {
        const cols = Object.keys(row)
        out.push(`INSERT INTO ${quoteIdent(o.name)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(', ')});`)
      }
      offset += rows.length
      if (rows.length < pageSize) break
      if (offset >= maxRows) throw new Error(`${db.name}.${o.name} is larger than ${maxRows} rows`)
    }
  }
  for (const o of objects.filter((x) => x.type !== 'table')) out.push(`${o.sql};`)
  return Buffer.from(out.join('\n') + '\n')
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
