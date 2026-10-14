import { cellText, curlSnippet, datasetUrl, failureMessage, headUrl, manifestUrl, safeLink } from "./data-core.mjs";

const byId = (id) => document.getElementById(id);
let manifest = null;
let current = null;      // manifest entry of the open dataset
let cursor = "";
let stack = [];          // cursors of earlier pages
let page = null;
let seq = 0;

const setError = (text) => { const e = byId("load-error"); e.textContent = text; e.hidden = !text; };
const status = (text) => { byId("data-status").textContent = text; };

function state() {
  const col = byId("sort").value;
  const dir = byId("dir").value;
  return { q: byId("q").value.trim(), limit: byId("limit").value, cursor, sort: col ? (dir === "desc" ? `-${col}` : col) : "" };
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) { const err = new Error("status"); err.status = r.status; throw err; }
  return r.json();
}

function render(rows, columns) {
  const table = byId("data-table");
  const head = table.tHead;
  const body = table.tBodies[0];
  head.replaceChildren(); body.replaceChildren();
  const tr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = "";
  tr.append(corner);
  for (const c of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    if (current.sortable.includes(c)) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = c;
      b.addEventListener("click", () => {
        const same = byId("sort").value === c;
        byId("dir").value = same && byId("dir").value !== "desc" ? "desc" : "asc";
        byId("sort").value = c;
        reload(true);
      });
      th.append(b);
    } else th.textContent = c;
    tr.append(th);
  }
  head.append(tr);
  for (const row of rows) {
    const r = document.createElement("tr");
    const first = document.createElement("td");
    const detail = document.createElement("tr");
    detail.hidden = true;
    const dcell = document.createElement("td");
    dcell.colSpan = columns.length + 1;
    const pre = document.createElement("pre");
    pre.className = "data-json";
    pre.textContent = JSON.stringify(row, null, 2);
    dcell.append(pre); detail.append(dcell);
    const toggle = document.createElement("button");
    toggle.type = "button"; toggle.textContent = "+"; toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-label", "Show row JSON");
    toggle.addEventListener("click", () => { detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? "+" : "-"; toggle.setAttribute("aria-expanded", String(!detail.hidden)); });
    first.append(toggle); r.append(first);
    for (const c of columns) {
      const td = document.createElement("td");
      const text = cellText(row[c]);
      const href = c === "url" ? safeLink(row[c]) : "";
      if (href) { const a = document.createElement("a"); a.href = href; a.rel = "noreferrer noopener"; a.target = "_blank"; a.textContent = text; td.append(a); }
      else td.textContent = text.length > 160 ? `${text.slice(0, 160)}…` : text;
      r.append(td);
    }
    body.append(r, detail);
  }
  table.hidden = false;
}

async function load() {
  if (!current) return;
  const mine = ++seq;
  status("Loading…");
  setError("");
  const s = state();
  try {
    const result = await getJson(datasetUrl(current.id, s));
    if (mine !== seq) return;
    page = result;
    render(result.rows, result.columns);
    status(`${result.count} rows on this page${result.nextCursor ? ", more available" : ", end of results"}.`);
    byId("next").disabled = !result.nextCursor;
    byId("prev").disabled = !stack.length;
    byId("copy-json").disabled = false;
    for (const [id, fmt] of [["dl-json", "json"], ["dl-csv", "csv"]]) { const a = byId(id); a.href = datasetUrl(current.id, { ...s, format: fmt, download: true }); a.hidden = false; }
  } catch (e) {
    if (mine !== seq) return;
    page = null;
    byId("data-table").hidden = true;
    byId("next").disabled = true; byId("prev").disabled = !stack.length;
    byId("copy-json").disabled = true;
    status("");
    setError(failureMessage(e, e.status));
  }
}

function reload(reset) { if (reset) { cursor = ""; stack = []; } load(); }

function pick(id) {
  current = manifest.datasets.find((d) => d.id === id);
  byId("dataset-note").textContent = current.description + (current.rows === null ? "" : ` (${current.rows} rows)`);
  const sort = byId("sort");
  sort.replaceChildren(new Option("default", ""));
  for (const c of current.sortable) sort.append(new Option(c, c));
  byId("dir").value = "";
  byId("q").value = "";
  byId("q").disabled = !current.searchable.length;
  byId("curl-line").textContent = curlSnippet(id);
  reload(true);
}

async function pollHead() {
  if (document.hidden) return;
  try {
    const h = await getJson(headUrl());
    byId("head-line").textContent = `${h.length} events. Head hash ${h.headHash}${h.updatedAt ? `. Last event ${h.updatedAt}` : ""}.`;
  } catch (e) { byId("head-line").textContent = failureMessage(e, e.status); }
}

async function copyText(text, note) {
  try { await navigator.clipboard.writeText(text); byId("copy-status").textContent = note; }
  catch { byId("copy-status").textContent = "Copy was blocked by the browser. Select the text and copy it by hand."; }
}

async function init() {
  byId("data-form").addEventListener("submit", (e) => e.preventDefault());
  let t = null;
  byId("q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => reload(true), 300); });
  for (const id of ["sort", "dir", "limit"]) byId(id).addEventListener("change", () => reload(true));
  byId("dataset").addEventListener("change", (e) => pick(e.target.value));
  byId("next").addEventListener("click", () => { if (page?.nextCursor) { stack.push(cursor); cursor = page.nextCursor; load(); } });
  byId("prev").addEventListener("click", () => { cursor = stack.pop() ?? ""; load(); });
  byId("copy-json").addEventListener("click", () => { if (page) copyText(JSON.stringify(page.rows, null, 2), "Copied this page as JSON."); });
  byId("copy-curl").addEventListener("click", () => copyText(byId("curl-line").textContent, "Copied. Paste it into the public CloudShell."));
  pollHead();
  setInterval(pollHead, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollHead(); });
  try {
    manifest = await getJson(manifestUrl());
    const sel = byId("dataset");
    sel.replaceChildren();
    for (const d of manifest.datasets) sel.append(new Option(`${d.title}${d.rows === null ? "" : ` (${d.rows})`}`, d.id));
    sel.disabled = false;
    pick(manifest.datasets[0].id);
  } catch (e) {
    status("");
    setError(failureMessage(e, e.status));
  }
}

init();
