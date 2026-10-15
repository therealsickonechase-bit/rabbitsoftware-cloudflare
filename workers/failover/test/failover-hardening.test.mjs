// Cases found in the Gemini review of the first draft, checked here instead of trusted.
import assert from 'node:assert/strict'
import test from 'node:test'
import { serve, targetUrl } from '../src/failover.mjs'

const P = 'https://primary.example'
const S = 'https://standby.example'
const req = (url, init = {}) => new Request(url, init)
const only = (map) => async (url) => {
  const handler = map[new URL(url).origin]
  if (!handler) throw new Error('unexpected origin ' + new URL(url).origin)
  return handler(new URL(url))
}

test('a scheme-relative path cannot turn the Worker into a proxy for another host', async () => {
  for (const path of ['//evil.example/x', '///evil.example', '/\\evil.example', '//evil.example@primary.example/']) {
    const target = targetUrl(P, 'https://rabbitsoftware.io' + path)
    assert.equal(new URL(target).origin, P, path)
  }
  const seen = []
  const fetchImpl = async (url) => { seen.push(new URL(url).origin); return new Response('ok') }
  await serve(req('https://rabbitsoftware.io//evil.example/x'), { primary: P, standby: S, fetchImpl })
  assert.deepEqual(seen, [P])
})

test('304 and HEAD responses pass through without a body error', async () => {
  const notModified = await serve(req('https://rabbitsoftware.io/a', { headers: { 'if-none-match': '"v1"' } }), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response(null, { status: 304 }) }) })
  assert.equal(notModified.status, 304)
  const head = await serve(req('https://rabbitsoftware.io/a', { method: 'HEAD' }), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response(null, { status: 200, headers: { 'content-length': '5' } }) }) })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const empty = await serve(req('https://rabbitsoftware.io/a'), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response(null, { status: 204 }) }) })
  assert.equal(empty.status, 204)
})

test('redirects to the upstream host are sent back to the public host', async () => {
  const moved = await serve(req('https://rabbitsoftware.io/downloads'), {
    primary: P, standby: S,
    fetchImpl: only({ [P]: () => new Response(null, { status: 301, headers: { Location: 'https://primary.example/downloads/?a=1' } }) }),
  })
  assert.equal(moved.status, 301)
  assert.equal(moved.headers.get('Location'), 'https://rabbitsoftware.io/downloads/?a=1')
  const relative = await serve(req('https://rabbitsoftware.io/x'), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response(null, { status: 302, headers: { Location: '/y' } }) }) })
  assert.equal(relative.headers.get('Location'), 'https://rabbitsoftware.io/y')
  const external = await serve(req('https://rabbitsoftware.io/x'), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response(null, { status: 302, headers: { Location: 'https://github.com/x' } }) }) })
  assert.equal(external.headers.get('Location'), 'https://github.com/x')
})

test('error pages are never cached, normal pages keep their own caching', async () => {
  const bad = await serve(req('https://rabbitsoftware.io/'), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response('down', { status: 503 }), [S]: () => new Response('down', { status: 500 }) }) })
  assert.equal(bad.headers.get('Cache-Control'), 'no-store')
  const good = await serve(req('https://rabbitsoftware.io/'), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response('ok', { headers: { 'Cache-Control': 'public, max-age=300' } }) }) })
  assert.equal(good.headers.get('Cache-Control'), 'public, max-age=300')
})

test('the failed primary response is closed when the standby answers', async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const res = await serve(req('https://rabbitsoftware.io/'), { primary: P, standby: S, fetchImpl: only({ [P]: () => new Response(body, { status: 502 }), [S]: () => new Response('standby') }) })
  assert.equal(await res.text(), 'standby')
  assert.equal(cancelled, true)
})
