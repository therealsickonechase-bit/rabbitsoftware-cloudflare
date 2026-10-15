// The platform graph: one JSON file (data/platform-graph.json) drives the map,
// the roadmap board, the Supabase seed SQL and the weekly report section.

const STATUSES = ['live', 'fallback', 'planned', 'optional'];
const ROADMAP = ['done', 'waiting', 'next', 'later', 'paused'];
const ROADMAP_TITLES = {
  done: 'Done',
  waiting: 'Waiting on you',
  next: 'Next',
  later: 'Later',
  paused: 'Paused'
};

export const roadmapTitles = ROADMAP_TITLES;

export function validateGraph(g) {
  const problems = [];
  const ids = new Set();
  for (const n of g.nodes || []) {
    if (ids.has(n.id)) problems.push(`duplicate node ${n.id}`);
    ids.add(n.id);
    if (!g.providers?.[n.provider]) problems.push(`node ${n.id}: unknown provider ${n.provider}`);
    if (!Number.isInteger(n.lane) || n.lane < 0 || n.lane >= (g.lanes || []).length) {
      problems.push(`node ${n.id}: lane out of range`);
    }
    if (!STATUSES.includes(n.status)) problems.push(`node ${n.id}: unknown status ${n.status}`);
  }
  const seen = new Set();
  for (const e of g.edges || []) {
    if (!ids.has(e.from)) problems.push(`edge from unknown node ${e.from}`);
    if (!ids.has(e.to)) problems.push(`edge to unknown node ${e.to}`);
    if (e.from === e.to) problems.push(`edge ${e.from} points at itself`);
    const key = `${e.from}>${e.to}>${e.label}`;
    if (seen.has(key)) problems.push(`duplicate edge ${key}`);
    seen.add(key);
  }
  const rids = new Set();
  for (const r of g.roadmap || []) {
    if (rids.has(r.id)) problems.push(`duplicate roadmap item ${r.id}`);
    rids.add(r.id);
    if (!ROADMAP.includes(r.status)) problems.push(`roadmap ${r.id}: unknown status ${r.status}`);
  }
  for (const n of g.nodes || []) {
    const linked = (g.edges || []).some((e) => e.from === n.id || e.to === n.id);
    if (!linked) problems.push(`node ${n.id} has no connections`);
  }
  return problems;
}

const COL_W = 210;
const ROW_H = 58;
const NODE_W = 168;
const NODE_H = 38;
const PAD_X = 24;
const PAD_TOP = 48;

// Column per lane; within a lane, nodes keep provider groups together.
export function layoutGraph(g) {
  const providerOrder = Object.keys(g.providers);
  const pos = {};
  let rows = 0;
  g.lanes.forEach((_, lane) => {
    const inLane = g.nodes
      .filter((n) => n.lane === lane)
      .sort(
        (a, b) =>
          providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider) ||
          a.order - b.order
      );
    inLane.forEach((n, i) => {
      pos[n.id] = { x: PAD_X + lane * COL_W, y: PAD_TOP + i * ROW_H };
    });
    rows = Math.max(rows, inLane.length);
  });
  return {
    pos,
    width: PAD_X * 2 + (g.lanes.length - 1) * COL_W + NODE_W,
    height: PAD_TOP + rows * ROW_H + 8,
    nodeW: NODE_W,
    nodeH: NODE_H
  };
}

export function edgePath(a, b, nodeW, nodeH) {
  const sameLane = a.x === b.x;
  if (sameLane) {
    const x = a.x + nodeW;
    const ya = a.y + nodeH / 2;
    const yb = b.y + nodeH / 2;
    const bow = 34;
    return `M${x} ${ya} C${x + bow} ${ya} ${x + bow} ${yb} ${x} ${yb}`;
  }
  const forward = b.x > a.x;
  const x1 = forward ? a.x + nodeW : a.x;
  const x2 = forward ? b.x : b.x + nodeW;
  const y1 = a.y + nodeH / 2;
  const y2 = b.y + nodeH / 2;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Static SVG, themed with CSS variables the host page defines
// (--bg, --fg, --muted, --line, and --p-<provider>).
export function graphSvg(g) {
  const L = layoutGraph(g);
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" role="img" aria-label="Platform map with all connections" class="pgraph">`
  );
  g.lanes.forEach((name, i) => {
    parts.push(
      `<text x="${PAD_X + i * COL_W}" y="26" class="lane">${esc(name.toUpperCase())}</text>`
    );
  });
  parts.push('<g class="edges">');
  for (const e of g.edges) {
    const a = L.pos[e.from];
    const b = L.pos[e.to];
    if (!a || !b) continue;
    parts.push(
      `<path d="${edgePath(a, b, L.nodeW, L.nodeH)}" class="edge k-${esc(e.kind)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><title>${esc(e.from)} → ${esc(e.to)}: ${esc(e.label)}</title></path>`
    );
  }
  parts.push('</g><g class="nodes">');
  for (const n of g.nodes) {
    const p = L.pos[n.id];
    parts.push(
      `<g class="node s-${esc(n.status)} p-${esc(n.provider)}" data-id="${esc(n.id)}" transform="translate(${p.x} ${p.y})"><title>${esc(n.label)}: ${esc(n.about)}</title><rect width="${L.nodeW}" height="${L.nodeH}" rx="7"/><text x="10" y="${L.nodeH / 2 + 4}">${esc(trunc(n.label, 24))}</text></g>`
    );
  }
  parts.push('</g></svg>');
  return parts.join('');
}

export function graphCss() {
  const colors = {
    people: '#8b6fd0',
    cloudflare: '#e8832a',
    gcp: '#3b82d6',
    supabase: '#2ea36b',
    owner: '#c2417a',
    external: '#7b8794'
  };
  const vars = Object.entries(colors)
    .map(([k, v]) => `--p-${k}:${v};`)
    .join('');
  const fills = Object.keys(colors)
    .map(
      (k) =>
        `.pgraph .p-${k} rect{stroke:var(--p-${k});fill:color-mix(in srgb,var(--p-${k}) 14%,var(--surface,#fff))}`
    )
    .join('');
  return (
    `:root{${vars}}` +
    '.pgraph{width:100%;height:auto;font:12px system-ui,sans-serif}' +
    '.pgraph .lane{font-size:10px;letter-spacing:.08em;fill:var(--muted,#667)}' +
    '.pgraph .node text{fill:var(--ink,#111)}' +
    '.pgraph .node rect{stroke-width:1.5}' +
    '.pgraph .s-planned rect,.pgraph .s-optional rect{stroke-dasharray:4 3}' +
    '.pgraph .s-fallback rect{stroke-dasharray:1 3}' +
    '.pgraph .edge{fill:none;stroke:var(--line,#99a);stroke-width:1.2;opacity:.55}' +
    '.pgraph .edge.k-observe{stroke-dasharray:2 4}' +
    '.pgraph .edge.k-backup,.pgraph .edge.k-mirror{stroke-dasharray:7 4}' +
    '.pgraph .edge.hot{opacity:1;stroke-width:2.4;stroke:var(--ink,#111)}' +
    '.pgraph .dim{opacity:.15}' +
    fills
  );
}

export function roadmapGroups(g) {
  return ROADMAP.map((status) => ({
    status,
    title: ROADMAP_TITLES[status],
    items: g.roadmap.filter((r) => r.status === status)
  })).filter((x) => x.items.length);
}

export function roadmapHtml(g) {
  return roadmapGroups(g)
    .map(
      (grp) =>
        `<section class="rm rm-${grp.status}"><h3>${esc(grp.title)} <span>${grp.items.length}</span></h3><ul>` +
        grp.items
          .map(
            (r) =>
              `<li><strong>${esc(r.title)}</strong><em>${esc(r.area)}</em>${r.note ? `<p>${esc(r.note)}</p>` : ''}</li>`
          )
          .join('') +
        '</ul></section>'
  ).join('');
}

// Report section: map, roadmap, and a connection table.
export function graphSection(g) {
  const label = Object.fromEntries(g.nodes.map((n) => [n.id, n.label]));
  const rows = g.edges
    .map(
      (e) =>
        `<tr><td>${esc(label[e.from])}</td><td>${esc(label[e.to])}</td><td>${esc(e.label)}</td><td>${esc(e.kind)}</td></tr>`
    )
    .join('');
  return (
    `<section id="platform-graph"><h2>Workflow and roadmap, with all connections</h2>` +
    `<style>${graphCss()}.rm ul{list-style:none;padding:0}.rm li{margin:.4rem 0}.rm em{margin-left:.5rem;color:var(--muted,#667);font-size:.85em}.rm p{margin:.1rem 0;color:var(--muted,#667)}</style>` +
    graphSvg(g) +
    roadmapHtml(g) +
    `<details><summary>All ${g.edges.length} connections</summary><table><thead><tr><th>From</th><th>To</th><th>What</th><th>Kind</th></tr></thead><tbody>${rows}</tbody></table></details></section>`
  );
}

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

// Idempotent seed: replaces the contents of the three tables in one transaction.
export function graphSql(g) {
  const out = [];
  out.push('-- Generated from workers/qa-audit/data/platform-graph.json by scripts/export-platform-graph-sql.mjs.');
  out.push('-- NOT APPLIED automatically. Run it by hand in the Supabase SQL editor, after the platform_graph migration.');
  out.push('begin;');
  out.push('delete from public.platform_edges;');
  out.push('delete from public.platform_roadmap;');
  out.push('delete from public.platform_nodes;');
  for (const n of g.nodes) {
    out.push(
      `insert into public.platform_nodes (id, label, provider, lane, sort_order, kind, status, about) values (${q(n.id)}, ${q(n.label)}, ${q(n.provider)}, ${n.lane}, ${n.order}, ${q(n.kind)}, ${q(n.status)}, ${q(n.about)});`
    );
  }
  for (const e of g.edges) {
    out.push(
      `insert into public.platform_edges (from_id, to_id, label, kind) values (${q(e.from)}, ${q(e.to)}, ${q(e.label)}, ${q(e.kind)});`
    );
  }
  g.roadmap.forEach((r, i) => {
    out.push(
      `insert into public.platform_roadmap (id, title, status, area, note, sort_order) values (${q(r.id)}, ${q(r.title)}, ${q(r.status)}, ${q(r.area)}, ${q(r.note)}, ${i});`
    );
  });
  out.push('commit;');
  return out.join('\n') + '\n';
}
