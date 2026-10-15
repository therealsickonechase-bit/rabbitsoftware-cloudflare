// SVG maps for the report. They use CSS classes (.m-*) that the report page defines from its color tokens, so they follow light and dark themes.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Point on the border of rectangle r in the direction of (tx, ty). */
function anchor(r, tx, ty) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const s = Math.min(dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity)
  return [cx + dx * s, cy + dy * s]
}

// ---------------------------------------------------------------- platform map

const N = (key, x, y, w, h, label, sub, status) => ({ key, x, y, w, h, label, sub, status })
const GROUPS = [
  { x: 196, y: 16, w: 332, h: 340, label: 'Cloudflare' },
  { x: 540, y: 16, w: 412, h: 440, label: 'Google Cloud' },
  { x: 16, y: 392, w: 512, h: 100, label: "Owner's computer" },
]

/** @param platform result of checkPlatform() */
export function platformMap(platform) {
  const st = (k) => (k === null ? 'unk' : platform.nodes[k]?.ok ? 'ok' : 'bad')
  const nodes = [
    N('visitors', 16, 200, 150, 64, 'Visitors', 'browsers and AI assistants', 'neutral'),
    N('site', 212, 56, 300, 50, 'rabbitsoftware.io', 'Cloudflare Pages', st('site')),
    N('app', 212, 126, 300, 50, 'app.rabbitsoftware.io', 'RabbitOS on Cloudflare Workers', st('app')),
    N('shellWorker', 212, 196, 300, 50, 'Guest shell gate', 'Worker: human check and quotas', st('shellWorker')),
    N('r2', 212, 266, 300, 50, 'R2 buckets (6)', 'chain mirror, sync, vault', 'unk'),
    N('database', 212, 324, 300, 26, 'Supabase', 'system of record', st('supabase')),
    N('shellService', 556, 56, 188, 56, 'Visitor shell', 'Cloud Run, one visitor each', st('shellService')),
    N('proxy', 760, 56, 176, 56, 'Allowlist proxy', 'VM running Squid', 'unk'),
    N('hub', 556, 136, 188, 56, 'Hub MCP', 'Cloud Run, read-only', st('hub')),
    N('standby', 760, 136, 176, 56, 'Standby website', 'Cloud Run', st('standby')),
    N('mirror', 556, 216, 188, 56, 'App mirror', 'Cloud Run', st('mirror')),
    N('ledgerBucket', 760, 216, 176, 56, 'Public ledger', 'bucket, world-readable', st('ledgerBucket')),
    N('backups', 556, 296, 188, 56, 'Private backups', 'bucket, versioned', 'unk'),
    N('obs', 760, 296, 176, 56, 'Logs and metrics', 'BigQuery, dashboard', 'unk'),
    N('qa', 556, 376, 188, 56, 'Weekly audit', 'Workflows and Cloud Run job', 'unk'),
    N('internet', 760, 376, 176, 56, 'Allowed internet', '13 named hosts only', 'neutral'),
    N('pc', 32, 424, 232, 54, 'Maxwell chain and agents', 'research-agents, local files', 'neutral'),
    N('cli', 280, 424, 232, 54, 'Gemini CLI and Claude', 'use the hub from here', 'neutral'),
  ]
  const by = Object.fromEntries(nodes.map((n) => [n.key, n]))
  const edges = [
    ['visitors', 'site'], ['visitors', 'app'], ['visitors', 'shellWorker', 'terminal'],
    ['app', 'database', 'data'], ['shellWorker', 'shellService', 'WebSocket'], ['shellService', 'proxy', 'only exit'], ['proxy', 'internet'],
    ['hub', 'app', 'reads public data'], ['hub', 'ledgerBucket', 'reads mirror'], ['cli', 'hub', 'MCP'],
    ['pc', 'app', 'signed ingest'], ['pc', 'backups', 'daily backup'], ['pc', 'ledgerBucket', 'chain mirror'],
    ['qa', 'site', 'audits'], ['obs', 'shellService', 'logs'],
  ]
  const parts = []
  for (const g of GROUPS) parts.push(`<rect class="m-group" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="6"/><text class="m-group-label" x="${g.x + 12}" y="${g.y + 20}">${esc(g.label)}</text>`)
  for (const [a, b, label] of edges) {
    const A = by[a], B = by[b]
    if (!A || !B) continue
    const [x1, y1] = anchor(A, B.x + B.w / 2, B.y + B.h / 2), [x2, y2] = anchor(B, A.x + A.w / 2, A.y + A.h / 2)
    parts.push(`<line class="m-edge" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" marker-end="url(#arrow)"/>`)
    if (label) parts.push(`<text class="m-edge-label" x="${((x1 + x2) / 2).toFixed(1)}" y="${((y1 + y2) / 2 - 4).toFixed(1)}" text-anchor="middle">${esc(label)}</text>`)
  }
  for (const n of nodes) {
    const node = platform.nodes[n.key]
    const tip = node ? `${n.label}: ${node.ok ? 'up' : 'not answering'}${node.status ? ` (HTTP ${node.status}, ${node.ms} ms)` : ''}` : `${n.label}: ${n.status === 'unk' ? 'not checked from outside' : ''}`
    const compact = n.h < 40
    parts.push(`<g class="m-node m-${n.status}"><title>${esc(tip)}</title><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5"/>`
      + `<circle class="m-dot" cx="${n.x + n.w - 14}" cy="${n.y + (compact ? n.h / 2 : 16)}" r="5"/>`
      + `<text class="m-label" x="${n.x + 12}" y="${n.y + (compact ? n.h / 2 + 4 : 22)}">${esc(n.label)}${compact ? ` <tspan class="m-sub">${esc(n.sub)}</tspan>` : ''}</text>`
      + (compact ? '' : `<text class="m-sub" x="${n.x + 12}" y="${n.y + 40}">${esc(n.sub)}</text>`) + '</g>')
  }
  return `<svg class="map" viewBox="0 0 968 512" role="img" aria-label="Map of the RabbitOS platform: Cloudflare, Google Cloud, the owner's computer and how they connect" xmlns="http://www.w3.org/2000/svg">`
    + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-arrow" d="M0,1 L9,5 L0,9 Z"/></marker></defs>'
    + parts.join('') + '</svg>'
}

// ---------------------------------------------------------------- site map

const SEV_CLASS = { high: 'bad', medium: 'warn', low: 'low' }
const short = (url) => {
  try { const u = new URL(url); const seg = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop(); return (seg ?? 'home').slice(0, 16) } catch { return url.slice(0, 16) }
}

/** @param pages crawled pages  @param severity Map(url -> worst severity) */
export function siteMap(pages, severity) {
  const WIDTH = 940, ROW = 118
  const panels = []
  let y0 = 0
  for (const origin of [...new Set(pages.map((p) => { try { return new URL(p.url).origin } catch { return '' } }))].filter(Boolean)) {
    const mine = pages.filter((p) => p.url.startsWith(origin))
    const maxDepth = Math.max(...mine.map((p) => p.depth))
    const rows = Array.from({ length: maxDepth + 1 }, (_, d) => mine.filter((p) => p.depth === d))
    const pos = new Map()
    rows.forEach((row, d) => row.forEach((p, i) => pos.set(p.url, [40 + ((i + 1) * (WIDTH - 80)) / (row.length + 1), y0 + 74 + d * ROW])))
    const out = [`<text class="m-group-label" x="16" y="${y0 + 22}">${esc(origin.replace('https://', ''))}</text><text class="m-sub" x="16" y="${y0 + 40}">${mine.length} page${mine.length === 1 ? '' : 's'} visited, linked from the home page outward</text>`]
    for (const p of mine) {
      if (!p.from || !pos.has(p.from)) continue
      const [x1, y1] = pos.get(p.from), [x2, y2] = pos.get(p.url)
      out.push(`<line class="m-edge" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`)
    }
    for (const p of mine) {
      const [x, y] = pos.get(p.url)
      const broken = p.status >= 400 || p.status === 0
      const cls = broken ? 'bad' : (SEV_CLASS[severity.get(p.url)] ?? 'ok')
      const tip = `${p.url} — ${broken ? `error ${p.status || 'no answer'}` : `HTTP ${p.status}, ${p.ms} ms`}${severity.get(p.url) ? `, worst issue: ${severity.get(p.url)}` : ', no issues'}${p.title ? ` — ${p.title}` : ''}`
      out.push(`<g class="m-node m-${cls}"><title>${esc(tip)}</title><circle class="m-page" cx="${x.toFixed(1)}" cy="${y}" r="${p.depth === 0 ? 11 : 8}"/>${broken ? `<text class="m-x" x="${x.toFixed(1)}" y="${y + 4}" text-anchor="middle">×</text>` : ''}`
        + `<text class="m-page-label" transform="translate(${(x + 7).toFixed(1)},${y - 12}) rotate(-42)">${esc(short(p.url))}</text></g>`)
    }
    panels.push(out.join(''))
    y0 += (maxDepth + 1) * ROW + 64
  }
  return `<svg class="map" viewBox="0 0 ${WIDTH} ${Math.max(y0, 120)}" role="img" aria-label="Map of the pages visited on each site, as a tree from the home page, colored by the worst issue found" xmlns="http://www.w3.org/2000/svg">${panels.join('')}</svg>`
}

/** The most linked-to pages, for the list under the site map. */
export function mostLinked(linkTargets, limit = 8) {
  return Object.entries(linkTargets).map(([url, from]) => ({ url, count: from.length })).sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)).slice(0, limit)
}
