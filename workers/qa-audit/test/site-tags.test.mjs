import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = (name) => readFileSync(new URL(`../../../site/${name}.html`, import.meta.url), 'utf8')
const meta = (html, re) => re.exec(html)?.[1]

test('every chain page has a canonical link and sharing tags that agree with its own title and description', () => {
  for (const name of ['index', 'blockchain', 'proof', 'network', 'status', 'research']) {
    const html = page(name)
    const title = meta(html, /<title>([^<]*)<\/title>/)
    const desc = meta(html, /<meta name="description" content="([^"]*)">/)
    assert.ok(title && desc, name)
    assert.equal(meta(html, /<meta property="og:title" content="([^"]*)">/), title, `${name}: og:title`)
    assert.ok(meta(html, /<meta property="og:description" content="([^"]*)">/), `${name}: og:description`)
    assert.match(meta(html, /<meta property="og:image" content="([^"]*)">/), /^https:\/\/rabbitsoftware\.io\/assets\/[\w.-]+\.(jpg|png)$/, `${name}: og:image`)
    assert.ok(meta(html, /<meta property="og:image:alt" content="([^"]*)">/), `${name}: og:image:alt`)
    assert.match(meta(html, /<meta name="twitter:card" content="([^"]*)">/), /^summary/, `${name}: twitter:card`)
    if (name !== 'index') {
      const url = `https://rabbitsoftware.io/${name}.html`
      assert.equal(meta(html, /<link rel="canonical" href="([^"]*)">/), url, `${name}: canonical`)
      assert.equal(meta(html, /<meta property="og:url" content="([^"]*)">/), url, `${name}: og:url`)
      assert.equal(meta(html, /<meta property="og:description" content="([^"]*)">/), desc, `${name}: og:description matches the page description`)
    }
  }
})

test('the preview image the pages point at exists in the site folder', () => {
  const img = meta(page('index'), /<meta property="og:image" content="https:\/\/rabbitsoftware\.io\/assets\/([^"]+)">/)
  assert.ok(readFileSync(new URL(`../../../site/assets/${img}`, import.meta.url)).length > 5000, 'a real image, not a stub')
})
