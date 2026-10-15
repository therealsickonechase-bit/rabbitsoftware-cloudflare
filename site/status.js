// Live status page. Reads the public feed that the Google Cloud recorder writes every five minutes, draws it, and re-reads it every minute, so a change shows up without a reload.
// The feed holds only public facts. If it cannot be read, the page says so and keeps the last picture it had.
import { publicPlatformMap } from './status-map.mjs'
import { ageText, freshness, overall, strip, uptimePercent } from './status-view.mjs'

const BASE = 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status'
const REFRESH_MS = 60_000
let feed = null, history = []

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }

async function getJson(name) {
  const res = await fetch(`${BASE}/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function renderHeadline() {
  const o = overall(feed)
  const box = $('headline')
  box.className = `headline ${o.state}`
  $('headline-text').textContent = o.text
  if (feed) {
    const f = freshness(feed.generatedAt)
    $('when').textContent = `Updated ${ageText(feed.generatedAt)}${f === 'late' ? ' (later than usual)' : ''}. Checked every 5 minutes; this page re-reads every minute.`
    $('when').className = f === 'live' ? 'small' : 'small warn'
  }
}

function renderServices() {
  const list = $('services')
  list.replaceChildren()
  for (const s of feed.services) {
    const index = feed.services.indexOf(s)
    const row = el('li')
    const name = el('span', 'name')
    name.append(el('span', `dot ${s.ok ? 'ok' : 'bad'}`), el('span', null, s.label))
    const bar = el('span', 'strip')
    bar.setAttribute('role', 'img')
    const pct = uptimePercent(history, index)
    bar.setAttribute('aria-label', pct === null ? 'No history yet' : `${pct} percent of checks in the last 24 hours found this answering`)
    for (const state of strip(history, index)) bar.append(el('i', `tick ${state}`))
    const meta = el('span', 'meta', `${s.ok ? 'Answering' : 'Not answering'}${pct === null ? '' : ` · ${pct}% over 24 h`}${s.ok && s.ms ? ` · ${s.ms} ms` : ''}`)
    row.append(name, bar, meta)
    list.append(row)
  }
}

function renderChain() {
  const c = feed.chain
  $('chain').textContent = c.agree
    ? `The public chain has ${c.app?.length ?? '?'} blocks, and the copy kept in Google Cloud agrees with the app (head ${c.app?.head ?? '?'}…).`
    : `The chain copies do not agree: the app reports ${c.app?.length ?? 'no'} blocks, the Google Cloud copy ${c.mirror?.length ?? 'none'}. The operator is alerted.`
  $('chain').className = c.agree ? '' : 'warn'
}

function renderTree() {
  const root = $('tree')
  root.replaceChildren()
  for (const d of feed.tree ?? []) {
    const details = el('details')
    const summary = el('summary')
    summary.append(el('span', 'tname', d.title), el('span', 'count', `${d.rows.toLocaleString()} rows`))
    details.append(summary)
    const cols = el('ul', 'cols')
    for (const c of d.columns) cols.append(el('li', null, c))
    details.append(cols)
    root.append(details)
  }
  if (!root.children.length) root.append(el('p', 'small', 'No datasets reported.'))
}

function render() {
  renderHeadline()
  if (!feed) return
  $('map').innerHTML = publicPlatformMap(feed)    // built from escaped values only (see status-map.mjs)
  renderServices()
  renderChain()
  renderTree()
}

async function load() {
  try {
    const [latest, hist] = await Promise.all([getJson('latest.json'), getJson('history.json').catch(() => history)])
    feed = latest; history = hist
    $('error').hidden = true
  } catch (error) {
    console.error('Status feed could not be read', error)
    $('error').hidden = false
    $('error').textContent = feed ? 'The status feed could not be read just now. Showing the last report received.' : 'The status feed could not be read. The services may still be fine; use the direct check below.'
  }
  render()
}

// Keep "Updated N minutes ago" honest between reloads.
setInterval(renderHeadline, 15_000)
setInterval(load, REFRESH_MS)
load()

// The direct check from before: ask the hosted console now, from this browser.
$('check').addEventListener('click', () => {
  const out = $('direct'); $('check').disabled = true; out.textContent = 'Checking…'
  fetch('https://app.rabbitsoftware.io/api/health', { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json().then((d) => ({ http: r.status, d })))
    .then(({ http, d }) => { out.textContent = http === 200 ? `The console answered (database ${d.checks?.database === 'ok' ? 'ok' : 'unknown'}, ${d.database_ms} ms) at ${new Date().toLocaleTimeString()}.` : `The console answered with HTTP ${http}.` })
    .catch(() => { out.textContent = 'The console did not answer from this browser.' })
    .finally(() => { $('check').disabled = false })
})
