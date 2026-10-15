import assert from 'node:assert/strict'
import test from 'node:test'
import { forwardHeaders, serve, shouldFailOver, targetUrl } from '../src/failover.mjs'

const P = 'https://primary.example'
const S = 'https://standby.example'
const req = (path = '/chain.html?x=1', init = {}) => new Request('https://rabbitsoftware.io' + path, init)
const reply = (status, body = 'x', headers = {}) => new Response(body, { status, headers })
const router = (map) => async (url) => {
  const u = new URL(url)
  const handler = map[u.origin]
  if (!handler) throw new Error('unexpected origin ' + u.origin)
  return handler(u)
}

test('path and query move to the other origin; the public host is never reused', () => {
  assert.equal(targetUrl(P, 'https://rabbitsoftware.io/chain.html?x=1'), 'https://primary.example/chain.html?x=1')
  assert.throws(() => targetUrl('http://insecure.example', 'https://a/b'))
})

test('only plain headers are forwarded', () => {
  const h = forwardHeaders(new Headers({ cookie: 'a=1', authorization: 'Bearer x', 'cf-connecting-ip': '1.2.3.4', accept: 'text/html', range: 'bytes=0-9' }))
  assert.deepEqual([...h.keys()].sort(), ['accept', 'range'])
})

test('server errors fail over, client errors do not', () => {
  assert.equal(shouldFailOver(500), true)
  assert.equal(shouldFailOver(503), true)
  assert.equal(shouldFailOver(404), false)
  assert.equal(shouldFailOver(304), false)
})

test('a healthy primary answers and the standby is never asked', async () => {
  let standbyCalls = 0
  const res = await serve(req(), { primary: P, standby: S, fetchImpl: router({ [P]: () => reply(200, 'pages'), [S]: () => { standbyCalls++; return reply(200) } }) })
  assert.equal(await res.text(), 'pages')
  assert.equal(res.headers.get('X-Served-By'), 'pages')
  assert.equal(standbyCalls, 0)
})

test('a 404 from the primary is a real answer, not a failure', async () => {
  const res = await serve(req('/nope'), { primary: P, standby: S, fetchImpl: router({ [P]: () => reply(404, 'missing'), [S]: () => reply(200) }) })
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('X-Served-By'), 'pages')
})

test('a 5xx or a network error on the primary falls back to the standby', async () => {
  for (const primaryFails of [() => reply(502), () => { throw new Error('boom') }]) {
    const res = await serve(req(), { primary: P, standby: S, fetchImpl: router({ [P]: primaryFails, [S]: (u) => reply(200, 'standby ' + u.pathname) }) })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'standby /chain.html')
    assert.equal(res.headers.get('X-Served-By'), 'gcp-standby')
  }
})

test('when both fail, the primary error page is shown, or a plain 503', async () => {
  const both = await serve(req(), { primary: P, standby: S, fetchImpl: router({ [P]: () => reply(503, 'pages down'), [S]: () => reply(500) }) })
  assert.equal(both.status, 503)
  assert.equal(both.headers.get('X-Served-By'), 'pages-error')
  const none = await serve(req(), { primary: P, standby: S, fetchImpl: router({ [P]: () => { throw new Error('x') }, [S]: () => { throw new Error('y') } }) })
  assert.equal(none.status, 503)
  assert.equal(none.headers.get('Retry-After'), '60')
})

test('only GET and HEAD are served', async () => {
  const res = await serve(req('/', { method: 'POST', body: 'x' }), { primary: P, standby: S, fetchImpl: router({}) })
  assert.equal(res.status, 405)
})

test('a hung primary times out and the standby answers', async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout'))))
  const fetchImpl = (url, init) => (new URL(url).origin === P ? hang(url, init) : Promise.resolve(reply(200, 'standby')))
  const res = await serve(req(), { primary: P, standby: S, fetchImpl, timeoutMs: 30 })
  assert.equal(await res.text(), 'standby')
})
