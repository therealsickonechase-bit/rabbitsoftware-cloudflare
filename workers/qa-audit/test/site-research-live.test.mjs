import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DNA_URL, LIVE_URL, dnaView, liveView, safeLink } from '../../../site/research-live-view.mjs'

const NOW = Date.parse('2026-10-16T20:00:00Z')
const live = (over = {}) => ({
  version: 1, generatedAt: '2026-10-16T19:57:00Z', lastReportAt: '2026-10-16T19:50:00Z', total: 922,
  bySource: { pubmed: 268, europepmc: 279, trial: 164, clinvar: 211, brain_paper: 95 },
  topics: { explored: 42, queued: 7 },
  recent: [
    { id: 'article:1', source: 'pubmed', title: 'A new paper on ATM', url: 'https://pubmed.ncbi.nlm.nih.gov/1/', seenAt: '2026-10-16T19:42:00Z' },
    { id: 'x:2', source: 'nih_grant', title: 'A grant', url: 'https://evil.example.com/steal', seenAt: null },
  ],
  ...over,
})
const dna = (over = {}) => ({ version: 1, updatedAt: '2026-10-16T19:00:00Z', indexBuiltAt: '2026-10-16T16:00:00Z', genes: 32, variants: 6071, kmers: 345209, root: 'e1c6c44f2089ae1b65c8', researchRecordsChecked: 827, variantMentions: 2, guidesChecked: 256, guidesFlagged: 6, coverageGaps: ['APC', 'MSH6'], ...over })

test('the files are read from the public status bucket', () => {
  assert.equal(LIVE_URL, 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/research-live.json')
  assert.equal(DNA_URL, 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/dna-live.json')
})

test('a fresh file shows the sources largest first, the topics and the newest records with their age', () => {
  const v = liveView(live(), NOW)
  assert.equal(v.state, 'ok')
  assert.match(v.when, /The agents last reported 10 minutes ago/)
  assert.deepEqual(v.sources.map((s) => s.label), ['Europe PMC', 'PubMed', 'ClinVar', 'Trials', 'Brain / EEG papers'])
  assert.equal(v.sources[0].pct, 100)
  assert.ok(v.sources.every((s) => s.pct >= 2 && s.pct <= 100))
  assert.equal(v.total, 922)
  assert.equal(v.topics, '42 topics explored, 7 queued.')
  assert.equal(v.recent[0].ago, '18 minutes ago')
})

test('only known research sites become links; anything else is shown as plain text', () => {
  const v = liveView(live(), NOW)
  assert.equal(v.recent[0].link, 'https://pubmed.ncbi.nlm.nih.gov/1/')
  assert.equal(v.recent[1].link, null)
  for (const ok of ['https://europepmc.org/article/MED/1', 'https://clinicaltrials.gov/study/NCT1', 'https://www.ncbi.nlm.nih.gov/clinvar/variation/1/', 'https://doi.org/10.1/x', 'https://reporter.nih.gov/x']) assert.ok(safeLink(ok), ok)
  for (const bad of ['http://pubmed.ncbi.nlm.nih.gov/1/', 'javascript:alert(1)', 'https://nih.gov.evil.com/x', 'https://user:pw@pubmed.ncbi.nlm.nih.gov/1/', 'data:text/html,x', 'not a url', '']) assert.equal(safeLink(bad), null, bad)
})

test('an old file says so, a quiet agent is not an outage, and a missing or malformed file shows nothing', () => {
  const stale = liveView(live({ generatedAt: '2026-10-16T17:00:00Z' }), NOW)
  assert.equal(stale.state, 'stale')
  assert.match(stale.when, /may be out of date/)
  const quiet = liveView(live({ lastReportAt: '2026-10-15T10:00:00Z' }), NOW)
  assert.equal(quiet.state, 'quiet')
  assert.match(quiet.when, /not an outage/)
  for (const bad of [null, undefined, {}, { version: 2 }, 'x', { version: 1, bySource: 'no', recent: [] }]) {
    const v = liveView(bad, NOW)
    assert.equal(v.state, 'unknown')
    assert.deepEqual(v.recent, [])
  }
})

test('odd values are tolerated: bad counts are ignored and long titles are cut', () => {
  const v = liveView(live({ bySource: { pubmed: -1, trial: 'x', europepmc: 5 }, recent: [{ title: 'x'.repeat(900), source: 'pubmed', url: null }, { title: '' }] }), NOW)
  assert.deepEqual(v.sources.map((s) => s.key), ['europepmc'])
  assert.equal(v.recent.length, 1)
  assert.equal(v.recent[0].title.length, 220)
})

test('the variant index panel states the counts, the comparison and the genes still to explore, and holds nothing personal', () => {
  const d = dnaView(dna(), NOW)
  assert.match(d.line, /6,071 verified pathogenic or likely pathogenic ClinVar variants in 32 cancer genes/)
  assert.match(d.line, /index e1c6c44f2089/)
  assert.match(d.line, /Compared with 827 public research records: 2 name a known variant/)
  assert.match(d.line, /6 of 256 CRISPR guide candidates also occur in another panel gene \(a flag, not an off-target score\)/)
  assert.match(d.gaps, /APC, MSH6/)
  assert.match(d.stamp, /Index built 4 hours ago, compared 1 hour ago\./)
  assert.match(dnaView(dna({ coverageGaps: [] }), NOW).gaps, /at least one research record/)
  assert.deepEqual(dnaView(dna({ coverageGaps: ['APC', '<script>', 'x'.repeat(30)] }), NOW).gaps.match(/: (.*)\./)[1], 'APC')
  for (const bad of [null, {}, { version: 1 }, dna({ genes: 'x' }), dna({ root: 5 })]) assert.equal(dnaView(bad, NOW), null)
})

test('the page script draws with textContent only, uses ids that exist on the page, and the page has no inline script for it', () => {
  const js = readFileSync(new URL('../../../site/live-research.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../../../site/research.html', import.meta.url), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/.test(js))
  for (const id of new Set([...js.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]))) assert.ok(html.includes(`id="${id}"`), id)
  assert.ok(html.includes('<script type="module" src="live-research.js"></script>'))
  assert.ok(html.includes('href="#live"'))
  const headers = readFileSync(new URL('../../../site/_headers', import.meta.url), 'utf8')
  assert.match(headers, /\/research-live-view\.mjs\s+Content-Type: application\/javascript/)
})
