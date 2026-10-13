import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Board, KINDS, limits } from "../workers/tasks/src/board.mjs";
import handler, { MAX_TOKENS, MODEL, runTask, taskInput } from "../workers/tasks/src/handler.mjs";

// Durable Object style sql.exec backed by real SQLite.
function sqlite() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...params) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
}
const board = (config = {}) => {
  const b = new Board(sqlite(), { ...limits(), ...config });
  b.init();
  return b;
};
const NOON = Date.UTC(2026, 9, 13, 12);
const task = (id, client = "c1") => ({ id: id.padStart(32, "0"), kind: "answer", input: "What is a Worker?", client });

test("limits fall back to safe defaults", () => {
  assert.deepEqual(limits({ TASK_DAILY_LIMIT: "x", TASKS_PER_CLIENT_PER_HOUR: "-1" }), { daily: 100, perHour: 5, maxQueued: 25, retentionDays: 7 });
});

test("per-visitor hourly, daily and queue caps refuse before queueing", () => {
  const b = board({ perHour: 2, daily: 3, maxQueued: 10 });
  assert.equal(b.submit(task("1"), NOON).ok, true);
  assert.equal(b.submit(task("2"), NOON).position, 2);
  assert.equal(b.submit(task("3"), NOON).status, 429);
  assert.equal(b.submit(task("4", "c2"), NOON).ok, true);
  assert.match(b.submit(task("5", "c3"), NOON).error, /today's limit/);
  assert.equal(b.submit(task("6", "c1"), NOON + 3600001 + 86400000).ok, true, "a new day and hour reset both caps");
  const full = board({ maxQueued: 1 });
  full.submit(task("1"), NOON);
  assert.equal(full.submit(task("2", "c2"), NOON).status, 503);
});

test("tasks run oldest first, store the result and drop the visitor's input", () => {
  const b = board();
  b.submit(task("1"), NOON);
  b.submit(task("2", "c2"), NOON + 1);
  assert.equal(b.get(task("2").id).position, 2);
  const first = b.next(NOON + 2);
  assert.equal(first.id, task("1").id);
  assert.equal(b.get(first.id).status, "running");
  b.finish(first.id, { result: "An edge function." }, NOON + 3);
  const done = b.get(first.id);
  assert.equal(done.status, "done");
  assert.equal(done.result, "An edge function.");
  assert.equal(done.input, undefined);
  assert.equal(b.sql.exec("SELECT input FROM tasks WHERE id = ?", first.id).one().input, "");
  assert.equal(b.get(task("2").id).position, 1);
  assert.equal(b.get("f".repeat(32)), null);
});

test("a task left running by a crash fails instead of rerunning, and old results are pruned", () => {
  const b = board();
  b.submit(task("1"), NOON);
  b.next(NOON);
  assert.equal(b.next(NOON + 60000), null, "still running, nothing else queued");
  b.next(NOON + 6 * 60000);
  assert.equal(b.get(task("1").id).status, "failed");
  b.finish(task("1").id, { result: "late" }, NOON + 7 * 60000);
  assert.equal(b.get(task("1").id).result, null, "a failed task is not overwritten");
  b.prune(NOON + 8 * 86400000);
  assert.equal(b.get(task("1").id), null);
});

const site = "https://rabbitsoftware.io";
function environment(verdict = { ok: true, status: "queued", position: 1 }) {
  const calls = { submit: [], get: [] };
  return {
    calls, TASK_ALLOWED_ORIGINS: `${site},https://preview.rabbitsoftware-site.pages.dev`,
    TASK_BOARD: { getByName: () => ({
      submit: async value => { calls.submit.push(value); return verdict.ok ? { ...verdict, id: value.id } : verdict; },
      get: async id => { calls.get.push(id); return id === "a".repeat(32) ? { id, status: "done", result: "ok" } : null; },
    }) },
  };
}
const post = (body, origin = site, type = "application/json") => new Request("https://tasks.test/v1/tasks", {
  method: "POST", headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": type, "CF-Connecting-IP": "203.0.113.9" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("bad origins, missing origin, content types and inputs are refused before queueing", async () => {
  const env = environment();
  for (const [request, status] of [
    [post({ kind: "answer", input: "hi" }, "https://evil.test"), 403],
    [post({ kind: "answer", input: "hi" }, ""), 403],
    [post({ kind: "answer", input: "hi" }, site, "text/plain"), 415],
    [post("{", site), 400],
    [post({ kind: "shell", input: "ls" }), 400],
    [post({ kind: "answer", input: "hi", extra: 1 }), 400],
    [post({ kind: "answer", input: "   " }), 400],
    [post({ kind: "answer", input: "x".repeat(8001) }), 400],
    [post({ kind: "answer", input: "email me at person@example.com" }), 400],
    [post({ kind: "explain", input: "token ghp_abcdefghijklmnopqrstuvwxyz123456" }), 400],
  ]) assert.equal((await handler.fetch(request, env)).status, status);
  assert.equal(env.calls.submit.length, 0);
});

test("an accepted task gets a random id and only a hashed visitor address is stored", async () => {
  const env = environment();
  const response = await handler.fetch(post({ kind: "summarize", input: "  Workers run at the edge.  " }), env);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), site);
  const body = await response.json();
  assert.match(body.id, /^[a-f0-9]{32}$/);
  const [submitted] = env.calls.submit;
  assert.equal(submitted.input, "Workers run at the edge.");
  assert.match(submitted.client, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(submitted).includes("203.0.113.9"));
});

test("quota refusals keep their status and CORS so the page can show them", async () => {
  const response = await handler.fetch(post({ kind: "answer", input: "hi" }), environment({ ok: false, status: 429, error: "limit" }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), site);
});

test("results are read by exact id only; health and preflight work", async () => {
  const env = environment();
  const get = path => handler.fetch(new Request(`https://tasks.test${path}`, { headers: { Origin: site } }), env);
  assert.equal((await (await get(`/v1/tasks/${"a".repeat(32)}`)).json()).result, "ok");
  assert.equal((await get(`/v1/tasks/${"b".repeat(32)}`)).status, 404);
  assert.equal((await get("/v1/tasks/../admin")).status, 404);
  assert.equal((await get("/v1/tasks/ABC")).status, 404);
  assert.deepEqual(env.calls.get, ["a".repeat(32), "b".repeat(32)]);
  const health = await handler.fetch(new Request("https://tasks.test/health"), env);
  assert.deepEqual((await health.json()).kinds, Object.keys(KINDS));
  const preflight = await handler.fetch(new Request("https://tasks.test/v1/tasks", { method: "OPTIONS", headers: { Origin: site } }), env);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("runTask uses only fixed hosted Qwen with bounded output and strips hidden reasoning", async () => {
  const calls = [];
  const env = { AI: { run: async (...args) => { calls.push(args); return { response: "<think>x</think> Final answer." }; } } };
  assert.equal(await runTask(env, { kind: "answer", input: "Why?" }), "Final answer.");
  assert.equal(calls[0][0], MODEL);
  assert.equal(calls[0][1].max_tokens, MAX_TOKENS);
  assert.equal(calls[0][1].messages[0].role, "system");
  await assert.rejects(runTask({ AI: { run: async () => ({ response: " " }) } }, { kind: "answer", input: "Why?" }), /no answer/);
  assert.deepEqual(taskInput({ kind: "explain", input: " a " }), { kind: "explain", input: "a" });
});
