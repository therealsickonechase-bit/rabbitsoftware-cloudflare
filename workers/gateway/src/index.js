var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var MODEL_NAME = "rabbitsoftware";
var PERSONAL_PATTERNS = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(date of birth|born on|d\.?o\.?b\.?)\b/i,
  /\b\d{1,5}\s+(\w+\s+){1,3}(street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way)\b\.?/i,
  /[ACGTUacgtu]{30,}/
];
function containsPersonalInformation(text) {
  const phone = text.match(/(?<![\w-])\+?\d[\d ().-]{7,}\d(?![\w-])/);
  return PERSONAL_PATTERNS.some((pattern) => pattern.test(text)) || Boolean(phone && (phone[0].match(/\d/g) || []).length >= 9);
}
__name(containsPersonalInformation, "containsPersonalInformation");
function number(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
__name(number, "number");
function json(status, data) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
__name(json, "json");
function corsOrigins(env) {
  return new Set(String(env.CHAT_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
}
__name(corsOrigins, "corsOrigins");
function withCors(request, env, response) {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  if (!corsOrigins(env).has(origin)) return json(403, { error: "origin is not allowed" });
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  const vary = new Set((headers.get("Vary") || "").split(",").map((value) => value.trim()).filter(Boolean));
  vary.add("Origin");
  headers.set("Vary", [...vary].join(", "));
  return new Response(response.body, { status: response.status, headers });
}
__name(withCors, "withCors");
function cleanRequest(body, maxPromptChars, maxTokens) {
  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 8) {
    throw new Error("send 1 to 8 messages");
  }
  let total = 0;
  const kept = messages.map((m) => {
    if (!m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") {
      throw new Error("each message needs a role (system, user or assistant) and text content");
    }
    if (containsPersonalInformation(m.content)) {
      throw new Error("the request appears to contain personal information; use the local assistant instead");
    }
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > maxPromptChars) throw new Error(`the question is too long (at most ${maxPromptChars} characters)`);
  const wanted = Number(body.max_tokens ?? maxTokens);
  const temperature = Number(body.temperature ?? 0.2);
  if (!Number.isFinite(wanted) || !Number.isFinite(temperature)) {
    throw new Error("max_tokens and temperature must be numbers");
  }
  return {
    model: MODEL_NAME,
    messages: kept,
    max_tokens: Math.max(1, Math.min(Math.trunc(wanted) || maxTokens, maxTokens)),
    temperature: Math.max(0, Math.min(temperature, 1.5)),
    stream: false
  };
}
__name(cleanRequest, "cleanRequest");
var Limits = class {
  static {
    __name(this, "Limits");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.recent = /* @__PURE__ */ new Map();
  }
  async fetch(request) {
    const { client, perHour, daily, now = Date.now() } = await request.json();
    const day = new Date(now).toISOString().slice(0, 10);
    let state = await this.ctx.storage.get("day") || { day, count: 0 };
    if (state.day !== day) {
      state = { day, count: 0 };
      this.recent.clear();
    }
    if (state.count >= daily) {
      return json(200, { ok: false, reason: "the model has answered all the questions it can today; try again tomorrow (UTC)" });
    }
    const times = (this.recent.get(client) || []).filter((t) => now - t < 36e5);
    if (times.length >= perHour) {
      this.recent.set(client, times);
      return json(200, { ok: false, reason: "too many questions this hour; try again later" });
    }
    times.push(now);
    this.recent.set(client, times);
    state.count += 1;
    await this.ctx.storage.put("day", state);
    return json(200, { ok: true });
  }
};
async function hashed(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashed, "hashed");
async function forward(env, payload) {
  let url = String(env.ENDPOINT_URL || "").replace(/\/+$/, "");
  url = url.endsWith("/v1") ? `${url}/chat/completions` : `${url}/v1/chat/completions`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${env.HF_TOKEN}` },
      body: JSON.stringify(payload)
    });
  } catch {
    return json(503, { error: "the model couldn't be reached; it may be waking up" });
  }
  if (!response.ok) {
    return json([502, 503, 504].includes(response.status) ? 503 : 502, { error: `the model returned HTTP ${response.status}` });
  }
  return new Response(response.body, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
__name(forward, "forward");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && !corsOrigins(env).has(origin)) return json(403, { error: "origin is not allowed" });
    if (request.method === "OPTIONS") {
      if (url.pathname !== "/v1/chat/completions" || !origin) return json(404, { error: "not found" });
      return withCors(request, env, new Response(null, { status: 204 }));
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return withCors(request, env, json(200, { service: "RabbitSoftware.inc model gateway", ok: true, api: "POST /v1/chat/completions" }));
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return withCors(request, env, json(404, { error: "not found" }));
    if (!env.ENDPOINT_URL || !env.HF_TOKEN) return withCors(request, env, json(503, { error: "the gateway isn't set up yet" }));
    const maxPromptChars = number(env.MAX_PROMPT_CHARS, 12e3);
    if (Number(request.headers.get("Content-Length") || 0) > maxPromptChars * 4 + 4096) {
      return withCors(request, env, json(413, { error: "the question is too long" }));
    }
    let payload;
    try {
      payload = cleanRequest(await request.json(), maxPromptChars, number(env.MAX_TOKENS, 400));
    } catch (error) {
      return withCors(request, env, json(400, { error: error instanceof SyntaxError ? "send JSON" : error.message }));
    }
    const client = await hashed(request.headers.get("CF-Connecting-IP") || "unknown");
    const limits = env.LIMITS.get(env.LIMITS.idFromName("everyone"));
    const verdict = await (await limits.fetch("https://limits/check", {
      method: "POST",
      body: JSON.stringify({ client, perHour: number(env.PER_CLIENT_PER_HOUR, 20), daily: number(env.DAILY_LIMIT, 500) })
    })).json();
    if (!verdict.ok) return withCors(request, env, json(429, { error: verdict.reason }));
    return withCors(request, env, await forward(env, payload));
  }
};
export {
  Limits,
  cleanRequest,
  index_default as default
};
//# sourceMappingURL=index.js.map
