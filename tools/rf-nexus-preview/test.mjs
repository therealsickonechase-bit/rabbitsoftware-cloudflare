import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.mjs'

test('API and WebSocket requests fail explicitly without reaching assets', async () => {
  for (const path of ['/api/auth/me', '/port/5051/api/auth/guest']) {
    const response = await worker.fetch(new Request(`https://preview.invalid${path}`), {})
    assert.equal(response.status, 503)
    assert.match((await response.json()).error, /backend is not available/)
  }
  const response = await worker.fetch(new Request('https://preview.invalid/', {
    headers: { Upgrade: 'websocket' },
  }), {})
  assert.equal(response.status, 503)
})

test('write methods and non-exported files are rejected', async () => {
  const write = await worker.fetch(new Request('https://preview.invalid/', { method: 'POST' }), {})
  assert.equal(write.status, 405)
  for (const path of ['/report.md', '/.env', '/artifacts-1of2.zip']) {
    assert.equal((await worker.fetch(new Request(`https://preview.invalid${path}`), {})).status, 404)
  }
})

test('only allowlisted assets are served with outbound connections blocked', async () => {
  const response = await worker.fetch(new Request('https://preview.invalid/assets/index-drmRIFDg.js'), {
    ASSETS: { fetch: async () => new Response('export {}', { headers: { 'Content-Type': 'application/javascript' } }) },
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'export {}')
  assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'none'/)
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow')
})
