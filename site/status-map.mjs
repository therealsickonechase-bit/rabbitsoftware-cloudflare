// Map of the PUBLIC parts of the platform for the status page. Only services the public already knows about appear here: the website, the RabbitOS app and its database,
// the guest shell, the hub, the standby site, the app mirror and the public ledger copy. Private parts (backups, proxy, the owner's computer) are deliberately not drawn.
// Pure functions, no browser or Node APIs, so a test can run them. Everything dynamic is escaped.

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function anchor(r, tx, ty) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const s = Math.min(dx !== 0 ? r.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? r.h / 2 / Math.abs(dy) : Infinity)
  return [cx + dx * s, cy + dy * s]
}

const NODES = [
  { key: 'visitors', x: 16, y: 150, w: 130, h: 60, label: 'Visitors', sub: 'browsers, AI assistants', neutral: true },
  { key: 'site', x: 200, y: 52, w: 270, h: 46, label: 'rabbitsoftware.io', sub: 'the website' },
  { key: 'app', x: 200, y: 114, w: 270, h: 46, label: 'app.rabbitsoftware.io', sub: 'the RabbitOS console' },
  { key: 'shellWorker', x: 200, y: 176, w: 270, h: 46, label: 'Guest shell gate', sub: 'human check, limits' },
  { key: 'supabase', x: 200, y: 238, w: 270, h: 46, label: 'Database', sub: 'research data, chain' },
  { key: 'shellService', x: 540, y: 52, w: 264, h: 46, label: 'Guest shell', sub: 'throwaway terminals' },
  { key: 'hub', x: 540, y: 114, w: 264, h: 46, label: 'Hub for AI assistants', sub: 'read-only tools' },
  { key: 'standby', x: 540, y: 176, w: 264, h: 46, label: 'Standby website', sub: 'takes over if needed' },
  { key: 'mirror', x: 540, y: 238, w: 264, h: 46, label: 'App mirror', sub: 'read copy of the console' },
  { key: 'ledgerBucket', x: 540, y: 300, w: 264, h: 46, label: 'Public chain copy', sub: 'checked against the app' },
]
const GROUPS = [{ x: 184, y: 14, w: 302, h: 288, label: 'Cloudflare' }, { x: 524, y: 14, w: 296, h: 346, label: 'Google Cloud' }]
const EDGES = [['visitors', 'site'], ['visitors', 'app'], ['visitors', 'shellWorker'], ['app', 'supabase'], ['shellWorker', 'shellService'], ['hub', 'app'], ['hub', 'ledgerBucket']]

/** @param feed the status feed ({services: [{key, ok, ms, label}]}) */
export function publicPlatformMap(feed) {
  const by = new Map((feed?.services ?? []).map((s) => [s.key, s]))
  const status = (n) => (n.neutral ? 'neutral' : !by.has(n.key) ? 'unk' : by.get(n.key).ok ? 'ok' : 'bad')
  const nodes = Object.fromEntries(NODES.map((n) => [n.key, n]))
  const parts = GROUPS.map((g) => `<rect class="m-group" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="6"/><text class="m-group-label" x="${g.x + 12}" y="${g.y + 20}">${esc(g.label)}</text>`)
  for (const [a, b] of EDGES) {
    const A = nodes[a], B = nodes[b]
    const [x1, y1] = anchor(A, B.x + B.w / 2, B.y + B.h / 2), [x2, y2] = anchor(B, A.x + A.w / 2, A.y + A.h / 2)
    parts.push(`<line class="m-edge" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" marker-end="url(#arrow)"/>`)
  }
  for (const n of NODES) {
    const s = status(n), svc = by.get(n.key)
    const tip = n.neutral ? n.label : `${n.label}: ${s === 'ok' ? 'answering' : s === 'bad' ? 'not answering' : 'not reported'}${svc?.ms ? ` (${Number(svc.ms) || 0} ms)` : ''}`
    parts.push(`<g class="m-node m-${s}"><title>${esc(tip)}</title><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5"/><circle class="m-dot" cx="${n.x + n.w - 14}" cy="${n.y + 15}" r="5"/>`
      + `<text class="m-label" x="${n.x + 12}" y="${n.y + 20}">${esc(n.label)}</text><text class="m-sub" x="${n.x + 12}" y="${n.y + 36}">${esc(n.sub)}</text></g>`)
  }
  return `<svg class="map" viewBox="0 0 836 376" role="img" aria-label="Map of the public RabbitOS services and whether each is answering" xmlns="http://www.w3.org/2000/svg">`
    + '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-arrow" d="M0,1 L9,5 L0,9 Z"/></marker></defs>'
    + parts.join('') + '</svg>'
}
