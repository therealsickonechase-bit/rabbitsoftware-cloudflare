// The report page. renderReport(data, { standalone }) returns HTML: a complete document for storage, or (standalone false) page content for publishing as an Artifact.
// Everything dynamic goes through esc(). Colors are tokens; the maps use the same tokens, so both themes work.
import { esc, mostLinked, platformMap, siteMap } from './maps.mjs'
import { pageSeverity } from './audit.mjs'
import { graphSection } from './graph.mjs'

const CSS = `
/* Layout: one reading column; the score first, then what to fix, then the two maps, then the evidence. */
:root{
  --bg:#f2f5f9; --surface:#ffffff; --ink:#14202e; --muted:#566678; --line:#d5dde7; --line-strong:#a3b1c2;
  --accent:#0a6c8c; --ok:#1b7a4b; --ok-bg:#dff2e7; --warn:#935d00; --warn-bg:#faedcc; --bad:#b3261e; --bad-bg:#fbe2df; --low:#47688a; --low-bg:#e2eaf4; --unk:#8493a5;
  --font-body:'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif; --font-mono:'JetBrains Mono',ui-monospace,Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0d141d; --surface:#141e2a; --ink:#e6edf5; --muted:#93a3b6; --line:#263445; --line-strong:#445871;
  --accent:#5cc3dd; --ok:#54c788; --ok-bg:#123a27; --warn:#e5b04a; --warn-bg:#3d2f0e; --bad:#ff8d86; --bad-bg:#45201d; --low:#8fb2d6; --low-bg:#1c2d41; --unk:#6f8096; color-scheme:dark;}}
:root[data-theme="dark"]{
  --bg:#0d141d; --surface:#141e2a; --ink:#e6edf5; --muted:#93a3b6; --line:#263445; --line-strong:#445871;
  --accent:#5cc3dd; --ok:#54c788; --ok-bg:#123a27; --warn:#e5b04a; --warn-bg:#3d2f0e; --bad:#ff8d86; --bad-bg:#45201d; --low:#8fb2d6; --low-bg:#1c2d41; --unk:#6f8096; color-scheme:dark;}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font-body);font-size:15px;line-height:1.55}
.wrap{max-width:1040px;margin:0 auto;padding-block:28px 64px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:36px}
h1,h2,h3{font-weight:650;line-height:1.2;text-wrap:balance;margin:0}
h1{font-size:clamp(26px,4vw,36px);letter-spacing:-.01em}
h2{font-size:21px;margin-bottom:4px}
h3{font-size:16px}
p{margin:0;max-width:68ch}
a{color:var(--accent)}
.mono,code{font-family:var(--font-mono);font-size:.88em}
.muted{color:var(--muted)}
.eyebrow{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
header{display:grid;gap:8px}
.summary{display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr);gap:28px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:22px}
.score{display:grid;gap:2px}
.score b{font-size:64px;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.score span{color:var(--muted);font-size:13px}
.score.good b{color:var(--ok)} .score.mid b{color:var(--warn)} .score.poor b{color:var(--bad)}
.facts{display:grid;gap:12px;min-width:0}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 11px;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;border:1px solid transparent}
.chip.high,.chip.bad{background:var(--bad-bg);color:var(--bad)} .chip.medium,.chip.warn{background:var(--warn-bg);color:var(--warn)} .chip.low{background:var(--low-bg);color:var(--low)} .chip.ok{background:var(--ok-bg);color:var(--ok)} .chip.unk{background:var(--low-bg);color:var(--muted)}
section{display:grid;gap:14px;min-width:0}
.finding{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px 18px;display:grid;gap:8px;min-width:0}
.finding header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.finding dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:4px 12px;margin:0}
.finding dt{color:var(--muted);font-size:13px} .finding dd{margin:0}
details summary{cursor:pointer;color:var(--accent);font-size:14px}
details ul{margin:8px 0 0;padding-left:18px;display:grid;gap:3px;overflow-wrap:anywhere}
.mapwrap,.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.map{display:block;min-width:660px;width:100%;height:auto;font-family:var(--font-body)}
.m-group{fill:none;stroke:var(--line-strong);stroke-dasharray:5 5}
.m-group-label{fill:var(--muted);font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.m-node rect{fill:var(--surface);stroke:var(--line-strong)}
.m-node.m-bad rect{stroke:var(--bad);stroke-width:2}
.m-dot{fill:var(--unk)} .m-ok .m-dot{fill:var(--ok)} .m-bad .m-dot{fill:var(--bad)} .m-neutral .m-dot{display:none}
.m-label{fill:var(--ink);font-size:13px;font-weight:600} .m-sub{fill:var(--muted);font-size:11px;font-weight:400}
.m-edge{stroke:var(--line-strong);stroke-width:1.4} .m-edge-label{fill:var(--muted);font-size:10px} .m-arrow{fill:var(--line-strong)}
.m-page{stroke:var(--surface);stroke-width:2;fill:var(--ok)} .m-low .m-page{fill:var(--low)} .m-warn .m-page{fill:var(--warn)} .m-bad .m-page{fill:var(--bad)}
.m-page-label{fill:var(--ink);font-family:var(--font-mono);font-size:10px} .m-x{fill:#fff;font-size:13px;font-weight:700}
.dbtable{border-bottom:1px solid var(--line);padding:9px 0}
.dbtable summary{cursor:pointer;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,2fr) auto;gap:6px 14px;align-items:center}
.dbtable ul{margin:8px 0 2px;padding:0 0 0 14px;list-style:none;display:flex;flex-wrap:wrap;gap:3px 16px;font-family:var(--font-mono);font-size:12px;color:var(--muted)}
.dbtable ul b{color:var(--ink);font-weight:500}
.dbtable .pol{margin:6px 0 2px;font-size:13px;color:var(--muted)}
@media (max-width:640px){.dbtable summary{grid-template-columns:1fr}}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
td .mono{overflow-wrap:anywhere}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:14px}
.note{border-left:3px solid var(--line-strong);padding-left:14px;color:var(--muted);max-width:70ch}
ul.plain{margin:0;padding-left:18px;display:grid;gap:4px}
@media (max-width:640px){.summary{grid-template-columns:1fr}.finding dl{grid-template-columns:1fr}}
@media (prefers-reduced-motion:no-preference){a{transition:color .15s}}
`

const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' }
const when = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
const path = (url) => { try { const u = new URL(url); return u.pathname + u.search || '/' } catch { return url } }
const host = (url) => { try { return new URL(url).host } catch { return '' } }
const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`
const kb = (n) => (n ? `${Math.max(1, Math.round(n / 1024))} KB` : '')
const scoreClass = (s) => (s >= 85 ? 'good' : s >= 60 ? 'mid' : 'poor')

function verdict(data) {
  const { counts, score } = data.summary
  const top = data.findings.slice(0, 3).map((f) => f.title.toLowerCase())
  const platform = `${data.platform.up} of ${data.platform.total} platform checks answered`
  const chain = data.platform.chain.agree ? 'The public chain agrees between the app and the Google Cloud copy.' : 'The public chain copies do not agree; check this first.'
  const lead = counts.high ? `${counts.high} high-severity issue${counts.high === 1 ? '' : 's'} need attention first.` : counts.medium ? 'No high-severity issues; the medium ones are the next job.' : 'No high or medium issues found.'
  return `${lead} ${top.length ? `Start with: ${top.join('; ')}.` : ''} ${platform}. ${chain}`.replace(/\s+/g, ' ')
}

function findingBlock(f) {
  const shown = f.pages.slice(0, 8)
  const more = f.pages.length - shown.length
  const details = f.details?.length ? `<dt>Detail</dt><dd>${esc([...new Set(f.details)].slice(0, 3).join(' · '))}</dd>` : ''
  return `<article class="finding"><header>${chip(f.severity, SEV_LABEL[f.severity])}<h3>${esc(f.title)}</h3><span class="muted">${f.pages.length} place${f.pages.length === 1 ? '' : 's'}</span></header>`
    + `<dl><dt>Why</dt><dd>${esc(f.why)}</dd><dt>Fix</dt><dd>${esc(f.fix)}</dd>${details}</dl>`
    + `<details><summary>Where (${f.pages.length})</summary><ul>${shown.map((u) => `<li class="mono">${esc(host(u) ? host(u) + path(u) : u)}</li>`).join('')}${more > 0 ? `<li class="muted">and ${more} more</li>` : ''}</ul></details></article>`
}

function securityTable(data) {
  const origins = [...new Set(data.pages.filter((p) => p.isHtml).map((p) => new URL(p.finalUrl).origin))]
  const rows = [['hsts', 'HTTPS-only (HSTS)'], ['csp', 'Content Security Policy'], ['contentTypeOptions', 'nosniff'], ['referrerPolicy', 'Referrer-Policy'], ['frameProtection', 'Framing blocked'], ['permissionsPolicy', 'Permissions-Policy']]
  const sec = (o) => data.pages.find((p) => p.isHtml && new URL(p.finalUrl).origin === o)?.security ?? {}
  const cell = (key, s) => key === 'csp' ? (s.csp === 'enforced' ? chip('ok', 'enforced') : s.csp === 'report-only' ? chip('warn', 'report-only') : chip('bad', 'none')) : (s[key] ? chip('ok', 'yes') : chip('bad', 'no'))
  return `<div class="tablewrap"><table><thead><tr><th>Header</th>${origins.map((o) => `<th>${esc(host(o))}</th>`).join('')}</tr></thead><tbody>`
    + rows.map(([key, label]) => `<tr><td>${esc(label)}</td>${origins.map((o) => `<td>${cell(key, sec(o))}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>'
}

/** The Supabase tree: every table with its columns and security state, from the migrations, with the live anonymous-reader check beside it when there is one. */
function databaseSection(tree) {
  if (!tree || !Array.isArray(tree.tables)) return ''
  const live = tree.liveCheck?.tables
  const liveChip = (name, t) => {
    if (!live) return ''
    const r = live[name]
    const declaredOpen = t.publicRead, declaredClosed = t.closed && !t.publicRead
    if ((declaredOpen && r === 'refused') || (declaredClosed && r !== 'refused')) return chip('bad', 'differs from migrations')
    return r === 'refused' ? chip('ok', 'refused anonymous') : r === 'rows' ? chip('warn', 'anyone can read') : r === 'empty' ? chip('unk', 'open, empty') : chip('unk', 'not checked')
  }
  const open = tree.tables.filter((t) => t.publicRead).length, closed = tree.tables.filter((t) => t.closed && !t.publicRead).length
  const cols = tree.tables.reduce((n, t) => n + t.columns.length, 0)
  const manual = (tree.migrations ?? []).filter((m) => m.manual).map((m) => m.name)
  const lc = tree.liveCheck
  const liveText = lc
    ? `Checked on ${esc(when(lc.at))} as an anonymous reader with the project's public key, one row per table: ${Object.values(lc.tables).filter((v) => v === 'refused').length} tables refused, ${Object.values(lc.tables).filter((v) => v === 'rows' || v === 'empty').length} answered, ${lc.mismatches.length} differ from what the migrations declare${lc.mismatches.length ? ` (${esc(lc.mismatches.join(', '))})` : ''}.`
    : 'Not checked against the live database.'
  const block = (t) => `<details class="dbtable"><summary><span class="mono">${esc(t.name)}</span><span class="chips">${t.rls ? chip('ok', 'RLS on') : chip('bad', 'no RLS')}${t.publicRead ? chip('warn', 'public read') : t.closed ? chip('ok', 'closed') : chip('low', 'private')}${t.appendOnly ? chip('low', 'append-only') : ''}${liveChip(t.name, t)}</span><span class="muted">${t.columns.length} columns</span></summary>`
    + `<ul>${t.columns.map((c) => `<li><b>${esc(c.name)}</b> ${esc(c.type)}${c.primaryKey ? ' · key' : ''}${c.references ? ` → ${esc(c.references)}` : ''}</li>`).join('')}</ul>`
    + (t.policies.length ? `<p class="pol">Policies: ${t.policies.map((p) => `${esc(p.name)} (${esc(p.command)} for ${esc(p.roles)})`).join('; ')}</p>` : '<p class="pol">No policy for ordinary users: only the server can read or write.</p>') + '</details>'
  return `<section id="database"><div><h2>Database tree</h2><p class="muted">${tree.tables.length} tables, ${cols} columns · ${open} readable by anyone · ${closed} closed · ${tree.tables.filter((t) => t.appendOnly).length} append-only · ${(tree.functions ?? []).length} functions · ${(tree.storageBuckets ?? []).length} storage bucket${(tree.storageBuckets ?? []).length === 1 ? '' : 's'}.</p></div>`
    + `<p class="note">${esc('Built from the SQL migrations in the repository: this is what they declare.')} ${liveText}${manual.length ? ` ${manual.length} migration${manual.length === 1 ? ' says it is' : 's say they are'} applied by hand (${esc(manual.join(', '))}); ${lc ? 'the live check above is the evidence that they were run.' : 'confirm in the SQL editor that they were run.'}` : ''}</p>`
    + `<div class="tablewrap" style="padding:0 16px">${tree.tables.map(block).join('')}</div>`
    + `<div class="cols"><div class="tablewrap"><table><thead><tr><th>Functions</th></tr></thead><tbody>${(tree.functions ?? []).map((f) => `<tr><td class="mono">${esc(f)}</td></tr>`).join('') || '<tr><td class="muted">none</td></tr>'}</tbody></table></div>`
    + `<div class="tablewrap"><table><thead><tr><th>Storage buckets</th><th>Access</th></tr></thead><tbody>${(tree.storageBuckets ?? []).map((b) => `<tr><td class="mono">${esc(b.id)}</td><td>${b.public ? chip('warn', 'public') : chip('ok', 'private')}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">none</td></tr>'}</tbody></table></div></div></section>`
}

export function renderReport(data, { standalone = true } = {}) {
  const severity = pageSeverity(data.findings)
  const perPage = (u) => { const c = { high: 0, medium: 0, low: 0 }; for (const f of data.findings) if (f.pages.includes(u)) c[f.severity]++; return c }
  const pageRows = [...data.pages].map((p) => ({ p, c: perPage(p.url) })).sort((a, b) => (b.c.high * 100 + b.c.medium * 10 + b.c.low) - (a.c.high * 100 + a.c.medium * 10 + a.c.low) || a.p.url.localeCompare(b.p.url))
  const s = data.summary
  const body = `
<div class="wrap">
  <header>
    <span class="eyebrow">Platform audit · ${esc(when(data.generatedAt))}</span>
    <h1>RabbitWeb audit</h1>
    <p class="muted">rabbitsoftware.io and the RabbitOS app, checked from the outside the way a visitor or a search engine meets them. ${s.pagesAudited} pages read in ${Math.round(data.durationMs / 1000)} seconds.</p>
  </header>

  <div class="summary">
    <div class="score ${scoreClass(s.score)}"><b>${s.score}</b><span>out of 100</span></div>
    <div class="facts">
      <div class="chips">${chip('high', `${s.counts.high} high`)}${chip('medium', `${s.counts.medium} medium`)}${chip('low', `${s.counts.low} low`)}${chip(data.platform.up === data.platform.total ? 'ok' : 'bad', `${data.platform.up}/${data.platform.total} services up`)}${chip(data.platform.chain.agree ? 'ok' : 'bad', data.platform.chain.agree ? 'chain copies agree' : 'chain copies differ')}</div>
      <p>${esc(verdict(data))}</p>
      <p class="muted">Score: 100 minus 10 for each high issue, 5 for each medium, 2 for each low. Each issue counts once, however many pages it affects.</p>
    </div>
  </div>

  <section id="fix">
    <div><h2>What to improve first</h2><p class="muted">Sorted by severity, then by how many places each issue touches.</p></div>
    ${data.findings.length ? data.findings.map(findingBlock).join('') : '<p>Nothing to fix in what was checked.</p>'}
  </section>

  <section id="platform">
    <div><h2>Platform map</h2><p class="muted">What talks to what, and whether each piece answers a public check right now. Grey dots mark parts that cannot be checked from outside.</p></div>
    <div class="mapwrap">${platformMap(data.platform)}</div>
    <div class="legend"><span><i style="background:var(--ok)"></i>answering</span><span><i style="background:var(--bad)"></i>not answering</span><span><i style="background:var(--unk)"></i>not checked from outside</span></div>
    <div class="cols">
      <div class="tablewrap"><table><thead><tr><th>Check</th><th>Result</th><th class="num">ms</th></tr></thead><tbody>${Object.values(data.platform.nodes).map((n) => `<tr><td>${esc(n.label)}</td><td>${n.ok ? chip('ok', 'up') : chip('bad', n.status ? `HTTP ${n.status}` : 'no answer')}</td><td class="num">${n.ms}</td></tr>`).join('')}</tbody></table></div>
      <div class="tablewrap"><table><tbody>
        <tr><td>Chain length, app</td><td class="num">${esc(data.platform.chain.app?.length ?? 'n/a')}</td></tr>
        <tr><td>Chain length, bucket copy</td><td class="num">${esc(data.platform.chain.bucket?.length ?? 'n/a')}</td></tr>
        <tr><td>Datasets in the data hub</td><td class="num">${esc(data.platform.data.datasets)}</td></tr>
        <tr><td>Research records</td><td class="num">${esc(data.platform.data.researchRows ?? 'n/a')}</td></tr>
      </tbody></table></div>
    </div>
  </section>

  <section id="site">
    <div><h2>Site map</h2><p class="muted">Every page visited, as a tree from the home page. Color shows the worst issue on the page; hover a dot for its address and details.</p></div>
    <div class="mapwrap">${siteMap(data.pages, severity)}</div>
    <div class="legend"><span><i style="background:var(--ok)"></i>no issues</span><span><i style="background:var(--low)"></i>low</span><span><i style="background:var(--warn)"></i>medium</span><span><i style="background:var(--bad)"></i>high or broken</span></div>
    <div class="cols"><div class="tablewrap"><table><thead><tr><th>Most linked-to</th><th class="num">links in</th></tr></thead><tbody>${mostLinked(data.linkTargets).map((m) => `<tr><td class="mono">${esc(host(m.url) + path(m.url))}</td><td class="num">${m.count}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">none</td></tr>'}</tbody></table></div></div>
  </section>

  ${databaseSection(data.supabaseTree)}

  ${data.platformGraph ? graphSection(data.platformGraph) : ''}

  <section id="pages">
    <div><h2>Pages</h2><p class="muted">Worst first.</p></div>
    <div class="tablewrap"><table><thead><tr><th>Page</th><th>Status</th><th class="num">Time</th><th class="num">Size</th><th>Issues</th><th>Title</th></tr></thead><tbody>
    ${pageRows.map(({ p, c }) => `<tr><td class="mono">${esc(host(p.url) + path(p.url))}</td><td>${p.status >= 400 || !p.status ? chip('bad', p.status || 'none') : chip('ok', p.status)}</td><td class="num">${p.ms} ms</td><td class="num">${esc(kb(p.bytes))}</td><td><span class="chips">${c.high ? chip('high', c.high) : ''}${c.medium ? chip('medium', c.medium) : ''}${c.low ? chip('low', c.low) : ''}${c.high + c.medium + c.low === 0 ? '<span class="muted">none</span>' : ''}</span></td><td>${esc(p.title || '')}</td></tr>`).join('')}
    </tbody></table></div>
  </section>

  <section id="security">
    <div><h2>Security headers</h2><p class="muted">Read from the home page of each site.</p></div>
    ${securityTable(data)}
  </section>

  <section id="method">
    <h2>How this was measured</h2>
    <ul class="plain muted">
      <li>Public pages only, starting from the home page of each site and following links inside the two sites, up to ${esc(data.maxPages)} pages. No logins, no forms submitted, nothing written.</li>
      <li>HTML is read with simple patterns, not a browser. Scripts are not run, so content added by scripts, and anything behind a login, is not seen.</li>
      <li>Times are one request from one place and vary from run to run; treat only large differences as real.</li>
      <li>Platform checks use each service's public health address. Parts without one (the proxy VM, backups, R2, the owner's computer) are shown grey.</li>
    </ul>
  </section>
</div>`
  const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">'
  const head = `<title>RabbitWeb Audit</title><meta name="claude:viewport-fit-sides" content="cover">${fonts}<style>${CSS}</style>`
  return standalone
    ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${head}</head><body>${body}</body></html>`
    : `${head}${body}`
}
