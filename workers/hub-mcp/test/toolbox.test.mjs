import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { makeCatalog } from '../src/catalog.mjs'
import { handleRpc } from '../src/hub.mjs'

const entries = [
  { id: 'pub-cmd', project: 'rabbit-web', group: 'Checks', label: 'A public command', scope: 'public', risk: 'local', command: 'npm run test:auth', description: 'd', runsIn: 'sandbox' },
  { id: 'own-cmd', project: 'research-agents', group: 'DNA', label: 'An owner command', scope: 'owner', risk: 'local', command: 'python dna_local.py compare', description: 'd', runsIn: 'computer' },
]
const toolbox = {
  version: 1, root: 'ab'.repeat(32), counts: { files: 709, commands: 2, commandsWithFiles: 2 },
  files: {
    'pub-cmd': [{ repo: 'rabbit-web', path: 'package.json', sha256: '1'.repeat(64) }, { repo: 'research-agents', path: 'task_worker.py', sha256: '2'.repeat(64) }],
    'own-cmd': [{ repo: 'research-agents', path: 'dna_local.py', sha256: '3'.repeat(64) }, { repo: 'rabbit-web', path: 'scripts/powershell/Run-DnaLocal.ps1', sha256: '4'.repeat(64) }],
  },
  agents: [{ id: 'task_worker', where: 'PC', tasks: [{ kind: 'research_topic', about: 'Search.', params: { topic: 'required' } }], actions: [{ id: 'skip_source', about: 'Skip.', target: 'pubmed' }], howToSend: 'python stage_box.py stage --to task_worker' },
    { id: 'research', where: 'PC', tasks: [], actions: [], howToSend: 'python stage_box.py stage --to research' }],
}
const catalog = makeCatalog({ entries, generatedAt: 'x' }, toolbox)
const offline = async () => { throw new Error('no network') }
const call = async (name, args, tier = 'public') => (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { fetchImpl: offline, now: () => 0, catalog, tier })).result
const body = (r) => JSON.parse(r.content[0].text)

test('a guest sees only links into the public repositories for a command, never private paths', async () => {
  const r = body(await call('command_get', { role: 'guest', id: 'pub-cmd' }))
  assert.deepEqual(r.files.map((f) => f.path), ['package.json'])
  assert.equal(r.files[0].url, 'https://github.com/therealsickonechase-bit/rabbit-web/blob/main/package.json')
  assert.equal(r.bundle, toolbox.root)
  assert.ok(!JSON.stringify(r).includes('task_worker.py') && !JSON.stringify(r).includes('research-agents'))
  const ownerCmd = await call('command_get', { role: 'guest', id: 'own-cmd' })
  assert.equal(ownerCmd.isError, true)                                       // an owner command is not visible to a guest at all
})

test('a hub key sees every file of an owner command, with links only for the public repositories', async () => {
  const r = body(await call('command_get', { role: 'owner', id: 'own-cmd' }, 'key'))
  assert.deepEqual(r.files.map((f) => f.repo), ['research-agents', 'rabbit-web'])
  assert.equal(r.files[0].url, undefined)                                    // private repo: a path, no link
  assert.match(r.files[1].url, /^https:\/\/github\.com\/therealsickonechase-bit\/rabbit-web\/blob\/main\//)
  const denied = await call('command_get', { role: 'owner', id: 'own-cmd' }, 'public')
  assert.equal(denied.isError, true)                                         // the owner role needs a key
})

test('agent capabilities are open to everyone, but only a hub key gets the command for sending work', async () => {
  const guest = body(await call('agent_capabilities', {}))
  assert.deepEqual(guest.agents.map((a) => a.id), ['task_worker', 'research'])
  assert.ok(!JSON.stringify(guest).includes('stage_box'))
  assert.match(guest.note, /hub key/)
  const key = body(await call('agent_capabilities', { agent: 'task_worker' }, 'key'))
  assert.equal(key.agents.length, 1)
  assert.match(key.agents[0].howToSend, /stage_box\.py stage --to task_worker/)
  assert.equal((await call('agent_capabilities', { agent: 'nobody' })).isError, true)
})

test('the toolbox status names the bundle, and the tools say so plainly when the data is not loaded', async () => {
  const s = body(await call('toolbox_status', {}))
  assert.equal(s.root, toolbox.root)
  assert.equal(s.counts.files, 709)
  const bare = makeCatalog({ entries })
  const r = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'toolbox_status', arguments: {} } }, { fetchImpl: offline, now: () => 0, catalog: bare, tier: 'public' })).result
  assert.equal(r.isError, true)
  assert.deepEqual(bare.files('guest', 'pub-cmd'), [])
})

test('the data baked into the image is the real bundle: every command with files is a real catalog command, and the agents match the capability file', () => {
  const real = JSON.parse(readFileSync(new URL('../data/toolbox.json', import.meta.url), 'utf8'))
  const cmds = JSON.parse(readFileSync(new URL('../data/commands.json', import.meta.url), 'utf8'))
  const ids = new Set(cmds.entries.map((e) => e.id))
  assert.equal(real.version, 1)
  assert.match(real.root, /^[0-9a-f]{64}$/)
  assert.ok(Object.keys(real.files).length > 100)
  for (const id of Object.keys(real.files)) assert.ok(ids.has(id), id)
  assert.deepEqual(real.agents.map((a) => a.id), ['task_worker', 'research', 'cloud_task_worker', 'cloud_explorer'])
  const text = JSON.stringify(real)
  assert.ok(!/\.env|BEGIN [A-Z ]*PRIVATE|sk-[A-Za-z0-9]{16,}/.test(text))
})
