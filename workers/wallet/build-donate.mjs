// Builds the public donation pages from wallet.json, after re-checking the addresses and the signed proof.
//   node build-donate.mjs            writes site/donate.html, site/wallet.json, the front-page block (between markers), the sitemap entry, and the app copy
//   node build-donate.mjs --check    verifies the generated files are up to date, writes nothing (used by the tests)
// Nothing here can alter an address by hand: the text on every page comes from wallet.json, and the build stops if validation or the proof fails.
import { readFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isValidBitcoinAddress, isValidEthereumAddress, pubFromPem } from './src/addresses.mjs'
import { checkProof } from './src/proof.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
export const PATHS = {
  wallet: here('./wallet.json'),
  pem: here('./public-key.pem'),
  site: here('../../site/'),
  app: here('../../../rabbit-web/src/lib/wallet.ts'),
  links: here('./wallet-links.json'),
  appLinks: here('../../../rabbit-web/src/lib/wallet-links.ts'),
}
/** donations.json decides whether the donate pages exist at all. false = paused: no donate page, no wallet.json, no addresses anywhere on the site. */
export const LINKS = JSON.parse(readFileSync(here('./wallet-links.json'), 'utf8'))
const ext = (url, text) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
export const explorerLinks = (w) => ({ bitcoin: `https://mempool.space/address/${w.bitcoin.address}`, ethereum: `https://etherscan.io/address/${w.ethereum.address}` })
export const DONATIONS_OPEN = JSON.parse(readFileSync(here('./donations.json'), 'utf8')).open === true
const ANCHORS = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/index.json'

export async function loadVerified(walletPath = PATHS.wallet) {
  const wallet = JSON.parse(await readFile(walletPath, 'utf8'))
  const eth = wallet.ethereum?.address, btc = wallet.bitcoin?.address
  if (!isValidEthereumAddress(eth) || eth !== wallet.proof?.ethereum?.address) throw new Error('the Ethereum address is invalid or differs from the proof')
  if (!isValidBitcoinAddress(btc) || btc !== wallet.proof?.bitcoin?.address) throw new Error('the Bitcoin address is invalid or differs from the proof')
  const check = checkProof(wallet.proof, pubFromPem(await readFile(PATHS.pem, 'utf8')))
  if (!check.ethOk || !check.btcOk) throw new Error('the signed proof does not verify for these addresses')
  return wallet
}

export const copyScript = String.raw`<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]'); if (!b) return;
  var text = b.getAttribute('data-copy');
  var done = function (ok) { var old = b.textContent; b.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(function () { b.textContent = old; }, 1800); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); }); else done(false);
});
(function () {
  var box = document.querySelector('[data-pay-eth]');
  if (!box) return;
  var to = box.getAttribute('data-pay-eth');
  var input = box.querySelector('input'), btn = box.querySelector('button'), msg = box.querySelector('.pay-msg');
  var say = function (t) { msg.textContent = t; };
  var toWeiHex = function (t) {
    if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
    var p = t.split('.');
    var wei = BigInt(p[0]) * 10n ** 18n + BigInt((p[1] || '').padEnd(18, '0'));
    if (wei <= 0n || wei > 100n * 10n ** 18n) return null;
    return '0x' + wei.toString(16);
  };
  if (!window.ethereum) say('No browser wallet found here. Use "Open in wallet" or copy the address.');
  btn.addEventListener('click', async function () {
    var value = toWeiHex(String(input.value).trim());
    if (!value) { say('Enter an amount in ETH, for example 0.01 (up to 100).'); return; }
    if (!window.ethereum) { say('No browser wallet found here. Use "Open in wallet" or copy the address.'); return; }
    try {
      var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
      var hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: accounts[0], to: to, value: value }] });
      say('Sent. Transaction ' + hash + '. Thank you.');
    } catch (err) {
      say(err && err.code === 4001 ? 'Cancelled in the wallet. Nothing was sent.' : 'The wallet could not send it. Nothing was sent.');
    }
  });
})();
</script>`

const styles = `<style>
    .donate-row { display: grid; gap: 6px; padding: 14px 0; border-top: 1px solid var(--line, #d8d2c4); }
    .donate-row:first-of-type { border-top: 0; }
    .donate-row .label { font: 700 12px/1.4 Consolas, monospace; text-transform: uppercase; color: var(--green, #2f6f4f); }
    .donate-row code { display: block; padding: 10px 12px; background: rgba(127,127,127,.12); border-radius: 6px; font: 15px/1.5 Consolas, monospace; overflow-wrap: anywhere; user-select: all; }
    .donate-row .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .donate-row button, .donate-row a.uri { font: inherit; padding: 6px 12px; border: 1px solid var(--line, #bbb); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; text-decoration: none; }
    .donate-note { color: var(--muted, #666); font-size: 14px; }
    .pay-eth { display: grid; gap: 8px; padding: 14px 0; border-top: 1px solid var(--line, #d8d2c4); }
    .pay-eth .label { font: 700 12px/1.4 Consolas, monospace; text-transform: uppercase; color: var(--green, #2f6f4f); }
    .pay-eth .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .pay-eth input { font: inherit; padding: 6px 10px; border: 1px solid var(--line, #bbb); border-radius: 6px; background: transparent; color: inherit; max-width: 100%; }
    .pay-eth button { font: inherit; padding: 6px 12px; border: 1px solid var(--line, #bbb); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  </style>`

function rows(w) {
  return `<div class="donate-row">
        <span class="label">Bitcoin (BTC), native SegWit</span>
        <code id="btc-address">${w.bitcoin.address}</code>
        <div class="actions"><button type="button" data-copy="${w.bitcoin.address}">Copy address</button><a class="uri" href="bitcoin:${w.bitcoin.address}">Open in wallet</a></div>
      </div>
      <div class="donate-row">
        <span class="label">Ethereum (ETH), Ethereum mainnet</span>
        <code id="eth-address">${w.ethereum.address}</code>
        <div class="actions"><button type="button" data-copy="${w.ethereum.address}">Copy address</button><a class="uri" href="ethereum:${w.ethereum.address}">Open in wallet</a></div>
      </div>
      <div class="pay-eth" data-pay-eth="${w.ethereum.address}">
        <span class="label">Or pay with a browser wallet (Ethereum mainnet)</span>
        <div class="actions"><input type="text" inputmode="decimal" placeholder="Amount in ETH, e.g. 0.01" aria-label="Amount in ETH" size="24"><button type="button">Send from my wallet</button></div>
        <p class="donate-note pay-msg" role="status"></p>
      </div>
      <div class="wallet-links">
        <p class="donate-note">Check the balances yourself: ${ext(explorerLinks(w).bitcoin, 'Bitcoin address on mempool.space')} &middot; ${ext(explorerLinks(w).ethereum, 'Ethereum address on Etherscan')}.</p>
        <details><summary>Do not have a wallet yet?</summary>
          <p class="donate-note">${LINKS.apps.map((a) => `${ext(a.url, a.name)} (${a.about})`).join(' &middot; ')}. Guides: ${LINKS.guides.map((g) => ext(g.url, g.name)).join(' &middot; ')}. These are plain links to other sites, not endorsements; RabbitSoftware has no affiliation with them and gets nothing if you use them. Never share your seed phrase or recovery words with anyone.</p>
        </details>
      </div>`
}

/** The app imports the same public data as a typed module. Generated; not edited by hand. */
export function appModule(json, open = DONATIONS_OPEN) {
  return `// Generated by rabbitsoftware-cloudflare/workers/wallet/build-donate.mjs from wallet.json. Public data only. Do not edit by hand.
// DONATIONS_OPEN comes from workers/wallet/donations.json; the app hides the Donate card, link and page while it is false.
export const DONATIONS_OPEN = ${open}
export const WALLET = ${json.trim()} as const
`
}

export function donatePage(w) {
  const p = w.proof
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Support RabbitSoftware with a voluntary Bitcoin or Ethereum donation. Addresses, safety notes and how to verify them.">
  <title>Donate | RabbitSoftware</title>
  <link rel="icon" type="image/svg+xml" href="assets/rabbit-mark.svg">
  <link rel="stylesheet" href="polish.css?v=bio-photo-1">
  ${styles}
</head>
<body class="document-page">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="top wrap">
    <a class="brand" href="index.html"><img src="assets/rabbit-mark.svg" width="34" height="34" alt="">RabbitSoftware</a>
    <a class="back" href="index.html">Back to project overview</a>
  </header>
  <main class="document-main wrap" id="main">
    <p class="eyebrow">Support the work</p>
    <h1>Donate</h1>
    <p>RabbitSoftware is independent research tooling. Donations are voluntary gifts toward its running costs, such as hosting and development. They are not investments, they buy no goods or services, and they are not tax-deductible unless this page says so.</p>
    <p>Learn what you would be supporting: <a href="story.html">why RabbitSoftware exists</a>, <a href="blockchain.html">how the chain works and how to check it</a>, and the <a href="press.html">press kit</a>.</p>

    <section aria-labelledby="addresses-title">
      <h2 id="addresses-title">Addresses</h2>
      ${rows(w)}
      <p class="donate-note">Send Bitcoin only to the Bitcoin address, and ETH only on Ethereum mainnet to the Ethereum address. Tokens or coins sent on other networks, or to the wrong address, can be lost for good. Blockchain transactions cannot be reversed. For a first donation, send a small test amount, and check the first and last six characters of the address in your wallet against this page.</p>
    </section>

    <section aria-labelledby="verify-title">
      <h2 id="verify-title">Check that these addresses are ours</h2>
      <p>Both addresses come from one key that lives inside a Google Cloud hardware security module (HSM). Its private key cannot be exported or read by anyone. To prove control, that key signed this message:</p>
      <p><code>${p.message}</code></p>
      <p>Ethereum signature (paste the address, message and signature into any Ethereum &ldquo;verify message&rdquo; tool, for example the one on Etherscan):</p>
      <p><code>${p.ethereum.signature}</code></p>
      <p>The same public key (compressed, hex) gives both addresses: <code>${w.key.publicKeyCompressed}</code>. The full public record is in <a href="wallet.json">wallet.json</a>.</p>
      <p class="donate-note">Our public chains are also anchored to Bitcoin through OpenTimestamps. The proofs are listed in the <a href="${ANCHORS}">anchor index</a> and can be checked with the standard <code>ots verify</code> tool. An anchor proves that a document existed by a given Bitcoin block; it does not prove the document is true.</p>
    </section>
  </main>
  <footer class="wrap"><div class="footer-inner"><p class="footer-brand">RabbitSoftware</p><p class="footer-note">Not a clinical product. Not financial advice.</p></div></footer>
  ${copyScript}
</body>
</html>
`
}

export function frontBlock(w) {
  return `<!-- donate:start (generated by workers/wallet/build-donate.mjs from wallet.json; do not edit by hand) -->
    <section class="section wrap" id="donate" aria-labelledby="donate-title">
      <div class="section-head">
        <span class="section-index">07 / SUPPORT</span>
        <div>
          <h2 id="donate-title">Support the work.</h2>
          <p class="section-intro">Voluntary donations help pay for hosting and development. Send only Bitcoin to the Bitcoin address and ETH on Ethereum mainnet to the Ethereum address.</p>
        </div>
      </div>
      ${rows(w)}
      <p class="donate-note"><a href="donate.html">How to verify these addresses and what to know before sending</a></p>
    </section>
    <!-- donate:end -->`
}

export function patchIndex(html, w, open = DONATIONS_OPEN) {
  const re = /<!-- donate:start[\s\S]*?<!-- donate:end -->/
  if (!open) return html.replace(re, '<!-- donate:start (donations are paused; see workers/wallet/donations.json) -->\n    <!-- donate:end -->')
  const block = frontBlock(w)
  const OLD_STYLE = /<style>\s*\.donate-row[\s\S]*?<\/style>/
  const OLD_SCRIPT = /<script>\s*document\.addEventListener\('click', function \(e\) \{\s*var b = e\.target\.closest\('\[data-copy\]'\)[\s\S]*?<\/script>/
  const withStyles = (h) => (OLD_STYLE.test(h) ? h.replace(OLD_STYLE, () => styles) : h.replace('</head>', () => `  ${styles}\n</head>`))
  const withScript = (h) => (OLD_SCRIPT.test(h) ? h.replace(OLD_SCRIPT, () => copyScript) : h.replace('</body>', () => `${copyScript}\n</body>`))
  let out = re.test(html) ? html.replace(re, () => block) : html.replace('  </main>', () => `    ${block}\n  </main>`)
  if (!out.includes('id="donate"')) throw new Error('could not place the donate block in index.html')
  return withScript(withStyles(out))
}

// Pages added to the sitemap once. Existing entries (and their dates) are never rewritten.
const SITEMAP_PAGES = ['donate.html', 'story.html', 'blockchain.html', 'press.html']
export function patchSitemap(xml, open = DONATIONS_OPEN) {
  const today = new Date().toISOString().slice(0, 10)
  let out = xml
  if (!open) return out.split('\n').filter((line) => !line.includes('/donate.html<')).join('\n')
  for (const page of SITEMAP_PAGES) {
    if (out.includes(`/${page}<`)) continue
    out = out.replace('</urlset>', `  <url><loc>https://rabbitsoftware.io/${page}</loc><lastmod>${today}</lastmod></url>\n</urlset>`)
  }
  return out
}

export function appLinksModule() {
  return `// Generated by rabbitsoftware-cloudflare/workers/wallet/build-donate.mjs from wallet-links.json. Public data only. Do not edit by hand.
export const WALLET_LINKS = ${JSON.stringify({ apps: LINKS.apps, guides: LINKS.guides }, null, 2)} as const
`
}

async function main() {
  const check = process.argv.includes('--check')
  const w = await loadVerified()
  const publicWallet = JSON.stringify(w, null, 2) + '\n'
  const files = [
    ...(DONATIONS_OPEN ? [[PATHS.site + 'donate.html', donatePage(w)], [PATHS.site + 'wallet.json', publicWallet]] : []),
    [PATHS.app, appModule(publicWallet)],
    [PATHS.appLinks, appLinksModule()],
    [PATHS.site + 'index.html', patchIndex(await readFile(PATHS.site + 'index.html', 'utf8'), w)],
    [PATHS.site + 'sitemap.xml', patchSitemap(await readFile(PATHS.site + 'sitemap.xml', 'utf8'))],
  ]
  let stale = 0
  for (const [path, content] of files) {
    let current = null
    try { current = await readFile(path, 'utf8') } catch { /* not there yet */ }
    if (current === content) continue
    stale++
    if (check) console.error(`out of date: ${path}`)
    else { await writeFile(path, content); console.log(`wrote ${path}`) }
  }
  if (!DONATIONS_OPEN) {
    for (const name of ['donate.html', 'wallet.json']) {
      let there = true
      try { await readFile(PATHS.site + name) } catch { there = false }
      if (!there) continue
      stale++
      if (check) console.error(`should not exist while donations are paused: ${PATHS.site + name}`)
      else { await rm(PATHS.site + name); console.log(`removed ${PATHS.site + name}`) }
    }
  }
  if (check && stale) process.exit(1)
  console.log(check ? 'all generated files are up to date' : `done (${stale} file(s) changed)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error('STOPPED: ' + e.message); process.exit(1) })
