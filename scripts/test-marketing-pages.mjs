// Guards the story, chain-explainer, press and donate pages: links resolve, nothing overclaims, limits are stated, live-number slots are all filled by the script.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..', 'site')
const read = (f) => readFileSync(join(site, f), 'utf8')
const OPEN = JSON.parse(readFileSync(join(site, '..', 'workers', 'wallet', 'donations.json'), 'utf8')).open === true
const PAGES = OPEN ? ['story.html', 'blockchain.html', 'press.html', 'donate.html'] : ['story.html', 'blockchain.html', 'press.html']
const visible = (html) => html
  .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '-').replace(/&amp;/g, '&').replace(/&hellip;/g, '...').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')

test('every page has one h1, a title, a description, and loads no outside script', () => {
  for (const f of PAGES) {
    const html = read(f)
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, `${f}: h1`)
    assert.match(html, /<title>[^<]{5,}<\/title>/, `${f}: title`)
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, `${f}: description`)
    assert.ok(!/<script[^>]+src=["']https?:/.test(html), `${f}: external script`)
  }
})

test('every local link on the new pages and the front-page block points at a file that exists', () => {
  const index = read('index.html')
  const story = index.match(/<!-- story:start -->[\s\S]*?<!-- story:end -->/)[0]
  for (const [name, html] of [...PAGES.map((f) => [f, read(f)]), ['index story block', story]]) {
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = m[1]
      if (/^(https?:|mailto:|bitcoin:|ethereum:|#)/.test(url)) continue
      const file = url.split('#')[0].split('?')[0]
      if (file) assert.ok(existsSync(join(site, file)), `${name}: missing ${url}`)
    }
  }
})

test('nothing overclaims: risky words appear only inside an explicit negation or the "we do not say" list', () => {
  const NEGATIONS = [
    /<tr><th>We do not say<\/th>[\s\S]*?<\/tr>/g, /<tr><th>If asked about health<\/th>[\s\S]*?<\/tr>/g, /<tr><th>If asked about money<\/th>[\s\S]*?<\/tr>/g,
  ]
  const PHRASES = [
    /not an? investments?/gi, /not investments/gi, /not a decentralized public blockchain/gi, /not clinical software/gi, /not a clinical product/gi,
    /does not diagnose, recommend treatment or edit dna in a body/gi, /no coin, token or price/gi, /no token, no sale and no price/gi, /not a cryptocurrency/gi,
    /it is not a decentralized[^.]*\./gi, /no coin, token or price, and nothing to buy, sell or trade/gi, /there is no token or sale/gi, /there is no coin/gi,
  ]
  const RISKY = /\b(guarantee[sd]?|unhackable|unbreakable|immutable|risk-free|profit|returns|roi|get rich|diagnos\w*|treat(ment|ing)?|cures?|decentralized|decentralised)\b/i
  for (const f of PAGES) {
    let html = read(f)
    for (const re of NEGATIONS) html = html.replace(re, ' ')
    let text = visible(html)
    for (const re of PHRASES) text = text.replace(re, ' ')
    const hit = text.match(RISKY)
    assert.equal(hit, null, `${f}: "${hit && hit[0]}" outside a negation: ...${hit && text.slice(Math.max(0, hit.index - 60), hit.index + 60)}...`)
  }
})

test('the limits are stated where people will read them', () => {
  const chain = visible(read('blockchain.html'))
  assert.match(chain, /not a decentralized public blockchain/i)
  assert.match(chain, /Tampering is detectable, not impossible/)
  assert.match(chain, /A timestamp is not truth/)
  assert.match(chain, /Never on the chain/)
  assert.match(visible(read('story.html')), /not clinical software/i)
  assert.match(visible(read('press.html')), /We do not say/)
})

test('the pages do not claim open source or link to repositories visitors cannot open (checked 2026-10-15: none is public)', () => {
  for (const f of PAGES) {
    const html = read(f)
    assert.ok(!/github\.com\/rabbitsoftware-io\//.test(html), `${f}: links to a private repository`)
    assert.ok(!/open[- ]source|open and inspectable|code is published|source is public/i.test(visible(html).replace(/not (an? )?open[- ]source/gi, '')), `${f}: claims open source`)
  }
})

test('every live-number slot is filled by live-facts.js', () => {
  const script = read('live-facts.js')
  for (const f of ['blockchain.html', 'press.html']) {
    const slots = [...read(f).matchAll(/data-fact="([a-z-]+)"/g)].map((m) => m[1])
    assert.ok(slots.length >= 3, `${f}: slots`)
    for (const s of slots) assert.ok(script.includes(`'${s}'`), `${f}: no filler for ${s}`)
    assert.match(read(f), /<script src="live-facts\.js" defer><\/script>/)
  }
})

test('the front page links the story, the chain and the press kit, and the sitemap lists them', () => {
  const index = read('index.html')
  for (const p of ['story.html', 'blockchain.html', 'press.html']) assert.ok(index.includes(`href="${p}"`), `index: ${p}`)
  const map = read('sitemap.xml')
  for (const p of PAGES) assert.ok(map.includes(`/${p}<`), `sitemap: ${p}`)
})

test('the story page only repeats what the approved author page says: no ages, medical events or credentials are restated', () => {
  const text = visible(read('story.html'))
  assert.ok(!/\bage (three|six|seven|ten|twelve|fourteen|sixteen|eighteen|twenty|thirty)/i.test(text))
  assert.ok(!/\b(ph\.?d|m\.?d\.?|professor|dr\.|board[- ]certified|clinician|surgeon)\b/i.test(text), 'credentials')
  assert.match(text, /marked as a personal reflection rather than verified research/)
})

test('donations are paused: no donate page, no wallet file, no donation address or invitation anywhere on the public site', { skip: OPEN && 'donations are open' }, () => {
  assert.equal(OPEN, false)
  assert.ok(!existsSync(join(site, 'donate.html')) && !existsSync(join(site, 'wallet.json')))
  for (const f of ['index.html', 'story.html', 'blockchain.html', 'press.html', 'sitemap.xml']) {
    const html = read(f)
    assert.ok(!/bc1q[a-z0-9]{30,}|0x[0-9a-fA-F]{40}|donate.html|bitcoin:|ethereum:/.test(html), `${f}: donation address or link`)
    assert.ok(!/id="donate"/.test(html), `${f}: donate section`)
  }
  for (const f of PAGES) assert.ok(!/voluntary donations|support the work|Donate</i.test(visible(read(f))), `${f}: invites donations`)
})

test('donations are open: the front page shows both addresses with open-in-wallet links, and the donate page, wallet file, sitemap and nav agree', { skip: !OPEN && 'donations are paused' }, () => {
  const wallet = JSON.parse(read('wallet.json'))
  const index = read('index.html')
  for (const [uri, address] of [['bitcoin', wallet.bitcoin.address], ['ethereum', wallet.ethereum.address]]) {
    assert.ok(index.includes(`href="${uri}:${address}"`), `front page: ${uri}: open-in-wallet link`)
    assert.ok(index.includes(`data-copy="${address}"`), `front page: copy button for ${uri}`)
    assert.ok(read('donate.html').includes(address), `donate page: ${uri} address`)
  }
  assert.ok(index.includes('href="donate.html"') && read('sitemap.xml').includes('/donate.html<'))
  assert.match(visible(read('donate.html')), /not investments/)
  assert.match(visible(read('donate.html')), /cannot be reversed/)
})
