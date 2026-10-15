import assert from 'node:assert/strict'
import test from 'node:test'
import { client, dumpD1ByQuery, exportD1, sqlLiteral } from '../src/cloudflare.mjs'

const json = (b, status = 200) => new Response(JSON.stringify(b), { status })

test('sqlLiteral quotes strings, keeps numbers, writes NULL and blobs, never evaluates anything', () => {
  assert.equal(sqlLiteral(null), 'NULL')
  assert.equal(sqlLiteral(7), '7')
  assert.equal(sqlLiteral(Infinity), 'NULL')
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'")
  assert.equal(sqlLiteral("x'); DROP TABLE t;--"), "'x''); DROP TABLE t;--'")
  assert.equal(sqlLiteral([1, 255]), "X'01ff'")
  assert.equal(sqlLiteral({ a: 1 }), `'{"a":1}'`)
})

function d1Fake({ exportStatus = 401, rows = {}, withoutRowid = [] } = {}) {
  const seen = []
  const f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    seen.push({ url, sql: body?.sql })
    if (url.includes('/d1/database?')) return json({ result: [{ uuid: 'u1', name: 'main' }] })
    if (url.endsWith('/export')) return json({}, exportStatus)
    if (url.endsWith('/query')) {
      const sql = body.sql
      if (sql.includes('sqlite_master')) return json({ result: [{ results: [
        { type: 'table', name: 'notes', tbl_name: 'notes', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)' },
        { type: 'index', name: 'notes_body', tbl_name: 'notes', sql: 'CREATE INDEX notes_body ON notes (body)' },
      ] }] })
      const m = /FROM "(\w+)"(?: ORDER BY rowid LIMIT (\d+) OFFSET (\d+))?/.exec(sql)
      if (m[2] && withoutRowid.includes(m[1])) return json({}, 400)
      const all = rows[m[1]] ?? []
      const page = m[2] ? all.slice(Number(m[3]), Number(m[3]) + Number(m[2])) : all
      return json({ result: [{ results: page }] })
    }
    throw new Error('unexpected ' + url)
  }
  f.seen = seen
  return f
}

test('a read-only token falls back to a SELECT-only dump when the export is refused (401)', async () => {
  const f = d1Fake({ rows: { notes: [{ id: 1, body: "it's fine" }, { id: 2, body: null }] } })
  const files = await exportD1(client({ token: 't', fetchImpl: f }), 'acct', { sleep: async () => {} })
  const sql = files[0].body.toString()
  assert.equal(files[0].name, 'main.sql')
  assert.match(sql, /CREATE TABLE notes/)
  assert.match(sql, /INSERT INTO "notes" \("id", "body"\) VALUES \(1, 'it''s fine'\);/)
  assert.match(sql, /VALUES \(2, NULL\);/)
  assert.ok(sql.indexOf('CREATE INDEX') > sql.indexOf('INSERT INTO'), 'indexes come after the data')
  assert.ok(f.seen.filter((s) => s.sql).every((s) => /^SELECT /.test(s.sql)), 'only SELECT statements were sent')
})

test('other errors from the export are not swallowed by the fallback', async () => {
  await assert.rejects(exportD1(client({ token: 't', fetchImpl: d1Fake({ exportStatus: 500 }) }), 'acct', { sleep: async () => {} }), /HTTP 500/)
})

test('large tables are read in pages and WITHOUT ROWID tables are read whole', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: i, body: 'b' + i }))
  const paged = await dumpD1ByQuery(client({ token: 't', fetchImpl: d1Fake({ rows: { notes: many } }) }), 'acct', { uuid: 'u1', name: 'main' })
  assert.equal((paged.toString().match(/INSERT INTO/g) || []).length, 2500)
  const whole = await dumpD1ByQuery(client({ token: 't', fetchImpl: d1Fake({ rows: { notes: many.slice(0, 5) }, withoutRowid: ['notes'] }) }), 'acct', { uuid: 'u1', name: 'main' })
  assert.equal((whole.toString().match(/INSERT INTO/g) || []).length, 5)
})

test('a table that is too large stops the dump instead of filling memory', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i }))
  await assert.rejects(dumpD1ByQuery(client({ token: 't', fetchImpl: d1Fake({ rows: { notes: many } }) }), 'acct', { uuid: 'u1', name: 'main' }, { pageSize: 10, maxRows: 20 }), /larger than 20 rows/)
})
