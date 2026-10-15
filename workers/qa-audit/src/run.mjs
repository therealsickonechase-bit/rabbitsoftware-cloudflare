// Runs the audit and writes the report.
//   node src/run.mjs --out ./out                 write report.html and report.json here
//   node src/run.mjs --fragment page.html        also write the report as page content (for publishing as an Artifact)
//   REPORT_BUCKET=my-bucket node src/run.mjs     also upload to Cloud Storage (uses the Cloud Run job's own identity)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { analyze, crawl, siteChecks } from './audit.mjs'
import { checkPlatform } from './platform.mjs'
import { renderReport } from './report.mjs'
import { uploadObject } from './gcs.mjs'

/** The Supabase tree exported from the repository's migrations (scripts/export-supabase-tree.mjs in rabbit-web). Optional: the report simply leaves the section out without it. */
export async function loadSupabaseTree(url = new URL('../data/supabase-tree.json', import.meta.url)) {
  try { const tree = JSON.parse(await readFile(url, 'utf8')); return Array.isArray(tree.tables) ? tree : null } catch { return null }
}

export async function buildReport({ fetchImpl = fetch, maxPages = 60, now = () => new Date(), supabaseTree = null } = {}) {
  const started = Date.now()
  const [crawlResult, platform] = await Promise.all([crawl({ fetchImpl, maxPages }), checkPlatform({ fetchImpl })])
  const checks = await siteChecks({ crawlResult, fetchImpl })
  const analysis = analyze(crawlResult, checks)
  return {
    generatedAt: now().toISOString(), durationMs: Date.now() - started, maxPages,
    summary: { score: analysis.score, counts: analysis.counts, pagesAudited: analysis.pagesAudited, pagesTotal: analysis.pagesTotal },
    findings: analysis.findings, pages: crawlResult.pages, linkTargets: crawlResult.linkTargets, platform, supabaseTree,
  }
}

/** The small summary other tools read (the workflow, the hub): no page bodies, no maps. */
export function summaryOf(data) {
  return {
    generatedAt: data.generatedAt, score: data.summary.score, ...data.summary.counts, pagesAudited: data.summary.pagesAudited,
    servicesUp: data.platform.up, servicesTotal: data.platform.total, chainAgrees: data.platform.chain.agree,
    top: data.findings.slice(0, 5).map((f) => ({ severity: f.severity, title: f.title, places: f.pages.length })),
  }
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const out = arg('--out') ?? './out'
  const data = await buildReport({ maxPages: Number(arg('--max-pages')) || 60, supabaseTree: await loadSupabaseTree() })
  if (data.summary.pagesAudited === 0) { console.error(JSON.stringify({ event: 'qa_failed', reason: 'no pages could be read' })); process.exit(1) }
  const html = renderReport(data, { standalone: true })
  const summary = summaryOf(data)
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'report.html'), html)
  await writeFile(join(out, 'report.json'), JSON.stringify({ ...summary, findings: data.findings, platform: { up: data.platform.up, total: data.platform.total, chain: data.platform.chain, data: data.platform.data, nodes: data.platform.nodes } }, null, 1))
  if (arg('--fragment')) await writeFile(arg('--fragment'), renderReport(data, { standalone: false }))
  const bucket = process.env.REPORT_BUCKET
  if (bucket) {
    const day = data.generatedAt.slice(0, 10).replaceAll('-', '/')
    const files = [[`${day}/report.html`, html, 'text/html; charset=utf-8'], [`${day}/report.json`, JSON.stringify(summary), 'application/json'],
      ['latest.html', html, 'text/html; charset=utf-8'], ['latest.json', JSON.stringify(summary), 'application/json']]
    for (const [name, body, type] of files) await uploadObject({ bucket, name, body, contentType: type })
  }
  // One structured line: Cloud Logging turns it into fields, and the workflow and alerts read them.
  console.log(JSON.stringify({ event: 'qa_report', score: summary.score, high: summary.high, medium: summary.medium, low: summary.low, pages: summary.pagesAudited,
    services_up: summary.servicesUp, services_total: summary.servicesTotal, chain_agrees: summary.chainAgrees, uploaded: !!bucket }))
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('run.mjs')) {
  main(process.argv.slice(2)).catch((error) => { console.error(JSON.stringify({ event: 'qa_failed', reason: error instanceof Error ? error.name : 'error' })); process.exit(1) })
}
