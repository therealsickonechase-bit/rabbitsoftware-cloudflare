import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'
import { accountId, client, exportD1, exportKv, exportR2 } from '../src/cloudflare.mjs'
import { normalizeDbUrl, objectName, projectRef, scrub, today } from '../src/plan.mjs'
import { runBackup } from '../src/run.mjs'

const json = (b, status = 200) => new Response(JSON.stringify(b), { status })

test('object names stay under platform-cloud/<date>/<part>/ and cannot climb out', () => {
  assert.equal(objectName('2026-10-15', 'supabase', 'supabase-2026-10-15.dump'), 'platform-cloud/2026-10-15/supabase/supabase-2026-10-15.dump')
  const sneaky = objectName('2026-10-15', 'cloudflare-kv', '../../etc/passwd')
  assert.ok(sneaky.startsWith('platform-cloud/2026-10-15/cloudflare-kv/') && !sneaky.includes('/..') && !sneaky.slice(40).includes('/'))
  for (const bad of [['x', 'a', 'b'], ['2026-10-15', 'A/B', 'f'], ['2026-10-15', '..', 'f'], ['2026-10-15', 'ok', '']]) assert.throws(() => objectName(...bad))
  assert.equal(today(new Date('2026-10-15T23:59:59Z')), '2026-10-15')
})

test('the Supabase pooler string gets the project user and SSL; nothing else changes', () => {
  assert.equal(projectRef('https://abcdef123.supabase.co'), 'abcdef123')
  assert.equal(normalizeDbUrl('postgresql://postgres:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres', 'abcdef123'), 'postgresql://postgres.abcdef123:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require')
  assert.equal(normalizeDbUrl('postgresql://u:p@db.example.com/x?sslmode=disable', 'r'), 'postgresql://u:p@db.example.com/x?sslmode=disable')
})

test('scrub hides connection strings, bearer tokens and long token-like strings', () => {
  const s = scrub('failed postgres://postgres:hunter2@host:5432/db Bearer abc.def-ghi key=' + 'A'.repeat(48))
  assert.ok(!/hunter2|abc\.def|AAAAAAAAAA/.test(s))
})

test('D1 export polls until Cloudflare has the copy, then downloads it', async () => {
  let polls = 0
  const f = async (url) => {
    if (url.includes('/d1/database?')) return json({ result: [{ uuid: 'u1', name: 'main' }] })
    if (url.endsWith('/d1/database/u1/export')) { polls++; return json({ result: polls < 3 ? { status: 'active', at_bookmark: 'bm' } : { status: 'complete', result: { signed_url: 'https://signed.example/x' } } }) }
    if (url === 'https://signed.example/x') return new Response('CREATE TABLE t;')
    throw new Error('unexpected ' + url)
  }
  const files = await exportD1(client({ token: 't', fetchImpl: f }), 'acct', { sleep: async () => {} })
  assert.equal(polls, 3)
  assert.equal(files[0].name, 'main.sql')
  assert.equal(files[0].body.toString(), 'CREATE TABLE t;')
})

test('KV export pages through keys and keeps values', async () => {
  const f = async (url) => {
    if (url.includes('/kv/namespaces?')) return json({ result: [{ id: 'n1', title: 'DNA CHAIN' }] })
    if (url.includes('/keys?limit=1000&cursor=c2')) return json({ result: [{ name: 'b' }], result_info: {} })
    if (url.includes('/keys?')) return json({ result: [{ name: 'a' }], result_info: { cursor: 'c2' } })
    if (url.includes('/values/a')) return new Response('va')
    if (url.includes('/values/b')) return new Response('vb')
    throw new Error('unexpected ' + url)
  }
  const r = await exportKv(client({ token: 't', fetchImpl: f }), 'acct')
  assert.equal(r.keys, 2)
  assert.deepEqual(r.files.map((x) => x.name), ['DNA_CHAIN/_keys.json', 'DNA_CHAIN/0001.value', 'DNA_CHAIN/0002.value'])
})

test('R2 export lists buckets and yields each object', async () => {
  const f = async (url) => {
    if (url.endsWith('/r2/buckets')) return json({ result: { buckets: [{ name: 'chain' }] } })
    if (url.includes('/objects?')) return json({ result: [{ key: 'a/b.json' }], result_info: {} })
    if (url.includes('/objects/a%2Fb.json')) return new Response('{}')
    throw new Error('unexpected ' + url)
  }
  const names = []
  for await (const o of exportR2(client({ token: 't', fetchImpl: f }), 'acct')) names.push(o.name)
  assert.deepEqual(names, ['chain/a/b.json'])
  assert.equal(await accountId(client({ token: 't', fetchImpl: async () => json({ result: [{ id: 'x' }] }) })), 'x')
})

test('the job uploads each part, survives one failing part, and never logs a secret', async () => {
  const uploaded = []
  const logs = []
  const orig = console.log
  console.log = (l) => logs.push(l)
  const f = async (url) => {
    if (url.startsWith('http://metadata.google.internal')) return json({ access_token: 'tok' })
    if (url.startsWith('https://storage.googleapis.com/upload')) { uploaded.push(decodeURIComponent(/name=([^&]+)/.exec(url)[1])); return json({}) }
    if (url.endsWith('/accounts')) return json({ result: [{ id: 'acct' }] })
    if (url.includes('/d1/database?')) return json({ result: [] })
    if (url.includes('/kv/namespaces?')) return json({ result: [] })
    if (url.endsWith('/r2/buckets')) return json({ result: { buckets: [] } })
    throw new Error('unexpected ' + url)
  }
  const dump = async (_url, file) => { await writeFile(file, 'DUMP') }
  let manifest
  try {
    manifest = await runBackup({ env: { BACKUP_BUCKET: 'my-backups', SUPABASE_DB_URL: 'postgresql://postgres:SECRETPW@h.pooler.supabase.com:5432/postgres', NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co', CLOUDFLARE_API_TOKEN: 'CFTOKEN' }, now: new Date('2026-10-15T10:00:00Z'), fetchImpl: f, dump })
  } finally { console.log = orig }
  assert.equal(manifest.ok, true)
  assert.ok(uploaded.includes('platform-cloud/2026-10-15/supabase/supabase-2026-10-15.dump'))
  assert.ok(uploaded.includes('platform-cloud/2026-10-15/manifest/manifest.json'))
  assert.ok(!logs.join('\n').includes('SECRETPW') && !logs.join('\n').includes('CFTOKEN'))

  console.log = () => {}
  let broken
  try {
    broken = await runBackup({ env: { BACKUP_BUCKET: 'my-backups', SUPABASE_DB_URL: 'postgresql://postgres:SECRETPW@h/x' }, now: new Date('2026-10-15T10:00:00Z'), fetchImpl: f, dump: async () => { throw new Error('pg_dump exit 1 for postgres://postgres:SECRETPW@h/x') } })
  } finally { console.log = orig }
  assert.equal(broken.ok, false)
  assert.ok(!JSON.stringify(broken).includes('SECRETPW'))
  assert.ok(broken.parts.some((p) => p.part === 'cloudflare' && /skipped/.test(p.detail)))
})
