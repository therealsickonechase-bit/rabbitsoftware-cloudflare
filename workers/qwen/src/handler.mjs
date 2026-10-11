import { cleanRequest } from "../../gateway/src/index.js";

export const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const MAX_BYTES = 65536;

export function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function boundedJson(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES) {
    throw new Error("Request exceeds 64 KiB.");
  }
  if (!request.body) throw new Error("Send a JSON body.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Request exceeds 64 KiB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = new Set(String(env.CHAT_ALLOWED_ORIGINS).split(","));
    const reply = (status, data) => new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Vary": "Origin",
        ...(allowed.has(origin) ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        } : {}),
      },
    });
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return reply(200, { ok: true, model: MODEL });
    }
    if (!allowed.has(origin)) return reply(403, { error: "Origin is not allowed." });
    if (path !== "/v1/chat/completions") return reply(404, { error: "Not found." });
    if (request.method === "OPTIONS") return reply(204);
    if (request.method !== "POST") return reply(405, { error: "Use POST." });
    if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
      return reply(415, { error: "Send application/json." });
    }
    let payload;
    try {
      payload = cleanRequest(await boundedJson(request), 24000, 700);
      if (payload.messages.some(message => !message.content.trim())) {
        throw new Error("Messages cannot be empty.");
      }
    } catch (error) {
      return reply(400, { error: error instanceof SyntaxError ? "Send valid JSON." : error.message });
    }
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
        request.headers.get("CF-Connecting-IP") || "unknown",
      ));
      const client = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const verdict = await env.QWEN_LIMITS.getByName("daily-inference-budget").reserve(client);
      if (!verdict.ok) return reply(429, { error: verdict.error });
      const result = await env.AI.run(MODEL, {
        messages: payload.messages.map((message, index) => index === payload.messages.length - 1 && message.role === "user"
          ? { ...message, content: `${message.content}\n/no_think` } : message),
        max_tokens: payload.max_tokens,
        temperature: payload.temperature,
        stream: false,
      });
      const answer = result?.choices?.[0]?.message?.content ?? result?.response;
      if (typeof answer !== "string" || !answer.trim()) {
        throw new Error("Qwen returned no answer.");
      }
      return reply(200, { model: MODEL, choices: [{ message: { role: "assistant", content: answer.trim() } }] });
    } catch (error) {
      console.error(JSON.stringify({ event: "qwen_request_failed", type: error?.name || "Error" }));
      return reply(502, { error: "Hosted Qwen could not answer. Please retry later; no other provider was contacted." });
    }
  },
};
