import assert from 'node:assert/strict'
import test from 'node:test'
import { HF_ITEMS, handleRpc } from '../src/hub.mjs'

const call = async (fetchImpl) => (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'huggingface_status', arguments: {} } }, { fetchImpl, now: () => 0, tier: 'public' })).result
const body = (r) => JSON.parse(r.content[0].text)
const reply = (v, status = 200) => new Response(JSON.stringify(v), { status })

test('it reads only the listed items on huggingface.co and reports metadata, privacy and whether the Space runs', async () => {
  const seen = []
  const f = async (url) => {
    seen.push(new URL(url).host + new URL(url).pathname)
    if (url.includes('/api/spaces/')) return reply({ private: false, likes: 2, lastModified: 'Z', runtime: { stage: 'RUNNING', hardware: { current: 'zero-a10g' } } })
    if (url.includes('/api/models/')) return reply({ private: false, downloads: 83, likes: 0, lastModified: 'Y' })
    if (url.includes('rabbitsoftware-training') || url.includes('rabbitsoftware-knowledge')) return reply({ error: 'x' }, 401)
    return reply({ private: false, downloads: 16, likes: 0, lastModified: 'X' })
  }
  const out = body(await call(f))
  assert.equal(out.spaceRunning, true)
  assert.equal(out.rows.length, HF_ITEMS.length)
  assert.ok(seen.every((s) => s.startsWith('huggingface.co/api/')), seen.join())
  assert.equal(out.rows.find((r) => r.kind === 'space').hardware, 'zero-a10g')
  assert.equal(out.rows.find((r) => r.id.endsWith('rabbitsoftware-knowledge')).visibility, 'private or not found')
  assert.equal(out.rows.find((r) => r.kind === 'model').downloads, 83)
})

test('a network failure or an unexpected status is reported per item without failing the whole call', async () => {
  let n = 0
  const out = body(await call(async () => { n++; if (n === 1) throw new Error('down'); return reply({}, 500) }))
  assert.ok(out.rows.every((r) => r.error))
  assert.equal(out.spaceRunning, false)
})
