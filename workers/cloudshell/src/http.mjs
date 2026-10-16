import { timingSafeEqual } from "node:crypto";

const json = (status, value) => Response.json(value, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}

export async function equalSecrets(left, right) {
  const encode = value => new TextEncoder().encode(value);
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(left)),
    crypto.subtle.digest("SHA-256", encode(right)),
  ]);
  return timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected));
}

export async function tokenMatches(request, token) {
  return typeof token === "string" && token.length >= 32
    && equalSecrets(request.headers.get("Authorization") ?? "", `Bearer ${token}`);
}

export async function boundedJson(request, maxBytes) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "Send application/json.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A JSON body is required.");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) { await reader.cancel(); throw new HttpError(413, `Request exceeds ${maxBytes} bytes.`); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(JSON.stringify({ event: "cloudshell_body_failed" }));
    throw new HttpError(400, "Request body could not be read.");
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { throw new HttpError(400, "Send valid UTF-8 JSON."); }
}

const SESSION_TIMEOUT_MAX = 150;

/** `session` is optional: { status(), start(), end() }. Without it the session routes do not exist (404) and nothing else changes. */
export async function handleShell(request, token, execute, session) {
  if (typeof token !== "string" || token.length < 32) return json(503, { error: "Cloud shell is not configured." });
  if (request.headers.has("Origin")) return json(403, { error: "Use the authenticated RabbitOS backend." });
  if (!await tokenMatches(request, token)) return json(401, { error: "Unauthorized." });
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/health") {
    return json(200, { ok: true, commandTimeoutMs: 60000, outputBytes: 65536, arbitraryShell: true, ...(session ? { sessionMode: true } : {}) });
  }
  if (session && request.method === "GET" && path === "/session") {
    try { const result = await session.status(); return json(result.status, result.body); }
    catch { return json(502, { error: "Session status could not be read." }); }
  }
  if (session && request.method === "POST" && (path === "/session/start" || path === "/session/end")) {
    let body;
    try { body = await boundedJson(request, 512); }
    catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      throw error;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "consent") || body.consent !== true) {
      return json(400, { error: "Approve the session action with {\"consent\": true}." });
    }
    try { const result = await (path === "/session/start" ? session.start() : session.end()); return json(result.status, result.body); }
    catch (error) {
      console.error(JSON.stringify({ event: "cloudshell_session_failed", action: path, type: error instanceof Error ? error.name : "Error" }));
      return json(502, { error: "The session request failed. Nothing was retried automatically." });
    }
  }
  if (request.method !== "POST" || path !== "/execute") return json(404, { error: "Not found." });
  let value;
  try { value = await boundedJson(request, 8192); }
  catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }
  const allowed = session ? ["command", "consent", "session", "timeoutSeconds"] : ["command", "consent"];
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))
      || value.consent !== true || typeof value.command !== "string" || !value.command.trim()
      || new TextEncoder().encode(value.command).length > 4000 || value.command.includes("\0")) {
    return json(400, { error: "Approve execution and send a command of 1-4000 UTF-8 bytes." });
  }
  const inSession = value.session === true;
  if (("session" in value && typeof value.session !== "boolean")
      || ("timeoutSeconds" in value && (!inSession || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > SESSION_TIMEOUT_MAX))) {
    return json(400, { error: `session must be true or false; timeoutSeconds (1-${SESSION_TIMEOUT_MAX}) is only for session commands.` });
  }
  try {
    const result = inSession ? await execute(value.command, { session: true, timeoutSeconds: value.timeoutSeconds }) : await execute(value.command);
    return json(result.status, result.body);
  } catch (error) {
    console.error(JSON.stringify({ event: "cloudshell_execution_failed", type: error instanceof Error ? error.name : "Error" }));
    return json(502, { error: "Cloud shell execution failed. No command was automatically retried." });
  }
}
