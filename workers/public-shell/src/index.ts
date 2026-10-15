// Public sandbox shell: one throwaway container per visitor session, behind Turnstile, quotas and an egress allowlist.
// No bindings to Supabase, the vault or owner secrets exist in this Worker. See README.md.
import { DurableObject } from "cloudflare:workers";
import { ContainerProxy, getSandbox, Sandbox, type Terminal } from "@cloudflare/sandbox";
import { LIMITS, WS_PROTOCOL, allowedOrigins, originAllowed, shellEnabled } from "./limits.mjs";
import * as quota from "./quota.mjs";
import { ipKey, newSessionId, secretUsable, signToken, verifyToken } from "./tokens.mjs";
import { EGRESS_HOSTS, egressDecision } from "./egress.mjs";
import { buildKeyEnv, logLine, terminalEnv } from "./env.mjs";
import { countCommands, inputBudget, parseClientFrame } from "./frames.mjs";
import { verifyTurnstile } from "./turnstile.mjs";

export { ContainerProxy };

/** The visitor container. Egress is limited to EGRESS_HOSTS by the platform allowlist and again by the handler below. */
export class PublicSandbox extends Sandbox<Env> {
  enableInternet = true;
  interceptHttps = true;
  allowedHosts = [...EGRESS_HOSTS];
  static outbound = (request: Request): Promise<Response> | Response => {
    const decision = egressDecision(request.url, request.method);
    if (!decision.allow) return new Response(`egress blocked: ${decision.reason}`, { status: 403 });
    return fetch(request);
  };
}

type GateResult = { ok: boolean; reason?: string; expiresAt?: number; remaining?: number };

/** Single global coordination point: session counts, per-address caps, daily quotas, expiry. Stores no keys and no raw IPs. */
export class Gate extends DurableObject<Env> {
  private async load(): Promise<ReturnType<typeof quota.emptyState>> {
    return (await this.ctx.storage.get<ReturnType<typeof quota.emptyState>>("state")) ?? quota.emptyState();
  }

  private async save(state: ReturnType<typeof quota.emptyState>): Promise<void> {
    await this.ctx.storage.put("state", state);
    const at = quota.nextAlarm(state, Date.now());
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  async admit(sid: string, ipKeyValue: string): Promise<GateResult> {
    const state = await this.load();
    await this.reap(state);
    const result = quota.admit(state, { now: Date.now(), ipKey: ipKeyValue, sid });
    await this.save(state);
    return result;
  }

  async attach(sid: string): Promise<GateResult> {
    const state = await this.load();
    const result = quota.attach(state, sid, Date.now());
    await this.save(state);
    return result;
  }

  async detach(sid: string): Promise<void> {
    const state = await this.load();
    quota.detach(state, sid);
    await this.save(state);
  }

  async touch(sid: string): Promise<boolean> {
    const state = await this.load();
    const ok = quota.touch(state, sid, Date.now());
    await this.save(state);
    return ok;
  }

  async commands(sid: string, n: number): Promise<GateResult> {
    const state = await this.load();
    const result = quota.consumeCommands(state, sid, n, Date.now());
    await this.save(state);
    return result;
  }

  async end(sid: string): Promise<void> {
    const state = await this.load();
    quota.release(state, sid);
    await this.save(state);
    await this.destroy(sid);
  }

  async alarm(): Promise<void> {
    const state = await this.load();
    await this.reap(state);
    // Kill switch: when the operator turns the service off, every live sandbox is destroyed on the next sweep.
    if (!shellEnabled(this.env)) {
      for (const sid of Object.keys(state.sessions)) { quota.release(state, sid); await this.destroy(sid); }
    }
    await this.save(state);
  }

  private async reap(state: ReturnType<typeof quota.emptyState>): Promise<void> {
    for (const { sid, reason } of quota.expired(state, Date.now())) {
      console.log(logLine({ event: "expire", sid, reason }));
      quota.release(state, sid);
      await this.destroy(sid);
    }
  }

  private async destroy(sid: string): Promise<void> {
    try { await getSandbox(this.env.SANDBOX, sid).destroy(); } catch (error) {
      console.log(logLine({ event: "destroy_failed", sid, reason: error instanceof Error ? error.name : "error" }));
    }
  }
}

const gateOf = (env: Env) => env.GATE.getByName("global");

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" };
  if (origin && originAllowed(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

const reply = (request: Request, env: Env, status: number, body: unknown) =>
  Response.json(body, { status, headers: cors(request, env) });

async function boundedText(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(all);
}

async function createSession(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return reply(request, env, 415, { error: "Send application/json." });
  const text = await boundedText(request, LIMITS.maxSessionBodyBytes);
  let body: { turnstile?: unknown } = {};
  try { body = text ? JSON.parse(text) : {}; } catch { return reply(request, env, 400, { error: "Bad JSON." }); }
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (!ip) return reply(request, env, 400, { error: "No client address." });
  if (!secretUsable(env.SESSION_SIGNING_KEY)) return reply(request, env, 503, { error: "Not configured." });

  const verdict = await verifyTurnstile({ token: body.turnstile, secret: env.TURNSTILE_SECRET_KEY, ip });
  if (!verdict.ok) {
    console.log(logLine({ event: "turnstile_denied", reason: verdict.reason }));
    return reply(request, env, 403, { error: "Human check failed. Reload and try again.", reason: verdict.reason });
  }
  const sid = newSessionId();
  const admitted = await gateOf(env).admit(sid, await ipKey(env.SESSION_SIGNING_KEY, ip));
  if (!admitted.ok) {
    const message: Record<string, string> = {
      global_cap: "All public sandboxes are busy. Try again in a few minutes.",
      ip_cap: "You already have a live sandbox. Close it or wait for it to expire.",
      daily_sessions: "Daily sandbox limit reached for your address. Try again tomorrow.",
    };
    return reply(request, env, 429, { error: message[admitted.reason ?? ""] ?? "Not available.", reason: admitted.reason });
  }
  const exp = admitted.expiresAt ?? Date.now() + LIMITS.tokenTtlMs;
  const token = await signToken(env.SESSION_SIGNING_KEY, { sid, exp });
  console.log(logLine({ event: "session_created", sid }));
  return reply(request, env, 200, {
    token, expiresAt: exp,
    limits: { idleMs: LIMITS.idleMs, maxLifetimeMs: LIMITS.maxLifetimeMs, maxFrameBytes: LIMITS.maxFrameBytes, commandsPerDay: LIMITS.maxCommandsPerIpPerDay, protocol: WS_PROTOCOL },
  });
}

function tokenFromProtocols(request: Request): string | null {
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
  if (!offered.includes(WS_PROTOCOL)) return null;
  return offered.find((p) => p !== WS_PROTOCOL && p.length > 0) ?? null;
}

async function connectTerminal(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return reply(request, env, 426, { error: "WebSocket required." });
  if (!originAllowed(request.headers.get("Origin"), env)) return new Response("Forbidden origin", { status: 403 });
  const claims = await verifyToken(env.SESSION_SIGNING_KEY, tokenFromProtocols(request));
  if (!claims) return new Response("Invalid or expired session", { status: 401 });

  const gate = gateOf(env);
  const attached = await gate.attach(claims.sid);
  if (!attached.ok) return new Response(`Session unavailable: ${attached.reason}`, { status: attached.reason === "already_attached" ? 409 : 410 });

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  void bridge(server, env, claims.sid, attached.expiresAt ?? Date.now() + LIMITS.maxLifetimeMs)
    .catch((error) => { console.log(logLine({ event: "bridge_error", sid: claims.sid, reason: error instanceof Error ? error.name : "error" })); safeClose(server, 1011, "bridge error"); })
    .finally(() => gate.end(claims.sid).catch(() => undefined));   // free the slot and destroy the container as soon as the terminal closes
  return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL } });
}

function safeClose(ws: WebSocket, code: number, reason: string) {
  try { ws.close(code, reason.slice(0, 100)); } catch { /* already closed */ }
}

const text = (ws: WebSocket, message: string) => { try { ws.send(new TextEncoder().encode(`\r\n\x1b[33m[sandbox] ${message}\x1b[0m\r\n`)); } catch { /* closed */ } };

/** Pump frames between the browser and one PTY. Keys from the hello frame go into this launch's env only. */
async function bridge(ws: WebSocket, env: Env, sid: string, expiresAt: number): Promise<void> {
  const gate = gateOf(env);
  let terminal: Terminal | null = null;
  let started = false;
  let output = 0;
  let lastTouch = 0;
  const budget = { windowStart: Date.now(), used: 0 };
  const encoder = new TextEncoder();
  let chain: Promise<void> = Promise.resolve();   // serialise handling so input order is kept
  let closed!: () => void;
  const done = new Promise<void>((resolve) => { closed = resolve; });

  const hello = setTimeout(() => { if (!started) { safeClose(ws, 1008, "hello timeout"); closed(); } }, LIMITS.helloTimeoutMs);
  const lifetime = setTimeout(() => { text(ws, "Session time limit reached. Goodbye."); safeClose(ws, 1000, "max lifetime"); closed(); }, Math.max(1000, expiresAt - Date.now()));

  const handle = async (data: string) => {
    if (!shellEnabled(env)) { text(ws, "The public sandbox has been switched off."); safeClose(ws, 1013, "disabled"); closed(); return; }
    const parsed = parseClientFrame(data, { first: !started });
    if (!parsed.ok) { safeClose(ws, parsed.close, parsed.error); closed(); return; }
    const frame = parsed.frame as { t: string; cols: number; rows: number; d: string; keys?: unknown };
    if (frame.t === "hello") {
      const keys = buildKeyEnv(frame.keys);
      if (!keys.ok) { safeClose(ws, 1008, keys.error); closed(); return; }
      started = true;
      clearTimeout(hello);
      const sandbox = getSandbox(env.SANDBOX, sid, { sleepAfter: "10m", keepAlive: false, containerTimeouts: { instanceGetTimeoutMS: 30000, portReadyTimeoutMS: 90000 } });
      terminal = await sandbox.createTerminal({
        command: ["/usr/sbin/runuser", "-u", "visitor", "--", "/bin/bash", "-l"],
        cwd: "/workspace", env: terminalEnv(keys.env), cols: frame.cols, rows: frame.rows, bufferSize: 256 * 1024,
      });
      void pump(terminal);
      return;
    }
    if (!terminal) return;
    if (frame.t === "r") { await terminal.resize(frame.cols, frame.rows); return; }
    const size = encoder.encode(frame.d).length;
    if (!inputBudget(budget, size, Date.now())) { text(ws, "Input too fast; dropped."); return; }
    const lines = countCommands(frame.d);
    if (lines > 0) {
      const spent = await gate.commands(sid, lines);
      if (!spent.ok) { text(ws, spent.reason === "daily_commands" ? "Daily command limit reached for your address." : "Session is over."); if (spent.reason !== "daily_commands") { safeClose(ws, 1000, "over"); closed(); } return; }
    }
    const now = Date.now();
    if (now - lastTouch > 20_000) { lastTouch = now; if (!(await gate.touch(sid))) { safeClose(ws, 1000, "expired"); closed(); return; } }
    await terminal.write(encoder.encode(frame.d));
  };

  const pump = async (t: Terminal) => {
    try {
      const stream = await t.output({ follow: true, replay: true });
      const reader = stream.getReader();
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        if (value.type === "data") {
          output += value.data.length;
          if (output > LIMITS.maxOutputBytes) { text(ws, "Output limit reached; closing."); await t.terminate().catch(() => undefined); safeClose(ws, 1009, "output limit"); closed(); return; }
          ws.send(value.data);
        } else if (value.type === "terminal") { text(ws, "Shell exited."); safeClose(ws, 1000, "exited"); closed(); return; }
      }
    } catch (error) { console.log(logLine({ event: "pump_error", sid, reason: error instanceof Error ? `${error.name}: ${error.message}` : "error" })); safeClose(ws, 1011, "terminal error"); closed(); }
  };

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") { safeClose(ws, 1003, "text frames only"); closed(); return; }
    chain = chain.then(() => handle(event.data as string)).catch((error) => { console.log(logLine({ event: "handle_error", sid, reason: error instanceof Error ? `${error.name}: ${error.message}` : "error" })); safeClose(ws, 1011, "error"); closed(); });
  });
  ws.addEventListener("close", () => closed());
  ws.addEventListener("error", () => closed());

  await done;
  clearTimeout(hello);
  clearTimeout(lifetime);
  if (terminal) await (terminal as Terminal).terminate().catch(() => undefined);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Kill switch, checked on every request before anything else happens.
    if (!shellEnabled(env)) {
      return Response.json({ error: "The public sandbox is switched off." }, { status: 503, headers: { ...cors(request, env), "Retry-After": "3600" } });
    }
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return originAllowed(request.headers.get("Origin"), env) ? new Response(null, { status: 204, headers: cors(request, env) }) : new Response(null, { status: 403 });
    }
    if (url.pathname === "/health" && request.method === "GET") return reply(request, env, 200, { ok: true, origins: allowedOrigins(env).length });
    if (url.pathname === "/session" && request.method === "POST") {
      if (!originAllowed(request.headers.get("Origin"), env)) return reply(request, env, 403, { error: "Origin not allowed." });
      return createSession(request, env);
    }
    if (url.pathname === "/ws" && request.method === "GET") return connectTerminal(request, env);
    return reply(request, env, 404, { error: "Not found." });
  },
} satisfies ExportedHandler<Env>;
