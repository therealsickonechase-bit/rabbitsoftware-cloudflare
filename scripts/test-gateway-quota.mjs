import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { reserveQuota } from "../workers/gateway/src/quota.mjs";

function storage(initial) {
  const data = new Map(initial ? [["day", structuredClone(initial)]] : []);
  let pending = Promise.resolve();
  return {
    data,
    transaction(action) {
      const result = pending.then(() => action({
        get: async key => structuredClone(data.get(key)),
        put: async (key, value) => data.set(key, structuredClone(value)),
      }));
      pending = result.catch(() => {});
      return result;
    },
  };
}

const request = (overrides = {}) => ({
  client: "a", perHour: 20, daily: 500, now: Date.parse("2026-10-12T12:00:00Z"), ...overrides,
});

test("gateway reservations retain hourly caps and enforce concurrent/daily boundaries", async () => {
  const state = storage();
  const results = await Promise.all(Array.from({ length: 40 }, () => reserveQuota(state, request())));
  assert.equal(results.filter(result => result.ok).length, 20);
  assert.equal(state.data.get("day").count, 20);
  const restored = storage(state.data.get("day"));
  assert.match((await reserveQuota(restored, request())).reason, /this hour/);
  assert.equal((await reserveQuota(restored, request({ client: "b", daily: 21 }))).ok, true);
  assert.match((await reserveQuota(restored, request({ client: "c", daily: 21 }))).reason, /today/);
  assert.equal(restored.data.get("day").count, 21);
});

test("gateway retains legacy daily counts, expires exact hourly boundaries, and preserves UTC rollover", async () => {
  const now = request().now;
  const legacy = storage({ day: "2026-10-12", count: 499 });
  assert.equal((await reserveQuota(legacy, request())).ok, true);
  assert.match((await reserveQuota(legacy, request({ client: "b" }))).reason, /today/);
  assert.equal(legacy.data.get("day").count, 500);
  const state = storage();
  assert.equal((await reserveQuota(state, request({ perHour: 1 }))).ok, true);
  assert.equal((await reserveQuota(state, request({ perHour: 1, now: now + 3599999 }))).ok, false);
  assert.equal((await reserveQuota(state, request({ perHour: 1, now: now + 3600000 }))).ok, true);
  assert.deepEqual(state.data.get("day").hourly.a, [now + 3600000]);
  assert.equal((await reserveQuota(state, request({ now: Date.parse("2026-10-13T00:00:00Z") }))).ok, true);
  assert.equal(state.data.get("day").count, 1);
});

test("actual gateway Durable Object retains hourly and daily budgets across workerd restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rabbit-gateway-quota-"));
  const bundled = await build({
    stdin: { contents: `import { Limits } from "./workers/gateway/src/handler.mjs";
      export { Limits };
      export default { async fetch(request, env) {
        return env.LIMITS.getByName("everyone").fetch(new Request("https://limits/", {
          method: "POST", body: await request.text()
        }));
      }};`, resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", external: ["cloudflare:workers"],
  });
  const config = {
    ...convertV4MiniflareOptions({ workers: [{
      name: "gateway-quota-test", modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-09-01",
      durableObjects: { LIMITS: { className: "Limits", useSQLite: true } },
    }] }),
    resourcePersistencePath: directory,
  };
  let runtime;
  try {
    runtime = new Miniflare(config);
    const reserve = async (overrides = {}) => (await runtime.dispatchFetch("http://test/", {
      method: "POST", body: JSON.stringify(request({ perHour: 2, daily: 3, ...overrides })),
    })).json();
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => reserve()));
    assert.equal(concurrent.filter(result => result.ok).length, 2);
    assert.match((await reserve()).reason, /this hour/);
    await runtime.dispose();
    runtime = new Miniflare(config);
    assert.match((await reserve()).reason, /this hour/);
    assert.equal((await reserve({ client: "b" })).ok, true);
    await runtime.dispose();
    runtime = new Miniflare(config);
    assert.match((await reserve({ client: "c" })).reason, /today/);
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("maintainable gateway entry preserves non-inference health, CORS and validation behavior", async () => {
  const bundled = await build({
    entryPoints: ["workers/gateway/src/handler.mjs"], bundle: true, write: false,
    format: "esm", external: ["cloudflare:workers"],
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "gateway-handler-parity", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-09-01",
    durableObjects: { LIMITS: { className: "Limits", useSQLite: true } },
    bindings: { CHAT_ALLOWED_ORIGINS: "https://rabbitsoftware.io" },
  }] }));
  try {
    const health = await runtime.dispatchFetch("https://gateway/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      service: "RabbitSoftware.inc model gateway", ok: true, api: "POST /v1/chat/completions",
    });
    assert.equal(health.headers.get("Cache-Control"), "no-store");
    const preflight = await runtime.dispatchFetch("https://gateway/v1/chat/completions", {
      method: "OPTIONS", headers: { Origin: "https://rabbitsoftware.io" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://rabbitsoftware.io");
    const denied = await runtime.dispatchFetch("https://gateway/health", {
      headers: { Origin: "https://unapproved.invalid" },
    });
    assert.equal(denied.status, 403);
    const missing = await runtime.dispatchFetch("https://gateway/unknown");
    assert.equal(missing.status, 404);
    const unconfigured = await runtime.dispatchFetch("https://gateway/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Public synthetic request" }] }),
    });
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(await unconfigured.json(), { error: "the gateway isn't set up yet" });
  } finally { await runtime.dispose(); }
});
