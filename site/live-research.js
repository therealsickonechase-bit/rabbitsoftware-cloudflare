// "Live from the agents" on research.html. Reads two public files from Google Cloud and draws them, re-reading every minute, so new findings appear without deploying the website.
// Everything is drawn as plain text nodes and links only go to known research hosts (see research-live-view.mjs). If a file cannot be read, the section says so.
import { DNA_URL, LIVE_URL, dnaView, liveView, searchUrl, searchView } from './research-live-view.mjs'

const REFRESH_MS = 60_000
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
let live = null, dna = null

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function render() {
  const v = liveView(live)
  $('live-when').textContent = v.when
  $('live-when').className = v.state === 'ok' ? 'dek' : 'dek warn'
  const list = $('live-recent')
  list.replaceChildren()
  for (const r of v.recent) {
    const li = el('li')
    if (r.link) {
      const a = el('a', null, r.title)
      a.href = r.link
      a.rel = 'noopener noreferrer'
      li.append(a)
    } else li.append(el('span', null, r.title))
    li.append(el('small', null, ` ${r.source}${r.ago ? ` · first seen ${r.ago}` : ''}`))
    list.append(li)
  }
  const bars = $('live-sources')
  bars.replaceChildren()
  for (const s of v.sources) {
    const row = el('div', 'bar-row')
    const track = el('div', 'track')
    const bar = el('div', 'bar')
    bar.style.width = `${s.pct}%`
    track.append(bar)
    row.append(el('span', 'bar-label', s.label), track, el('span', 'bar-label', String(s.count)))
    bars.append(row)
  }
  $('live-topics').textContent = [v.total !== null ? `${v.total.toLocaleString('en-US')} public records in all.` : '', v.topics].filter(Boolean).join(' ')
  const d = dnaView(dna)
  $('live-dna').hidden = !d
  if (d) {
    $('live-dna-line').textContent = d.line
    $('live-dna-stamp').textContent = d.stamp
    $('live-dna-gaps').textContent = d.gaps
  }
}

async function load() {
  const [a, b] = await Promise.allSettled([getJson(LIVE_URL), getJson(DNA_URL)])
  if (a.status === 'fulfilled') live = a.value
  if (b.status === 'fulfilled') dna = b.value
  render()
}

load()
setInterval(load, REFRESH_MS)
setInterval(render, 15_000)      // keeps "N minutes ago" honest between reads

// The search box: asks the public data hub, then marks each hit with its Maxwell coverage using the anchor in research-live.json.
$('live-search')?.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const url = searchUrl($('live-q').value)
  const summary = $('live-search-summary'), list = $('live-search-results')
  list.replaceChildren()
  if (!url) { summary.textContent = 'Type 2 to 120 characters to search.'; return }
  summary.textContent = 'Searching…'
  try {
    const v = searchView(await getJson(url), live)
    summary.textContent = v.summary
    for (const r of v.rows) {
      const li = el('li')
      if (r.link) { const a = el('a', null, r.title); a.href = r.link; a.rel = 'noopener noreferrer'; li.append(a) } else li.append(el('span', null, r.title))
      li.append(el('small', null, ` ${r.source}${r.ago ? ` · first seen ${r.ago}` : ''} · ${r.maxwell}`))
      list.append(li)
    }
  } catch { summary.textContent = 'The search could not be read just now.' }
})
