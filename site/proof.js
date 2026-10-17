// proof.html: reads the two public files the Google Cloud status job writes (see proof-view.mjs) and draws them, re-reading every minute, so a new anchor appears without deploying the website.
// Everything is drawn as plain text nodes; links go only to the project's public bucket, mempool.space and known research hosts. If a file cannot be read the page says so.
import { DIGEST_URL, PROOF_URL, WITNESS_URL, digestView, proofView, witnessView } from './proof-view.mjs'

const REFRESH_MS = 60_000
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
const link = (href, text) => { const a = el('a', null, text); a.href = href; a.rel = 'noopener noreferrer'; return a }
let proof = null, digest = null, witness = null

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function render() {
  const v = proofView(proof)
  $('proof-when').textContent = v.when
  $('proof-when').className = v.state === 'ok' ? 'small' : 'small warn'
  $('proof-headline').textContent = v.headline
  $('proof-witnesses').textContent = v.witnesses.length ? `Witnessed by: ${v.witnesses.join(' and ')}.` : ''
  $('proof-notyet').textContent = v.notYet.length ? `Not switched on yet: ${v.notYet.join(' and ')}. They need a small amount of funds, and the proofs above do not.` : ''
  $('proof-heads').textContent = v.heads ? `Newest anchor covers ledger length ${v.heads.ledgerLength ?? '?'} and Maxwell block ${v.heads.maxwellIndex ?? '?'}.` : ''
  const list = $('proof-list')
  list.replaceChildren()
  for (const a of v.anchors) {
    const li = el('li')
    const top = el('div', 'row')
    top.append(el('span', `dot ${a.state}`), el('strong', null, a.id), el('span', `verdict ${a.state}`, a.verdict))
    const meta = el('div', 'meta')
    if (a.block) { meta.append('Bitcoin block ', link(a.blockLink, String(a.block)), ' · ') }
    meta.append('files: ', link(a.files.anchor, 'anchor.json'), ' · ', link(a.files.proof, 'proof (.ots)'))
    if (a.files.tsa) meta.append(' · ', link(a.files.tsa, 'timestamp (.tsr)'))
    if (a.checked) meta.append(` · checked ${a.checked}`)
    li.append(top, meta)
    if (a.detail) li.append(el('div', 'detail', a.detail))
    list.append(li)
  }
  const wv = witnessView(witness)
  $('witness-headline').textContent = wv.headline
  $('witness-when').textContent = wv.when
  $('witness-rule').textContent = wv.rule
  const wlist = $('witness-list')
  wlist.replaceChildren()
  for (const w of wv.rows) {
    const li = el('li')
    const top = el('div', 'row')
    top.append(el('span', `dot ${w.state}`), el('strong', null, w.name), el('span', `verdict ${w.state}`, w.status))
    li.append(top, el('div', 'meta', `${w.kind} · key ${w.keyId}${w.size ? ` · checked ${w.size} blocks` : ''}${w.signed ? ` · signed ${w.signed}` : ''}${w.note ? ` · ${w.note}` : ''}`))
    wlist.append(li)
  }
  const d = digestView(digest)
  $('digest-text').textContent = d.text
  $('digest-stats').textContent = d.stats.join(' · ')
  const recent = $('digest-recent')
  recent.replaceChildren()
  for (const r of d.newest) {
    const li = el('li')
    if (r.link) li.append(link(r.link, r.title)); else li.append(el('span', null, r.title))
    li.append(el('small', null, ` ${r.source}${r.ago ? ` · first seen ${r.ago}` : ''}`))
    recent.append(li)
  }
}

async function load() {
  const [a, b, c] = await Promise.allSettled([getJson(PROOF_URL), getJson(DIGEST_URL), getJson(WITNESS_URL)])
  if (a.status === 'fulfilled') proof = a.value
  if (b.status === 'fulfilled') digest = b.value
  if (c.status === 'fulfilled') witness = c.value
  render()
}

load()
setInterval(load, REFRESH_MS)
setInterval(render, 15_000)      // keeps "N minutes ago" honest between reads
