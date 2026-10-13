import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { withMailbox, MailboxError } from "./mailbox.mjs";
import { InputError } from "../../workers/vault-agent/src/protocol.mjs";

async function body(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new MailboxError("Send application/json.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new MailboxError("Mailbox HTTP request exceeds 64 KiB.");
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new MailboxError("Send valid UTF-8 JSON.");
    throw error;
  }
}

export function mailboxServer(vault, token) {
  if (typeof token !== "string" || token.length < 32 || /[\r\n]/.test(token)) throw new Error("Set VAULT_MAILBOX_TOKEN to a random value of at least 32 characters; do not print it.");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
    const reply = (status, value) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" });
      response.end(JSON.stringify(value));
    };
    try {
      // Browser origins are not authorized clients; keep the service loopback-only.
      if (request.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? "")) return reply(403, { error: "Loopback clients only; browser origins are refused." });
      const provided = createHash("sha256").update(request.headers.authorization ?? "").digest();
      if (!timingSafeEqual(provided, expected)) return reply(401, { error: "Unauthorized." });
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.search || url.hash) throw new MailboxError("Use exact mailbox routes without query strings.");
      if (request.method === "GET" && url.pathname === "/health") return reply(200, { ok: true, version: 1, transport: "local-loopback", cloudDelivery: false });
      if (request.method === "POST" && url.pathname === "/messages") {
        const value = await body(request);
        return reply(201, await withMailbox(vault, mailbox => mailbox.send(value)));
      }
      if (request.method === "POST" && url.pathname === "/ack") {
        const value = await body(request);
        return reply(200, await withMailbox(vault, mailbox => mailbox.acknowledge(value)));
      }
      if (request.method === "POST" && url.pathname === "/packages") {
        const value = await body(request);
        return reply(201, await withMailbox(vault, mailbox => mailbox.retainPackage(value, "local-http")));
      }
      const gossip = /^\/gossip\/(0|[1-9]\d*)$/.exec(url.pathname);
      if (request.method === "GET" && gossip) return reply(200, await withMailbox(vault, mailbox => mailbox.gossip(Number(gossip[1]))));
      const pack = /^\/packages\/([a-f0-9]{64})$/.exec(url.pathname);
      if (request.method === "GET" && pack) return reply(200, await withMailbox(vault, mailbox => mailbox.readPackage(pack[1])));
      const match = /^\/inbox\/([a-z][a-z0-9-]{0,63})(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
      if (request.method === "GET" && match) return reply(200, await withMailbox(vault, mailbox =>
        match[2] ? mailbox.read(match[1], match[2]) : mailbox.receive(match[1])));
      return reply(404, { error: "Not found." });
    } catch (error) {
      if (error instanceof MailboxError || error instanceof InputError) return reply(error.message.includes("busy") ? 409 : 400, { error: error.message });
      console.error(JSON.stringify({ event: "vault_mailbox_request_failed", type: error.name }));
      return reply(500, { error: "Mailbox operation failed; inspect local logs and preserve state." });
    }
  });
  server.maxConnections = 16;
  server.timeout = 15000;
  return server;
}
