import assert from 'node:assert/strict'
import test from 'node:test'
import { handle, prepareHtml } from './server.mjs'

const fake = async (f) => Buffer.from(f === 'index.html' ? '<html><body><div id="root"></div><script data-pplx-inline-edit>evil()</script></body></html>' : 'export {}')

test('API, port and WebSocket requests fail explicitly', async () => {
  for (const p of ['/api/auth/me', '/port/5051/api/auth/guest']) {
    const r = await handle('GET', p, {}, fake)
    assert.equal(r.status, 503)
    assert.match(r.body, /backend is not available/)
  }
  assert.equal((await handle('GET', '/', { upgrade: 'websocket' }, fake)).status, 503)
})

test('writes and non-exported files are rejected', async () => {
  assert.equal((await handle('POST', '/', {}, fake)).status, 405)
  for (const p of ['/report.md', '/.env', '/artifacts-1of2.zip', '/../etc/passwd', '/assets/other.js']) assert.equal((await handle('GET', p, {}, fake)).status, 404, p)
})

test('the page gets the warning banner and loses the embedded editor script', async () => {
  const r = await handle('GET', '/', {}, fake)
  assert.equal(r.status, 200)
  assert.match(r.body, /static export preview only/)
  assert.ok(!r.body.includes('evil()'))
  assert.equal(prepareHtml('<body class="x">a</body>').startsWith('<body class="x"><aside'), true)
})

test('assets are served with outbound connections blocked and no indexing', async () => {
  const r = await handle('GET', '/assets/index-drmRIFDg.js', {}, fake)
  assert.equal(r.status, 200)
  assert.match(r.headers['Content-Security-Policy'], /connect-src 'none'/)
  assert.equal(r.headers['X-Robots-Tag'], 'noindex, nofollow')
  assert.match(r.headers['Content-Type'], /javascript/)
})
