import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { API_ORIGIN, curlSnippet, datasetUrl, failureMessage, headUrl, manifestUrl, safeLink } from "../site/data-core.mjs";

const site = (f) => readFileSync(new URL(`../site/${f}`, import.meta.url), "utf8");

test("data.html has no inline script, loads data.js as a module and links to the pages around it", () => {
  const html = site("data.html");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) { assert.match(attrs, /src="data\.js"/); assert.equal(body.trim(), ""); }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.match(html, /<title>[^<]+\| RabbitSoftware<\/title>/);
  assert.match(html, /rel="stylesheet" href="polish\.css"/);
  for (const id of ["dataset", "q", "sort", "dir", "limit", "prev", "next", "dl-json", "dl-csv", "copy-json", "curl-line", "copy-curl", "head-line", "load-error", "data-table"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(site("index.html"), /href="data\.html"/);
  assert.match(site("chain.html"), /href="data\.html"/);
});

test("data.js only reads, never writes, and builds DOM with text nodes", () => {
  const js = site("data.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(js, /method:\s*["'](POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie|credentials/);
  assert.match(js, /document\.hidden/);
  assert.match(js, /15000/);
});

test("the CSP allows the data hub origin and the pages stay within it", () => {
  const csp = site("_headers").split(/\r?\n/).find((l) => l.trim().startsWith("Content-Security-Policy:"));
  assert.match(csp, /connect-src [^;]*https:\/\/app\.rabbitsoftware\.io(?=[ ;])/);
  assert.doesNotMatch(csp, /script-src [^;]*https:\/\/app\.rabbitsoftware\.io/);
});

test("requests go to the one public origin, GET-style URLs only, with bounded parameters", () => {
  assert.equal(API_ORIGIN, "https://app.rabbitsoftware.io");
  assert.equal(manifestUrl(), "https://app.rabbitsoftware.io/api/data");
  assert.equal(headUrl(), "https://app.rabbitsoftware.io/api/chain/head");
  const u = new URL(datasetUrl("research_records", { q: "brca1", limit: 9999, sort: "-title", cursor: "abc", format: "csv", download: true, filters: { source: "pubmed", "bad key": "x" } }));
  assert.equal(u.origin, API_ORIGIN);
  assert.equal(u.pathname, "/api/data/research_records");
  assert.equal(u.searchParams.get("limit"), "200");
  assert.equal(u.searchParams.get("sort"), "-title");
  assert.equal(u.searchParams.get("format"), "csv");
  assert.equal(u.searchParams.get("source"), "pubmed");
  assert.equal(u.searchParams.get("bad key"), null);
  assert.equal(new URL(datasetUrl("agents", {})).searchParams.get("format"), null);
  for (const bad of ["../x", "a/b", "A", "", "x?y=1", "a b"]) assert.throws(() => datasetUrl(bad), /bad dataset/, bad);
  assert.throws(() => datasetUrl("agents", { sort: "a;b" }), /bad sort/);
  assert.throws(() => datasetUrl("agents", { format: "xml" }), /bad format/);
});

test("the CloudShell snippet matches the rabbit-web one and failures are explained", () => {
  assert.equal(curlSnippet("ledger"), 'curl -fsS "https://app.rabbitsoftware.io/api/data/ledger?limit=50" | jq');
  assert.throws(() => curlSnippet("x;rm"), /bad dataset/);
  assert.match(failureMessage(new TypeError("Failed to fetch")), /CORS/);
  assert.match(failureMessage(new Error("status"), 503), /503/);
  assert.equal(safeLink("javascript:alert(1)"), "");
  assert.equal(safeLink("https://pubmed.ncbi.nlm.nih.gov/1/"), "https://pubmed.ncbi.nlm.nih.gov/1/");
});
