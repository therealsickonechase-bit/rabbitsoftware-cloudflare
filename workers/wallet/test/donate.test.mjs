import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PATHS, donatePage, loadVerified, patchIndex } from '../build-donate.mjs'
import { isValidBitcoinAddress, isValidEthereumAddress } from '../src/addresses.mjs'

const wallet = JSON.parse(readFileSync(PATHS.wallet, 'utf8'))
const index = readFileSync(PATHS.site + 'index.html', 'utf8')
const donate = readFileSync(PATHS.site + 'donate.html', 'utf8')
const ETH_ANY = /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g // whole addresses only (the 65-byte signature also starts with 0x + hex)
const BTC_ANY = /\b(?:bc1|tb1)[a-z0-9]{20,}\b/gi

test('the generated pages are up to date with wallet.json', () => {
  execFileSync(process.execPath, [join(PATHS.wallet, '..', 'build-donate.mjs'), '--check'], { stdio: 'pipe' })
})

test('the only addresses on the public pages are the two in wallet.json, and both are valid', () => {
  for (const [name, html] of [['index.html', index], ['donate.html', donate]]) {
    assert.deepEqual([...new Set(html.match(ETH_ANY) ?? [])], [wallet.ethereum.address], `${name}: Ethereum address`)
    assert.deepEqual([...new Set(html.match(BTC_ANY) ?? [])], [wallet.bitcoin.address], `${name}: Bitcoin address`)
  }
  assert.ok(isValidEthereumAddress(wallet.ethereum.address) && isValidBitcoinAddress(wallet.bitcoin.address))
  assert.equal(JSON.parse(readFileSync(PATHS.site + 'wallet.json', 'utf8')).ethereum.address, wallet.ethereum.address)
})

test('the pages carry the safety notes and load nothing from outside', () => {
  assert.match(donate, /Ethereum mainnet/)
  assert.match(donate, /cannot be reversed/)
  assert.match(donate, /not (investments|an investment)/i)
  assert.match(index, /id="donate"/)
  for (const html of [index, donate]) assert.ok(!/<script[^>]+src=["']https?:/.test(html.replace(/static\.cloudflareinsights\.com[^"']*/g, '')), 'no external scripts')
})

test('the front-page block is replaced in place, not duplicated, when regenerated', () => {
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
