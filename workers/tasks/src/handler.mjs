import { cleanRequest } from "../../gateway/src/index.js";
import { boundedJson } from "../../qwen/src/handler.mjs";
import { checkCredentials } from "../../vault-agent/src/protocol.mjs";
import { KINDS, MAX_INPUT_CHARS } from "./board.mjs";

export const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const MAX_TOKENS = 1200;
const TASK_PATH = /^\/v1\/tasks\/([a-f0-9]{32})$/;

export async function clientHash(request) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.headers.get("CF-Connecting-IP") || "unknown"));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function taskInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["kind", "input"].includes(key))) {
    throw new Error("Send exactly {\"kind\", \"input\"}.");
  }
  if (!Object.hasOwn(KINDS, value.kind)) throw new Error(`kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
  if (typeof value.input !== "string" || !value.input.trim()) throw new Error("Describe the task.");
  const input = value.input.trim();
  if (input.length > MAX_INPUT_CHARS) throw new Error(`The task is too long (at most ${MAX_INPUT_CHARS} characters).`);
  // Same personal-information refusal as the public chat gateway, plus the vault agent's credential check.
  cleanRequest({ messages: [{ role: "user", content: input }] }, MAX_INPUT_CHARS, MAX_TOKENS);
  try { checkCredentials(input); } catch { throw new Error("The task appears to contain a credential. Remove it first."); }
  return { kind: value.kind, input };
}

/** Run one task with fixed hosted Qwen. No retries and no other provider. */
export async function runTask(env, task) {
  const result = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: `${KINDS[task.kind]} Answer in plain text or simple Markdown.` },
      { role: "user", content: `${task.input}\n/no_think` },
    ],
    max_tokens: MAX_TOKENS, temperature: 0.2, stream: false,
  });
  const answer = result?.choices?.[0]?.message?.content ?? result?.response;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("no answer");
  return answer.replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 16000);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = new Set(String(env.TASK_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean));
    const reply = (status, data) => new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin",
        ...(allowed.has(origin) ? {
          "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600",
        } : {}),
      },
    });
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") return reply(200, { ok: true, model: MODEL, kinds: Object.keys(KINDS) });
    if (origin && !allowed.has(origin)) return reply(403, { error: "Origin is not allowed." });
    if (request.method === "OPTIONS") return reply(204);
    const board = env.TASK_BOARD.getByName("public-tasks");
    const match = path.match(TASK_PATH);
    if (match) {
      if (request.method !== "GET") return reply(405, { error: "Use GET." });
      const task = await board.get(match[1]);
      return task ? reply(200, task) : reply(404, { error: "No such task (results are kept for 7 days)." });
    }
    if (path !== "/v1/tasks") return reply(404, { error: "Not found." });
    if (request.method !== "POST") return reply(405, { error: "Use POST." });
    if (!origin) return reply(403, { error: "Submit tasks from the website." });
    if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
      return reply(415, { error: "Send application/json." });
    }
    let task;
    try { task = taskInput(await boundedJson(request)); }
    catch (error) { return reply(400, { error: error instanceof SyntaxError ? "Send valid JSON." : error.message }); }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    const verdict = await board.submit({ id, ...task, client: await clientHash(request) });
    return verdict.ok ? reply(202, verdict) : reply(verdict.status, { error: verdict.error });
  },
};
