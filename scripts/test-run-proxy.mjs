import assert from "node:assert/strict";
import test from "node:test";
import worker, { rewriteLocation } from "../workers/run-proxy/src/index.js";

const env = { ORIGIN: "https://rabbit-web-1087712653995.us-west2.run.app", PUBLIC_HOST: "run.rabbitsoftware.io" };

test("rewrites absolute origin redirects to the public host", () => {
  assert.equal(rewriteLocation(`${env.ORIGIN}/login?x=1`, env.ORIGIN, env.PUBLIC_HOST), "https://run.rabbitsoftware.io/login?x=1");
});

test("leaves relative and foreign redirects alone", () => {
  assert.equal(rewriteLocation("/login", env.ORIGIN, env.PUBLIC_HOST), "/login");
  assert.equal(rewriteLocation("https://example.com/a", env.ORIGIN, env.PUBLIC_HOST), "https://example.com/a");
});

test("rejects other hosts", async () => {
  const response = await worker.fetch(new Request("https://evil.example/"), env);
  assert.equal(response.status, 404);
});

test("proxies to the origin and rewrites redirects", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (request) => {
    seen.push(request);
    return new Response(null, { status: 307, headers: { location: `${env.ORIGIN}/login` } });
  });
  const response = await worker.fetch(new Request("https://run.rabbitsoftware.io/?a=b", { headers: { "cf-connecting-ip": "1.2.3.4" } }), env);
  assert.equal(seen[0].url, `${env.ORIGIN}/?a=b`);
  assert.equal(seen[0].headers.get("x-forwarded-host"), "run.rabbitsoftware.io");
  assert.equal(seen[0].headers.get("cf-connecting-ip"), null);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://run.rabbitsoftware.io/login");
});
