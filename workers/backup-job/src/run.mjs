// Cloud copy of the platform backup, run as a Cloud Run job: Supabase (pg_dump) and Cloudflare (D1, KV, R2) into the private bucket.
// It writes under platform-cloud/<date>/ and never touches the local backup's platform/<date>/. Each part is independent; the job exits 1 if any failed.
// Secrets arrive as environment variables from Secret Manager: SUPABASE_DB_URL, CLOUDFLARE_API_TOKEN. Neither is ever logged.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountId, client, exportD1, exportKv, exportR2 } from './cloudflare.mjs'
import { accessToken, upload } from './gcs.mjs'
import { MAX_OBJECT_BYTES, normalizeDbUrl, objectName, projectRef, runId, scrub, today } from './plan.mjs'

// One JSON line per event. A failed part or run carries severity ERROR so Cloud Logging and the existing alerts see it.
const log = (event, fields = {}) => console.log(JSON.stringify({ severity: fields.ok === false || event === 'backup_failed' ? 'ERROR' : 'INFO', event, ...fields }))

function pgDump(url, file) {
  return new Promise((resolve, reject) => {
    const p = spawn('pg_dump', [url, '--format=custom', '--no-owner', '--no-privileges', '-n', 'public', '-n', 'auth', '-n', 'storage', '-f', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000) })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exit ${code}: ${scrub(err).split('\n').slice(-3).join(' | ')}`))))
  })
}

export async function runBackup({ env = process.env, now = new Date(), fetchImpl = fetch, dump = pgDump } = {}) {
  const bucket = env.BACKUP_BUCKET
  if (!bucket) throw new Error('BACKUP_BUCKET is not set')
  const date = today(now)
  const run = runId(now)
  const token = await accessToken(fetchImpl)
  const results = []
  const put = (part, file, body) => {
    if (body.length > MAX_OBJECT_BYTES) throw new Error(`${file} is larger than ${MAX_OBJECT_BYTES} bytes`)
    return upload({ bucket, name: objectName(date, run, part, file), body, token, fetchImpl })
  }
  const part = async (name, work) => {
    const t0 = Date.now()
    try { const detail = await work(); results.push({ part: name, ok: true, detail, seconds: Math.round((Date.now() - t0) / 1000) }) }
    catch (e) { results.push({ part: name, ok: false, detail: scrub(e.message), seconds: Math.round((Date.now() - t0) / 1000) }) }
    log('backup_part', results.at(-1))
  }

  await part('supabase', async () => {
    if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is not set')
    const dir = await mkdtemp(join(tmpdir(), 'pg-'))
    try {
      const file = join(dir, `supabase-${date}.dump`)
      await dump(normalizeDbUrl(env.SUPABASE_DB_URL, projectRef(env.NEXT_PUBLIC_SUPABASE_URL)), file)
      const size = (await stat(file)).size
      await put('supabase', `supabase-${date}.dump`, await readFile(file))
      return `${(size / 1048576).toFixed(1)} MB`
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  if (!env.CLOUDFLARE_API_TOKEN) { results.push({ part: 'cloudflare', ok: true, skipped: true, detail: 'skipped: CLOUDFLARE_API_TOKEN is not set', seconds: 0 }); log('backup_part', results.at(-1)) }
  else {
    const cf = client({ token: env.CLOUDFLARE_API_TOKEN, fetchImpl })
    let account
    try { account = await accountId(cf) } catch (e) { results.push({ part: 'cloudflare', ok: false, detail: scrub(e.message), seconds: 0 }) }
    if (account) {
      await part('cloudflare-d1', async () => { const files = await exportD1(cf, account); for (const f of files) await put('cloudflare-d1', f.name, f.body); return `${files.length} databases` })
      await part('cloudflare-kv', async () => { const r = await exportKv(cf, account); for (const f of r.files) await put('cloudflare-kv', f.name, f.body); return `${r.namespaces} namespaces, ${r.keys} keys` })
      await part('cloudflare-r2', async () => { let n = 0; for await (const f of exportR2(cf, account)) { await put('cloudflare-r2', f.name, f.body); n++ } return `${n} objects` })
    }
  }

  const manifest = { date, run, generatedAt: now.toISOString(), ok: results.every((r) => r.ok), skipped: results.filter((r) => r.skipped).map((r) => r.part), parts: results }
  await put('manifest', 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 1)))
  log('backup_report', { date, run, ok: manifest.ok, parts: results.map((r) => `${r.part}:${r.skipped ? 'skipped' : r.ok ? 'ok' : 'FAIL'}`) })
  return manifest
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('run.mjs')) {
  runBackup().then((m) => process.exit(m.ok ? 0 : 1)).catch((e) => { log('backup_failed', { reason: scrub(e.message) }); process.exit(1) })
}
