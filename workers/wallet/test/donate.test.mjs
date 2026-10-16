import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DONATIONS_OPEN, PATHS, appModule, donatePage, loadVerified, patchIndex, patchSitemap } from '../build-donate.mjs'
import { isValidBitcoinAddress, isValidEthereumAddress } from '../src/addresses.mjs'

const wallet = JSON.parse(readFileSync(PATHS.wallet, 'utf8'))
const index = readFileSync(PATHS.site + 'index.html', 'utf8')
const donate = DONATIONS_OPEN ? readFileSync(PATHS.site + 'donate.html', 'utf8') : ''
const ETH_ANY = /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g // whole addresses only (the 65-byte signature also starts with 0x + hex)
const BTC_ANY = /\b(?:bc1|tb1)[a-z0-9]{20,}\b/gi

test('the generated pages are up to date with wallet.json', () => {
  execFileSync(process.execPath, [join(PATHS.wallet, '..', 'build-donate.mjs'), '--check'], { stdio: 'pipe' })
})

test('the only addresses on the public pages are the two in wallet.json, and both are valid', { skip: !DONATIONS_OPEN && 'donations are paused' }, () => {
  for (const [name, html] of [['index.html', index], ['donate.html', donate]]) {
    assert.deepEqual([...new Set(html.match(ETH_ANY) ?? [])], [wallet.ethereum.address], `${name}: Ethereum address`)
    assert.deepEqual([...new Set(html.match(BTC_ANY) ?? [])], [wallet.bitcoin.address], `${name}: Bitcoin address`)
  }
  assert.ok(isValidEthereumAddress(wallet.ethereum.address) && isValidBitcoinAddress(wallet.bitcoin.address))
  assert.equal(JSON.parse(readFileSync(PATHS.site + 'wallet.json', 'utf8')).ethereum.address, wallet.ethereum.address)
})

test('the pages carry the safety notes and load nothing from outside', { skip: !DONATIONS_OPEN && 'donations are paused' }, () => {
  assert.match(donate, /Ethereum mainnet/)
  assert.match(donate, /cannot be reversed/)
  assert.match(donate, /not (investments|an investment)/i)
  assert.match(index, /id="donate"/)
  for (const html of [index, donate]) assert.ok(!/<script[^>]+src=["']https?:/.test(html.replace(/static\.cloudflareinsights\.com[^"']*/g, '')), 'no external scripts')
})

test('the front-page block is replaced in place, not duplicated, when regenerated', { skip: !DONATIONS_OPEN && 'donations are paused' }, () => {
  const again = patchIndex(index, wallet)
  assert.equal((again.match(/id="donate"/g) ?? []).length, 1)
  assert.equal(again, patchIndex(again, wallet))
})

test('the build refuses a changed address, a bad checksum or a proof that does not match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-'))
  const write = (obj) => { const p = join(dir, 'w.json'); writeFileSync(p, JSON.stringify(obj)); return p }
  const swapped = structuredClone(wallet); swapped.ethereum.address = '0x' + 'ab'.repeat(20)
  await assert.rejects(loadVerified(write(swapped)), /invalid or differs/)
  const flipped = structuredClone(wallet); flipped.ethereum.address = wallet.ethereum.address.replace(/[a-f]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
  await assert.rejects(loadVerified(write(flipped)))
  const badBtc = structuredClone(wallet); badBtc.bitcoin.address = wallet.bitcoin.address.slice(0, -1) + (wallet.bitcoin.address.endsWith('q') ? 'p' : 'q')
  await assert.rejects(loadVerified(write(badBtc)), /invalid or differs/)
  const forged = structuredClone(wallet); forged.proof.message = 'something else'
  await assert.rejects(loadVerified(write(forged)), /does not verify/)
  assert.ok((await loadVerified()).ethereum.address)
})

test('the donate page text comes only from wallet.json', () => {
  const page = donatePage(wallet)
  assert.ok(page.includes(wallet.proof.ethereum.signature) && page.includes(wallet.key.publicKeyCompressed))
})

test('paused mode strips every donation surface and open mode puts the block back', () => {
  const open = patchIndex(index, wallet, true)
  assert.equal((open.match(/id="donate"/g) ?? []).length, 1)
  const closed = patchIndex(open, wallet, false)
  assert.ok(!closed.includes(wallet.bitcoin.address) && !closed.includes(wallet.ethereum.address) && !/id="donate"/.test(closed))
  assert.equal(patchIndex(closed, wallet, false), closed)
  const map = ['<urlset>', '  <url><loc>https://rabbitsoftware.io/donate.html</loc></url>', '  <url><loc>https://rabbitsoftware.io/story.html</loc></url>', '</urlset>'].join(String.fromCharCode(10))
  assert.ok(!patchSitemap(map, false).includes('donate.html') && patchSitemap(map, false).includes('story.html'))
  assert.match(appModule('{}', false), /DONATIONS_OPEN = false/)
  assert.match(appModule('{}', true), /DONATIONS_OPEN = true/)
})

test('the site payment button asks the visitor wallet to send to the published Ethereum address and nothing else', async () => {
  const { runInNewContext } = await import('node:vm')
  const { copyScript } = await import('../build-donate.mjs')
  const code = copyScript.replace(/^<script>/, '').replace(/<\/script>$/, '')
  const mk = () => {
    const input = { value: '0.01' }, msg = { textContent: '' }, listeners = {}
    const btn = { addEventListener: (_e, fn) => { listeners.click = fn } }
    const box = { getAttribute: () => wallet.ethereum.address, querySelector: (q) => (q === 'input' ? input : q === 'button' ? btn : msg) }
    const calls = []
    const window = { ethereum: { request: async (a) => { calls.push(a); return { eth_requestAccounts: ['0xabc'], eth_sendTransaction: '0xhash' }[a.method] ?? null } } }
    const sandbox = { window, document: { addEventListener() {}, querySelector: (q) => (q === '[data-pay-eth]' ? box : null) }, navigator: {}, BigInt, setTimeout }
    runInNewContext(code, sandbox)
    return { input, msg, listeners, calls, window }
  }
  const ok = mk()
  await ok.listeners.click()
  assert.deepEqual(ok.calls.map((c) => c.method), ['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_sendTransaction'])
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls[2].params)), [{ from: '0xabc', to: wallet.ethereum.address, value: '0x2386f26fc10000' }])
  assert.match(ok.msg.textContent, /^Sent\. Transaction 0xhash/)
  const bad = mk(); bad.input.value = '1e3'
  await bad.listeners.click()
  assert.equal(bad.calls.length, 0)
  assert.match(bad.msg.textContent, /Enter an amount/)
  assert.match(donatePage(wallet), /data-pay-eth="0x724Dfe717565742b066465813773586df98d9372"/)
})

test('the generated pages contain exactly the tested script and styles (nothing stale is left on the front page)', async () => {
  const { copyScript } = await import('../build-donate.mjs')
  for (const [name, html] of [['index.html', index], ['donate.html', donate]]) {
    assert.ok(html.includes(copyScript), `${name}: script is the current one`)
    assert.equal((html.match(/data-pay-eth\]/g) ?? []).length, 1, `${name}: one payment script`)
  }
})
