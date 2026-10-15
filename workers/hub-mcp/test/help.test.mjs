import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { makeCatalog } from '../src/catalog.mjs'
import { handleRpc } from '../src/hub.mjs'
import { BASIC_TOOLS, HELP_TOPICS, SERVICES, helpFor } from '../src/help.mjs'

const data = JSON.parse(await readFile(new URL('../data/commands.json', import.meta.url), 'utf8'))
const catalog = makeCatalog(data)
const call = (args) => handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hub_help', arguments: args } }, { catalog, now: () => 1_800_000_000_000 })
const body = (out) => JSON.parse(out.result.content[0].text)

test('every command id a service names exists in the catalog', () => {
  for (const s of SERVICES) {
    for (const id of s.check) assert.ok(catalog.get('guest', id), `${s.id}: check command ${id} must be a guest command`)
    for (const id of s.fix) assert.ok(catalog.get('owner', id), `${s.id}: fix command ${id} missing`)
  }
})

test('service entries are complete and addresses are https', () => {
  assert.equal(new Set(SERVICES.map((s) => s.id)).size, SERVICES.length)
  for (const s of SERVICES) {
    for (const k of ['id', 'name', 'where', 'about', 'note']) assert.ok(typeof s[k] === 'string' && s[k].length > 0, `${s.id}.${k}`)
    if (s.url) assert.match(s.url, /^https:\/\//)
  }
})

test('every topic answers, for both roles that make sense, and unknown topics are refused', async () => {
  for (const topic of HELP_TOPICS) {
    const out = body(await call({ topic }))
    assert.equal(out.topic, topic)
  }
  assert.equal((await call({ topic: 'nope' })).result.isError, true)
  assert.equal((await call({ topic: 'overview', extra: 1 })).result.isError, true)
  assert.equal(body(await call({})).topic, 'overview')
})

test('guests never see owner commands in help; the owner role needs a key', async () => {
  const guest = helpFor('services', catalog, 'guest')
  assert.ok(!JSON.stringify(guest).includes('Setup-Gcp'))
  const owner = helpFor('services', catalog, 'owner')
  assert.ok(JSON.stringify(owner).includes('Setup-GcpHub.ps1'))
  const denied = await call({ topic: 'services', role: 'owner' })
  assert.equal(denied.result.isError, true)
})

test('the help text keeps personal data and secrets out', () => {
  const all = JSON.stringify(HELP_TOPICS.map((t) => helpFor(t, catalog, 'owner')))
  assert.ok(!/sk-[A-Za-z0-9_-]{16,}|hub_[A-Za-z0-9_-]{32,}/.test(all))
  assert.ok(BASIC_TOOLS.everywhere.length >= 3)
})

test('the catalog carries the new platform commands for each role', () => {
  for (const id of ['hub-help', 'hub-status', 'hub-research-pubmed', 'web-chain-head']) assert.ok(catalog.get('guest', id), id)
  for (const id of ['gcp-hub-run', 'gcp-qa-run', 'gcp-status-run', 'hub-key-new', 'cf-test-hub']) assert.equal(catalog.get('guest', id), null, `${id} must not be a guest command`)
  for (const id of ['gcp-hub-run', 'gcp-qa-run', 'gcp-status-run', 'hub-key-new', 'cf-test-hub']) assert.ok(catalog.get('owner', id), id)
})
