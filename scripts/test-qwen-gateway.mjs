import assert from "node:assert/strict";
import test from "node:test";
import handler, { MODEL, boundedJson } from "../workers/qwen/src/handler.mjs";

const request = (body, origin = "https://rabbitsoftware.io") => new Request("https://qwen.test/v1/chat/completions", {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const payload = { messages: [{ role: "user", content: "Explain software simulations." }] };
function environment(verdict = { ok: true }, result = { choices: [{ message: { content: "A model of a process." } }] }) {
  const calls = [];
  return {
    calls, CHAT_ALLOWED_ORIGINS: "https://rabbitsoftware.io,https://app.rabbitsoftware.io",
    QWEN_LIMITS: { getByName: () => ({ reserve: async () => verdict }) },
    AI: { run: async (...args) => { calls.push(args); return result; } },
  };
}

test("origins, content types, empty and personal prompts fail before inference", async () => {
  const env = environment();
  for (const [req, status] of [
    [request(payload, "https://untrusted.test"), 403],
    [request(payload, ""), 403],
    [request({ messages: [{ role: "user", content: "contact me at person@example.com" }] }), 400],
    [request({ messages: [{ role: "user", content: " " }] }), 400],
    [new Request("https://qwen.test/v1/chat/completions", { method: "POST", headers: { Origin: "https://rabbitsoftware.io" }, body: "{}" }), 415],
  ]) assert.equal((await handler.fetch(req, env)).status, status);
  assert.equal(env.calls.length, 0);
});

test("chunked bodies are bounded even without Content-Length", async () => {
  await assert.rejects(boundedJson(new Request("https://test", { method: "POST", body: "x".repeat(65537) })), /64 KiB/);
});

test("quota denial prevents inference and is exposed to allowed origins", async () => {
  const env = environment({ ok: false, error: "Daily limit reached." });
  const response = await handler.fetch(request(payload), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://rabbitsoftware.io");
  assert.equal(env.calls.length, 0);
});

test("only fixed hosted Qwen is called, with bounded output and OpenAI-compatible answer", async () => {
  const env = environment();
  const response = await handler.fetch(request({ ...payload, model: "other", max_tokens: 9999 }), env);
  assert.equal(response.status, 200);
  assert.equal(env.calls[0][0], MODEL);
  assert.equal(env.calls[0][1].max_tokens, 700);
  assert.equal((await response.json()).choices[0].message.content, "A model of a process.");
});

test("empty or failed provider responses report failure without fallback", async () => {
  for (const result of [{}, { response: "" }]) {
    const env = environment({ ok: true }, result);
    assert.equal((await handler.fetch(request(payload), env)).status, 502);
    assert.equal(env.calls.length, 1);
  }
  const env = environment();
  env.AI.run = async () => { throw new Error("upstream down"); };
  assert.equal((await handler.fetch(request(payload), env)).status, 502);
});
