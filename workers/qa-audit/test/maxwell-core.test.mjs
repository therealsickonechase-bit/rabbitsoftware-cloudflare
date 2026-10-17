import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ANCHORS_URL, Node, PUBLIC_METHODS, REGISTRY_URL, RpcError, VERSION, initDatadir, makePublicHandler, parseConfig, restRoute, serve } from '../../../maxwell-core/maxwell-core.mjs'
import { HELLO_WORLD, ORIGIN, blockHash, cosign, generateKey, parseChainText, pythonJson, verifyCosignature } from '../../../maxwell-core/witness.mjs'

const realText = readFileSync(new URL('./fixtures/maxwell_chain.json', import.meta.url), 'utf8')
const real = JSON.parse(realText)
const SCRIPT = new URL('../../../maxwell-core/maxwell-core.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const NOW = () => new Date('2026-10-17T18:00:00Z')
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'mcore-')); initDatadir(d); return d }
const serveText = (text) => async () => new Response(text)

// a small honest chain we can fork
function mine(index, note, previous_hash, ts) {
  const raw = (v) => parseChainText(String(v))
  const b = { index: raw(index), timestamp: raw(ts), transactions: [{ sender: 'RESEARCH_ANCHOR', note }], previous_hash, nonce: raw(0) }
  for (let n = 0; ; n++) { b.nonce = raw(n); const h = blockHash(b); if (h.startsWith('00')) return { ...b, hash: h } }
}
function smallChain(notes) {
  const g = { index: parseChainText('0'), timestamp: parseChainText('1792000000.5'), transactions: [{ sender: 'MAXWELL_GENESIS', immutable_anchor_sha: HELLO_WORLD }], previous_hash: '0'.repeat(64), nonce: parseChainText('0') }
  g.hash = blockHash(g)
  const blocks = [g]
  notes.forEach((n, i) => blocks.push(mine(i + 1, n, blocks[i].hash, `${1792000100 + i}.25`)))
  return pythonJson({ difficulty: parseChainText('2'), blocks })
}

test('the configuration is strict: only known settings, https sources, sane ports and intervals', () => {
  assert.deepEqual(parseConfig('# comment\n\nrpcport=8700\nsyncinterval=600\nsource=https://example.org/chain.json\n'), { source: 'https://example.org/chain.json', rpcport: 8700, syncinterval: 600, registry: REGISTRY_URL, anchors: ANCHORS_URL })
  assert.equal(parseConfig('').rpcport, 8645)
  for (const bad of ['source=http://example.org/x', 'rpcport=80', 'rpcport=abc', 'syncinterval=5', 'registry=http://insecure.example/r.json', 'anchors=ftp://x', 'rpcbind=0.0.0.0', 'nonsense', 'allowremote=1']) assert.throws(() => parseConfig(bad), undefined, bad)
})

test('sync takes the real chain, and the RPC answers match it block for block', async () => {
  const d = dir()
  const node = new Node({ datadir: d, fetchImpl: serveText(realText), now: NOW })
  const r = await node.sync()
  assert.equal(r.ok, true)
  assert.equal(r.result, 'updated')
  assert.equal(readFileSync(join(d, 'chain.json'), 'utf8'), realText)                      // stored exactly as downloaded
  const m = node.methods()
  const tip = real.blocks.length - 1
  assert.equal(m.getblockcount(), tip)
  assert.equal(m.getbestblockhash(), real.blocks[tip].hash)
  assert.equal(await node.call('getblockhash', [12]), real.blocks[12].hash)
  const b = await node.call('getblock', [12])
  assert.equal(b.kind, 'RESEARCH_ANCHOR')
  assert.equal(b.transactions[0].count, 1512)
  assert.equal(b.confirmations, tip - 12 + 1)
  assert.equal(b.nextblockhash, real.blocks[13].hash)
  assert.deepEqual(await node.call('getblock', [real.blocks[12].hash]), b)                  // by hash gives the same block
  const h = await node.call('getblockheader', [0])
  assert.equal(h.previousblockhash, null)
  assert.equal(h.kind, 'MAXWELL_GENESIS')
  assert.equal((await node.call('getblockheader', [tip])).nextblockhash, null)
  assert.deepEqual(await node.call('verifychain', []), { ok: true, blocks: real.blocks.length, problems: [] })
  const info = await node.call('getblockchaininfo', [])
  assert.deepEqual([info.chain, info.blocks, info.difficulty, info.verified, info.conflict, info.lastsyncresult], ['maxwell', tip, 2, true, false, 'updated'])
  assert.equal((await node.sync()).result, 'unchanged')
  assert.ok((await node.call('help', [])).includes('getblock'))
})

test('RPC errors are specific: nothing synced yet, bad heights, unknown hashes, bad parameters, unknown methods', async () => {
  const empty = new Node({ datadir: dir(), fetchImpl: serveText(realText), now: NOW })
  await assert.rejects(empty.call('getblockcount', []), (e) => e instanceof RpcError && /run sync first/.test(e.message))
  const node = new Node({ datadir: dir(), fetchImpl: serveText(realText), now: NOW }); await node.sync()
  for (const [method, params, code] of [['getblock', [999], -8], ['getblock', [-1], -8], ['getblock', ['ab'.repeat(32)], -5], ['getblock', ['nope'], -32602], ['getblockhash', ['x'], -8], ['getblock', 'notalist', -32602], ['nosuch', [], -32601]]) {
    await assert.rejects(node.call(method, params), (e) => e.code === code, `${method} ${JSON.stringify(params)}`)
  }
})

test('sync refuses what it must refuse and leaves the stored chain alone: unreachable, an error page, junk, an edited chain, a shorter chain, and a different history', async () => {
  const d = dir()
  const base = smallChain(['a', 'b', 'c'])
  const node = new Node({ datadir: d, fetchImpl: serveText(base), now: NOW })
  assert.equal((await node.sync()).ok, true)
  const stored = readFileSync(join(d, 'chain.json'), 'utf8')
  const tryWith = async (fetchImpl) => { node.fetchImpl = fetchImpl; const r = await node.sync(); assert.equal(readFileSync(join(d, 'chain.json'), 'utf8'), stored, `chain.json must not change after ${r.result}`); return r }
  assert.equal((await tryWith(async () => { throw new Error('offline') })).result, 'unreachable')
  assert.equal((await tryWith(async () => new Response('', { status: 503 }))).result, 'unreachable')
  assert.equal((await tryWith(serveText('<html>error</html>'))).result, 'unreadable')
  const edited = await tryWith(serveText(base.replace('"note": "b"', '"note": "B"')))
  assert.equal(edited.result, 'invalid')
  assert.equal((await tryWith(serveText(smallChain(['a', 'b'])))).result, 'shorter')
  const forked = await tryWith(serveText(smallChain(['a', 'X', 'c', 'd'])))                  // valid, longer, but block 2 differs from the one already held
  assert.equal(forked.result, 'conflict')
  assert.equal(forked.conflict, true)
  assert.equal(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).conflict, true)
  assert.equal((await node.call('getblockchaininfo', [])).conflict, true)
  node.fetchImpl = serveText(smallChain(['a', 'b', 'c', 'd']))                                 // a genuine extension is accepted, and clears the flag
  const grown = await node.sync()
  assert.equal(grown.ok, true)
  assert.equal((await node.call('getblockchaininfo', [])).conflict, false)
  assert.equal(node.methods().getblockcount(), 4)
})

function rpc(port, { body, headers = {}, method = 'POST', cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers }
    if (cookie !== undefined) h.authorization = `Basic ${Buffer.from(cookie).toString('base64')}`
    const req = http.request({ host: '127.0.0.1', port, method, path: '/', headers: h }, (res) => {
      let text = ''; res.on('data', (c) => (text += c)); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject); req.end(body)
  })
}

test('the RPC server: loopback only, cookie required, DNS-rebinding and browser requests refused, limits enforced, stop works', async () => {
  const d = dir()
  const s = await serve({ datadir: d, fetchImpl: serveText(realText), port: 0 })
  try {
    assert.equal(s.server.address().address, '127.0.0.1')
    await new Promise((r) => setTimeout(r, 200))                                                // the first sync runs in the background
    const cookie = readFileSync(join(d, '.cookie'), 'utf8').trim()
    assert.match(cookie, /^__cookie__:[0-9a-f]{64}$/)
    const call = (method, params = [], extra = {}) => rpc(s.port, { body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }), cookie, ...extra })
    const ok = await call('getblockcount')
    assert.deepEqual([ok.status, ok.body.result, ok.body.id], [200, real.blocks.length - 1, 7])
    assert.equal((await call('getblockcount', [], { cookie: undefined })).status, 401)                       // no cookie
    assert.equal((await call('getblockcount', [], { cookie: '__cookie__:wrong' })).status, 401)
    assert.equal((await call('getblockcount', [], { headers: { host: 'evil.example' } })).status, 403)         // DNS rebinding
    assert.equal((await call('getblockcount', [], { headers: { origin: 'https://evil.example' } })).status, 403)   // a web page
    assert.equal((await rpc(s.port, { method: 'GET', cookie })).status, 404)                                     // GET is the REST interface; the root is not a route
    assert.equal((await rpc(s.port, { method: 'GET' })).status, 401)                                              // and it needs the cookie too
    assert.equal((await rpc(s.port, { method: 'PUT', cookie })).status, 405)
    assert.equal((await rpc(s.port, { body: 'x'.repeat(70_000), cookie })).status, 413)
    assert.equal((await rpc(s.port, { body: '{not json', cookie })).body.error.code, -32700)
    assert.equal((await rpc(s.port, { body: JSON.stringify({ id: 1 }), cookie })).body.error.code, -32600)
    assert.equal((await call('nosuch')).body.error.code, -32601)
    assert.equal((await call('getblock', [9999])).body.error.code, -8)
    assert.equal((await call('getnodeinfo')).body.result.version, VERSION)
    assert.equal((await call('stop')).body.result, 'stopping')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(existsSync(join(d, '.cookie')), false)                                          // the cookie goes away with the node
  } finally { await s.close().catch(() => {}) }
})

test('as a witness the node signs the head it verified, and refuses to sign once its chain has a conflict', async () => {
  const d = dir()
  const node = new Node({ datadir: d, fetchImpl: serveText(realText), now: NOW }); await node.sync()
  const k = generateKey()
  writeFileSync(join(d, 'witness', 'edge-node.key'), k.privateKeyPem)
  const r = node.witness('edge-node')
  assert.equal(r.signed, true)
  assert.equal(r.cosignature.size, real.blocks.length)
  assert.equal(r.cosignature.hash, real.blocks.at(-1).hash)
  assert.equal(verifyCosignature(r.cosignature, k.publicKey), true)
  assert.equal(readFileSync(join(d, 'witness', 'edge-node.cosignature.json'), 'utf8').includes('PRIVATE'), false)
  assert.throws(() => node.witness('no-such-key'), /no key at/)
  assert.throws(() => node.witness('../evil'), /no key at/)
  writeFileSync(join(d, 'witness', 'edge-node.state.json'), JSON.stringify({ size: real.blocks.length, hash: 'ab'.repeat(32) }))      // pretend it had signed a different head
  const c = node.witness('edge-node')
  assert.equal(c.signed, false)
  assert.equal(c.conflict, true)
})

test('the command line works end to end against a running node, and the program keeps to its own folder', async () => {
  const d = dir()
  const free = await new Promise((res) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => res(p)) }) })
  writeFileSync(join(d, 'maxwell.conf'), `rpcport=${Math.max(free, 1024)}\nsyncinterval=3600\n`)
  const s = await serve({ datadir: d, fetchImpl: serveText(realText) })
  try {
    await new Promise((r) => setTimeout(r, 300))
    // asynchronous on purpose: this process hosts the node, so it must stay free to answer the child
    const run = (...a) => new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...a, '--datadir', d], { encoding: 'utf8', timeout: 20_000 }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })))
    const count = await run('cli', 'getblockcount')
    assert.equal(count.status, 0, count.stderr)
    assert.equal(count.stdout.trim(), String(real.blocks.length - 1))
    assert.equal(JSON.parse((await run('cli', 'getblock', '12')).stdout).transactions[0].count, 1512)
    const missing = await run('cli', 'getblock', '99999')
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /out of range/)
    assert.equal((await run('nonsense')).status, 2)
  } finally { await s.close().catch(() => {}) }
  const src = readFileSync(SCRIPT, 'utf8')
  assert.ok(!/0\.0\.0\.0|\.listen\([^)]*,\s*'::'/.test(src), 'it never binds beyond the loopback address')
  assert.equal(readFileSync(new URL('../../../maxwell-core/witness.mjs', import.meta.url), 'utf8'), readFileSync(new URL('../../../scripts/witness.mjs', import.meta.url), 'utf8'), 'run: cp scripts/witness.mjs maxwell-core/witness.mjs')
})

// ---------------------------------------------------------------- version 0.2: more methods, the REST interface and the public read-only gateway
const head = real.blocks.at(-1)
const KEY = generateKey()
const witnessFiles = () => {
  const cosig = cosign({ name: 'pc-witness', checkpoint: { origin: ORIGIN, size: real.blocks.length, hash: head.hash }, privateKeyPem: KEY.privateKeyPem, publicKey: KEY.publicKey, now: NOW() })
  const registry = { v: 1, k: 1, witnesses: [{ name: 'pc-witness', kind: 'project', publicKey: KEY.publicKey, url: 'https://w.example/pc.json' }] }
  const anchors = [{ id: '2026-10-17T130014Z', digest: 'a'.repeat(64), status: 'confirmed', bitcoinHeight: 971865, maxwellLength: 14, ledgerLength: 18, tsa: 'freetsa.org' }, { id: 'bad id', status: 'confirmed' }]
  return { [REGISTRY_URL]: registry, 'https://w.example/pc.json': cosig, [ANCHORS_URL]: anchors }
}
const world = (over = {}) => async (url) => {
  const u = String(url).split('?')[0]
  if (u.endsWith('/maxwell/maxwell_chain.json')) return new Response(realText)
  const f = { ...witnessFiles(), ...over }
  if (f[u] === undefined) return new Response('', { status: 404 })
  return new Response(JSON.stringify(f[u]))
}

test('the new methods describe the chain, the miners, the network, the peers (witnesses) and the anchors', async () => {
  const node = new Node({ datadir: dir(), fetchImpl: world(), now: NOW }); await node.sync()
  assert.deepEqual(await node.call('getchaintips', []), [{ height: real.blocks.length - 1, hash: head.hash, branchlen: 0, status: 'active' }])
  const research = real.blocks.filter((b) => b.transactions[0].sender === 'RESEARCH_ANCHOR')
  const mining = await node.call('getmininginfo', [])
  assert.equal(mining.difficulty, 2)
  assert.equal(mining.blocksbykind.RESEARCH_ANCHOR, research.length)
  assert.equal(mining.lastresearchanchor.records, research.at(-1).transactions[0].count)
  assert.ok(mining.lastwebsnapshot.height > 0)
  const net = await node.call('getnetworkinfo', [])
  assert.equal(net.subversion, `/MaxwellCore:${VERSION}/`)
  assert.equal(net.localservices[0], 'node')
  assert.equal(await node.call('uptime', []), 0)
  const peers = await node.call('getpeerinfo', [])
  assert.deepEqual(peers.map((p) => [p.addr, p.status, p.synced_blocks]), [['pc-witness', 'agrees', real.blocks.length]])
  const w = await node.call('getwitnessinfo', [])
  assert.equal(w.trusted, true)
  assert.match(w.summary, /1 of 1 witnesses signed the current head, which meets the rule of 1/)
  const a = await node.call('getanchorinfo', [])
  assert.deepEqual(a.anchors.map((x) => [x.id, x.status, x.bitcoinheight, x.tsa]), [['2026-10-17T130014Z', 'confirmed', 971865, true]])      // the malformed row is dropped
  assert.equal(a.latestconfirmed.bitcoinheight, 971865)
  const dead = new Node({ datadir: dir(), fetchImpl: serveText(realText), now: NOW }); await dead.sync()          // witnesses unreachable: an error, not a wrong answer
  await assert.rejects(dead.call('getpeerinfo', []))
})

test('the REST routes map to the right methods and nothing else', () => {
  assert.deepEqual(restRoute('/rest/chaininfo.json').slice(0, 2), ['getblockchaininfo', []])
  assert.deepEqual(restRoute('/rest/block/12.json').slice(0, 2), ['getblock', ['12']])
  assert.deepEqual(restRoute(`/rest/block/${'ab'.repeat(32)}.json`).slice(0, 2), ['getblock', ['ab'.repeat(32)]])
  assert.deepEqual(restRoute('/rest/blockhashbyheight/7.json').slice(0, 2), ['getblockhash', [7]])
  assert.deepEqual(restRoute('/rest/blockhashbyheight/7.json')[2]('x'), { blockhash: 'x' })
  for (const bad of ['/rest/sync.json', '/rest/block/xyz.json', '/rest/block/12', '/rest/../etc/passwd', '/rest/stop.json', '/']) assert.equal(restRoute(bad), null, bad)
})

function get(port, path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''; res.on('data', (c) => (text += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject); req.end(body)
  })
}

test('the public gateway serves public chain data to anyone, read-only, with no cookie, and never exposes owner methods or the data folder', async () => {
  const d = dir()
  const s = await serve({ datadir: d, fetchImpl: world(), port: 0, publicMode: true, now: NOW })
  try {
    assert.equal(existsSync(join(d, '.cookie')), false)                                       // no secret exists in this mode
    assert.equal((await get(s.port, '/health')).body.ok, true)                                // /healthz is reserved by Google's front end on Cloud Run, so /health must work too
    const health = await get(s.port, '/healthz')
    assert.deepEqual([health.status, health.body.mode, health.headers['access-control-allow-origin']], [200, 'public read-only gateway', '*'])
    const info = await get(s.port, '/rest/chaininfo.json')
    assert.deepEqual([info.status, info.body.blocks, info.body.bestblockhash, info.body.verified], [200, real.blocks.length - 1, head.hash, true])
    assert.equal(info.headers['cache-control'], 'public, max-age=15')
    assert.equal((await get(s.port, '/rest/block/12.json')).body.transactions[0].count, 1512)
    assert.equal((await get(s.port, '/rest/blockhashbyheight/12.json')).body.blockhash, real.blocks[12].hash)
    assert.equal((await get(s.port, '/rest/block/9999.json')).status, 404)
    assert.equal((await get(s.port, '/rest/witnesses.json')).body.trusted, true)
    assert.equal((await get(s.port, '/rest/anchors.json')).body.anchors.length, 1)
    assert.equal((await get(s.port, '/rest/nope.json')).status, 404)
    assert.equal((await get(s.port, '/', {}, 'OPTIONS')).status, 204)
    const rpcCall = (method, params = []) => get(s.port, '/', { 'content-type': 'application/json', origin: 'https://rabbitsoftware.io' }, 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
    assert.equal((await rpcCall('getblockcount')).body.result, real.blocks.length - 1)       // a browser page may call it
    for (const owner of ['sync', 'stop', 'witness', 'nosuch']) {
      const r = await rpcCall(owner)
      assert.equal(r.body.error.code, -32601, owner)
    }
    assert.match((await rpcCall('sync')).body.error.message, /not available on the public gateway/)
    const nodeinfo = (await rpcCall('getnodeinfo')).body.result
    assert.equal(nodeinfo.mode, 'public read-only gateway')
    assert.ok(!JSON.stringify(nodeinfo).includes(d) && !('datadir' in nodeinfo))              // the server's folder is never revealed
    assert.deepEqual((await rpcCall('help')).body.result.sort(), [...PUBLIC_METHODS].sort())
    assert.equal((await get(s.port, '/', { 'content-type': 'application/json' }, 'POST', 'x'.repeat(20_000))).status, 413)
    assert.equal((await get(s.port, '/', {}, 'DELETE')).status, 405)
  } finally { await s.close().catch(() => {}) }
})

test('the public gateway is rate-limited per client address', async () => {
  const node = new Node({ datadir: dir(), fetchImpl: world(), now: NOW, publicMode: true }); await node.sync()
  const server = http.createServer(makePublicHandler(node, { perMinute: 3 }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = server.address().port
    const codes = []
    for (let i = 0; i < 5; i++) codes.push((await get(port, '/healthz', { 'x-forwarded-for': '203.0.113.9' })).status)
    assert.deepEqual(codes, [200, 200, 200, 429, 429])
    const other = await get(port, '/healthz', { 'x-forwarded-for': '203.0.113.10' })           // another client is not affected
    assert.equal(other.status, 200)
    const limited = await get(port, '/healthz', { 'x-forwarded-for': '203.0.113.9' })
    assert.equal(limited.headers['retry-after'], '30')
  } finally { await new Promise((r) => server.close(r)) }
})

test('the private RPC refuses to be bound beyond the loopback address, and a public cli can call a gateway by URL', async () => {
  await assert.rejects(serve({ datadir: dir(), fetchImpl: world(), port: 0, bind: '0.0.0.0' }), /127\.0\.0\.1 only/)
  const d = dir()
  const s = await serve({ datadir: d, fetchImpl: world(), port: 0, publicMode: true })
  try {
    const cli = (...a) => new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', timeout: 20_000 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr })))
    const out = await cli('cli', '--url', `http://127.0.0.1:${s.port}/`, 'getblockcount')
    assert.equal(out.code, 0, out.stderr)
    assert.equal(out.stdout.trim(), String(real.blocks.length - 1))
    assert.equal((await cli('cli', '--url', 'file:///etc/passwd', 'getblockcount')).code, 1)
  } finally { await s.close().catch(() => {}) }
})
