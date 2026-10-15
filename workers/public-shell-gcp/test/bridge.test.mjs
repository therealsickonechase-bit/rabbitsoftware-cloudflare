import assert from 'node:assert/strict'
import test from 'node:test'
import { gcpTarget, openGcpTerminal } from '../../public-shell/src/gcp-terminal.mjs'
import { PTY_PROTOCOL, verifyBridgeToken } from '../src/protocol.mjs'

const SECRET = 'synthetic-secret-for-tests-0123456789abcdef'
const GOOD = { TERMINAL_BACKEND: 'gcp', GCP_SHELL_URL: 'https://rabbit-visitor-shell-abc123-wl.a.run.app', PTY_BRIDGE_SECRET: SECRET }

class FakeSocket extends EventTarget {
  constructor() { super(); this.sent = []; this.closedWith = null }
  send(data) { this.sent.push(data) }
  close(code, reason) { this.closedWith = [code, reason]; this.dispatchEvent(new Event('close')) }
  receive(data) { const e = new Event('message'); e.data = data; this.dispatchEvent(e) }
}

test('the GCP backend is used only when fully and safely configured', () => {
  assert.equal(gcpTarget(GOOD), 'https://rabbit-visitor-shell-abc123-wl.a.run.app')
  assert.equal(gcpTarget({}), null)
  assert.equal(gcpTarget({ ...GOOD, TERMINAL_BACKEND: 'cloudflare' }), null)
  assert.equal(gcpTarget({ ...GOOD, PTY_BRIDGE_SECRET: 'short' }), null)
  for (const url of ['http://x.run.app', 'https://evil.example', 'https://x.run.app.evil.example', 'https://user:pw@x.run.app', 'not a url', undefined]) {
    assert.equal(gcpTarget({ ...GOOD, GCP_SHELL_URL: url }), null, String(url))
  }
})

test('opening a terminal signs a token for this session, sends the start frame and nothing else first', async () => {
  const socket = new FakeSocket()
  let seen = null
  const t = await openGcpTerminal({ connect: async (url, protocols) => { seen = { url, protocols }; return socket }, origin: GOOD.GCP_SHELL_URL, secret: SECRET, sid: 'sess12345678', expiresAt: Date.now() + 60_000, cols: 100, rows: 30, keys: { ANTHROPIC_API_KEY: 'k'.repeat(20) } })
  assert.equal(seen.url, `${GOOD.GCP_SHELL_URL}/pty`)
  assert.equal(seen.protocols[0], PTY_PROTOCOL)
  assert.equal(verifyBridgeToken(SECRET, seen.protocols[1])?.sid, 'sess12345678')
  assert.equal(verifyBridgeToken('another-synthetic-secret-0123456789abcdef', seen.protocols[1]), null)
  assert.equal(socket.sent.length, 1)
  assert.deepEqual(JSON.parse(socket.sent[0]), { t: 'start', cols: 100, rows: 30, keys: { ANTHROPIC_API_KEY: 'k'.repeat(20) } })
  assert.ok(t)
})

test('input and resize become the frames the service expects', async () => {
  const socket = new FakeSocket()
  const t = await openGcpTerminal({ connect: async () => socket, origin: GOOD.GCP_SHELL_URL, secret: SECRET, sid: 'sess12345678', expiresAt: Date.now() + 60_000, cols: 80, rows: 24 })
  await t.write(new TextEncoder().encode('ls é\r'))
  await t.resize(120, 40)
  assert.deepEqual(JSON.parse(socket.sent[1]), { t: 'i', d: 'ls é\r' })
  assert.deepEqual(JSON.parse(socket.sent[2]), { t: 'r', cols: 120, rows: 40 })
})

test('output arrives as data events and a close ends the stream with a terminal event', async () => {
  const socket = new FakeSocket()
  const t = await openGcpTerminal({ connect: async () => socket, origin: GOOD.GCP_SHELL_URL, secret: SECRET, sid: 'sess12345678', expiresAt: Date.now() + 60_000, cols: 80, rows: 24 })
  const reader = (await t.output()).getReader()
  socket.receive(new TextEncoder().encode('hello').buffer)
  socket.receive('text frames from the service are ignored')
  const first = await reader.read()
  assert.equal(first.value.type, 'data')
  assert.equal(new TextDecoder().decode(first.value.data), 'hello')
  socket.close(1000, 'exited')
  assert.equal((await reader.read()).value.type, 'terminal')
  assert.equal((await reader.read()).done, true)
})

test('terminating closes the service socket once and later writes are dropped', async () => {
  const socket = new FakeSocket()
  const t = await openGcpTerminal({ connect: async () => socket, origin: GOOD.GCP_SHELL_URL, secret: SECRET, sid: 'sess12345678', expiresAt: Date.now() + 60_000, cols: 80, rows: 24 })
  await t.terminate()
  assert.deepEqual(socket.closedWith, [1000, 'done'])
  const before = socket.sent.length
  await t.write(new TextEncoder().encode('late'))
  await t.resize(90, 30)
  assert.equal(socket.sent.length, before)
  await t.terminate()    // safe to call twice
})
