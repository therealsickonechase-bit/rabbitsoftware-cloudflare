import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { EMBEDDING_MODEL, chat, chatRequest, chunkInput, remove, search, upsert } from "../workers/vault-agent/src/live.mjs";
import { MODEL } from "../workers/vault-agent/src/protocol.mjs";
import { corpusTool, serviceOrigin, tokenFromFile } from "../tools/vault-agent/corpus.mjs";
import { loadConfig } from "../tools/vault-agent/runtime.mjs";
import { chunkId, chunkMarkdown, documentChunks } from "./vault-corpus-index.mjs";

// Workers provide crypto.subtle.timingSafeEqual; Node does not, so map it to node:crypto's equivalent.
import { timingSafeEqual } from "node:crypto";
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
// The real Worker entry, bundled with a stand-in for the runtime-only cloudflare:workers module.
const bundle = await build({
  entryPoints: ["workers/vault-agent/src/index.js"], bundle: true, write: false, format: "esm",
  plugins: [{ name: "workers-stub", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class DurableObject {} export class WorkflowEntrypoint {}" }));
  } }],
});
const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`)).default;
const TOKEN = "public-synthetic-vault-token".padEnd(40, "x");
const ID = "a".repeat(64);
function environment({ allow = true, answer = { response: "<think>hidden</think>{\"action\":\"answer\"}" } } = {}) {
  const calls = { ai: [], budgets: [], query: [], upsert: [], deleted: [] };
  return {
    calls, VAULT_AGENT_TOKEN: TOKEN, AGENT_DAILY_LIMIT: "1000",
    BUDGET: { getByName: name => ({ reserve: async limit => { calls.budgets.push([name, limit]); return allow; } }) },
    AI: { run: async (model, input) => {
      calls.ai.push([model, input]);
      return model === EMBEDDING_MODEL ? { data: (input.text).map((_, i) => [i, 0.5]) } : answer;
    } },
    CORPUS: {
      query: async (vector, options) => { calls.query.push([vector, options]); return { matches: [{ id: ID, score: 0.91234, metadata: { source: "vault", path: "Agents/A.md", title: "A", text: "Alpha" } }] }; },
      upsert: async vectors => { calls.upsert.push(vectors); },
      deleteByIds: async ids => { calls.deleted.push(ids); },
    },
  };
}

test("chat requests are bounded and validated before any model call", () => {
  assert.throws(() => chatRequest({ messages: [] }), /1-40/);
  assert.throws(() => chatRequest({ messages: [{ role: "tool", content: "x" }] }), /role/);
  assert.throws(() => chatRequest({ messages: [{ role: "user", content: "x" }], stream: true }), /Streaming/);
  assert.throws(() => chatRequest({ messages: [{ role: "user", content: "x" }], extra: 1 }), /Send only/);
  const parsed = chatRequest({ messages: [{ role: "user", content: "x" }], max_tokens: 99999, temperature: 5, response_format: { type: "json_object" } });
  assert.equal(parsed.maxTokens, 2000);
  assert.equal(parsed.temperature, 1);
  assert.equal(parsed.json, true);
});

test("chat uses fixed Qwen, its own 1000/day budget, and strips hidden reasoning", async () => {
  const env = environment();
  const result = await chat(env, { model: "anything", messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }], response_format: { type: "json_object" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.choices[0].message.content, '{"action":"answer"}');
  assert.deepEqual(env.calls.budgets, [["agent-chat-budget", 1000]]);
  const [model, input] = env.calls.ai[0];
  assert.equal(model, MODEL);
  assert.match(input.messages.at(-1).content, /\/no_think$/);
  assert.deepEqual(input.response_format, { type: "json_object" });
  const capped = environment({ allow: false });
  assert.equal((await chat(capped, { messages: [{ role: "user", content: "q" }] })).status, 429);
  assert.equal(capped.calls.ai.length, 0);
});

test("corpus search embeds the query once, filters by source and returns cited passages", async () => {
  const env = environment();
  const result = await search(env, { query: "agents", topK: 50, source: "vault" });
  assert.equal(result.body.matches[0].path, "Agents/A.md");
  assert.equal(result.body.matches[0].score, 0.912);
  assert.equal(env.calls.query[0][1].topK, 10);
  assert.deepEqual(env.calls.query[0][1].filter, { source: "vault" });
  await assert.rejects(search(env, { query: "x", source: "private" }), /source/);
});

test("upsert validates chunks, refuses credentials and stores metadata without the id", async () => {
  const env = environment();
  const chunk = { id: ID, source: "repo", path: "rabbit-web/README.md", title: "Readme", url: "https://example.com/a", text: "Hello" };
  assert.equal((await upsert(env, { chunks: [chunk] })).body.upserted, 1);
  assert.deepEqual(env.calls.upsert[0][0], { id: ID, values: [0, 0.5], metadata: { source: "repo", path: "rabbit-web/README.md", title: "Readme", url: "https://example.com/a", text: "Hello" } });
  assert.throws(() => chunkInput({ ...chunk, id: "short" }), /64 lowercase hex/);
  assert.throws(() => chunkInput({ ...chunk, url: "http://example.com" }), /https/);
  assert.throws(() => chunkInput({ ...chunk, text: "key ghp_abcdefghijklmnopqrstuvwxyz123456" }), /credential/);
  await assert.rejects(upsert(env, { chunks: [chunk, chunk] }), /Duplicate/);
  await assert.rejects(upsert(env, { chunks: Array(26).fill(chunk) }), /1-25/);
  assert.equal((await remove(env, { ids: [ID] })).body.deleted, 1);
  await assert.rejects(remove(env, { ids: ["x"] }), /chunk ids/);
});

test("live routes stay behind the bearer token", async () => {
  const env = environment();
  const call = (path, auth, body) => worker.fetch(new Request(`https://vault.test${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
  }), env);
  assert.equal((await call("/v1/corpus/search", null, { query: "x" })).status, 401);
  assert.equal((await call("/v1/corpus/search", "wrong".padEnd(40, "y"), { query: "x" })).status, 401);
  assert.equal((await call("/v1/corpus/search", TOKEN, { query: "x" })).status, 200);
  assert.equal((await call("/v1/chat/completions", TOKEN, { messages: [] })).status, 400);
  const unbound = { ...env, CORPUS: undefined };
  const response = await worker.fetch(new Request("https://vault.test/v1/corpus/search", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "{}" }), unbound);
  assert.equal(response.status, 503);
});

test("agent corpus tool posts to the fixed origin with the token and trims results", async () => {
  assert.throws(() => serviceOrigin("http://x.test/"), /HTTPS/);
  assert.throws(() => serviceOrigin("https://x.test/path"), /HTTPS origin/);
  assert.throws(() => corpusTool({ url: "https://x.test", token: TOKEN }), /allowRemote/);
  const sent = [];
  const tool = corpusTool({ url: "https://x.test", token: TOKEN, allowRemote: true }, async (url, init) => {
    sent.push([url, init]);
    return Response.json({ matches: Array(9).fill({ source: "repo", path: "p", text: "t".repeat(3000), score: 0.5 }) });
  });
  const result = await tool.execute({ query: "deploy", source: "repo" });
  assert.equal(result.matches.length, 6);
  assert.equal(result.matches[0].text.length, 1500);
  assert.equal(sent[0][0], "https://x.test/v1/corpus/search");
  assert.equal(sent[0][1].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(sent[0][1].redirect, "error");
  await assert.rejects(tool.execute({ query: "" }), /query/);
});

test("hosted config reads its token from a file outside the config, never inline", async () => {
  const folder = await mkdtemp(join(tmpdir(), "vault-live-"));
  try {
    const credentials = join(folder, "agent.env");
    await writeFile(credentials, `OTHER=1\nVAULT_AGENT_TOKEN=${TOKEN}\n`);
    const configPath = join(folder, "provider.json");
    await writeFile(configPath, JSON.stringify({ provider: { type: "openai-compatible", url: "https://x.test/v1/chat/completions", model: "m", allowRemote: true, tokenFile: credentials,
      corpus: { url: "https://x.test", allowRemote: true } } }));
    const config = await loadConfig(configPath);
    assert.equal(config.token, TOKEN);
    assert.equal(config.corpus.token, TOKEN);
    await writeFile(credentials, "VAULT_AGENT_TOKEN=short\n");
    await assert.rejects(tokenFromFile(credentials), /invalid/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("indexer chunks Markdown by sections, drops front matter and credential chunks, with stable ids", () => {
  const chunks = chunkMarkdown("---\nsecret: no\n---\n# A\n\none\n\n## B\n\n" + "x".repeat(4000), 1800);
  assert.equal(chunks[0], "# A\n\none\n\n## B");
  assert.equal(chunks.slice(1).join("").length, 4000);
  assert.ok(chunks.every(chunk => chunk.length <= 1800));
  const docs = documentChunks("vault", "Agents/A.md", "# Title\n\nsafe\n\n" + "y".repeat(1900) + "\n\nghp_abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(docs[0].title, "Title");
  assert.ok(docs.every(doc => !doc.text.includes("ghp_")));
  assert.equal(docs[0].id, chunkId("vault", "Agents/A.md", 0));
  assert.match(docs[0].id, /^[a-f0-9]{64}$/);
});
