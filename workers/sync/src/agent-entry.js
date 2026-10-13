var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/agent-entry.js
import { WorkerEntrypoint } from "cloudflare:workers";

// src/index.js
var MAX_CLOCK_SKEW_MS = 3e5;
var MAX_DEVICES = 20;
var SLOT_RE = /^[A-Z2-7]{4}$/;
var ID_RE = /^[0-9a-f]{32}$/;
var DEFAULT_QUOTAS = { history: 500, corpus: 50, training: 300, pairing: 20, maxwell: 20, research: 20, "legacy-maxwell": 20, agent_verify: 20, project_events: 100 };
var json = /* @__PURE__ */ __name((status, data, headers = {}) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store", ...headers }
}), "json");
var enc = new TextEncoder();
function b64decode(text) {
  const raw = atob(String(text || ""));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
__name(b64decode, "b64decode");
async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
async function idFor(publicKey) {
  return (await sha256hex(publicKey)).slice(0, 32);
}
__name(idFor, "idFor");
async function verifySignature(publicKey, signature, message) {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, enc.encode(message));
  } catch {
    return false;
  }
}
__name(verifySignature, "verifySignature");
async function requestMessage(method, pathAndQuery, time, body) {
  return `${method}
${pathAndQuery}
${time}
${await sha256hex(body)}`;
}
__name(requestMessage, "requestMessage");
function projectEvent(details) {
  if (!details || Object.keys(details).sort().join(",") !== "byte_count,created_at,event_type,item_count,kind,sha256" || !["archive_snapshot_stored", "dna_public_record_appended", "archive_checksum_verified"].includes(details.event_type) || !["research", "maxwell", "legacy-maxwell", "dna"].includes(details.kind) || typeof details.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(details.sha256) || !Number.isSafeInteger(details.item_count) || details.item_count < 1 || details.item_count > 1e3 || !Number.isSafeInteger(details.byte_count) || details.byte_count < 0 || details.byte_count > 1048576 || typeof details.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(details.created_at) || !Number.isFinite(Date.parse(details.created_at))) {
    throw new Error("invalid metadata-only project event");
  }
  return { project: "network-os-project", ...details };
}
__name(projectEvent, "projectEvent");
async function sendProjectEvent(env, account, details) {
  if (env.PROJECT_EVENTS_ENABLED !== "true" || !env.PROJECT_EVENTS) return "not_configured";
  if (!env.ADMIN_ACCOUNT || account !== env.ADMIN_ACCOUNT) return "not_eligible";
  try {
    const event = projectEvent(details);
    if (!await quota(env, account, "project_events")) return "rate_limited";
    await env.PROJECT_EVENTS.send([event]);
    return "sent";
  } catch {
    return "failed";
  }
}
__name(sendProjectEvent, "sendProjectEvent");
async function readJson(bucket, key) {
  const object = await bucket.get(key);
  return object ? await object.json() : null;
}
__name(readJson, "readJson");
function screenPublicSnapshot(value, depth = 0, publicDigests = false) {
  const forbiddenKey = /(?:secret|password|passphrase|token|credential|api_key|private|email|phone|address|birth|genome|dna_sequence|patient|vault|ciphertext|encrypted|ssn)/i;
  const privateText = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\d[ ()+.-]*){9,15}\b|\b\d{3}-\d{2}-\d{4}\b|[ACGTU]{30,}|\b(?:date of birth|born on|d\.?o\.?b\.?)\b|\b\d{1,5}\s+(?:\w+\s+){1,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way)\b|-----BEGIN .*PRIVATE KEY-----/i;
  if (depth > 20) throw new Error("snapshot nesting exceeds the limit");
  if (typeof value === "string" && privateText.test(value)) throw new Error("snapshot may contain personal data or credentials");
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKey.test(key)) throw new Error("snapshot contains a private-data field");
      screenPublicSnapshot(key, depth + 1, publicDigests);
      if (publicDigests && (key.endsWith("_sha256") || ["event_id", "block_hash", "about_event_id", "corrects_event_id"].includes(key)) && typeof child === "string" && /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(child)) continue;
      if (publicDigests && key === "created_at" && typeof child === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(child) && Number.isFinite(Date.parse(child))) continue;
      screenPublicSnapshot(child, depth + 1, publicDigests);
    }
  }
}
__name(screenPublicSnapshot, "screenPublicSnapshot");
function validateResearchSnapshot(data) {
  if (!data || data.schema_version !== 1 || data.classification !== "public" || Object.keys(data).sort().join(",") !== "classification,events,schema_version" || !Array.isArray(data.events) || !data.events.length || data.events.length > 1e3) {
    throw new Error("send a public v1 research snapshot with 1-1000 events");
  }
  const kinds = /* @__PURE__ */ new Set([
    "public_research_records",
    "public_dataset_record",
    "public_research_correction",
    "public_crispr_relevance",
    "public_variant_classification",
    "public_model_run_record",
    "public_sequence_record",
    "public_record_note",
    "public_data_hash"
  ]);
  const seen = /* @__PURE__ */ new Set();
  for (const event of data.events) {
    if (!event || event.classification !== "public" || event.schema_version !== 1 || typeof event.event_id !== "string" || !/^[0-9a-f]{32}$/.test(event.event_id) || seen.has(event.event_id) || (event.event_type ? !kinds.has(event.event_type) : event.backend !== "ollama-local") || typeof event.created_at !== "string" || !Number.isFinite(Date.parse(event.created_at))) {
      throw new Error("snapshot contains an invalid or duplicate public research event");
    }
    screenPublicSnapshot(event, 0, true);
    seen.add(event.event_id);
  }
}
__name(validateResearchSnapshot, "validateResearchSnapshot");
function validateLegacyMaxwellSnapshot(data) {
  if (!data || data.schema_version !== 1 || data.classification !== "public" || data.verification_scope !== "linkage-only; block hashes not recomputed" || Object.keys(data).sort().join(",") !== "classification,records,schema_version,verification_scope" || !Array.isArray(data.records) || !data.records.length || data.records.length > 1e3) {
    throw new Error("send a public linkage-only legacy Maxwell fingerprint archive");
  }
  const hashes = /* @__PURE__ */ new Set();
  const children = /* @__PURE__ */ new Map();
  for (const record of data.records) {
    if (!record || Object.keys(record).sort().join(",") !== "block_number,hash,previous_hash" || !Number.isSafeInteger(record.block_number) || record.block_number < 0 || typeof record.hash !== "string" || !/^[0-9a-f]{64}$/.test(record.hash) || hashes.has(record.hash) || typeof record.previous_hash !== "string" || !/^(?:[0-9a-f]{64}|0x0{64})$/.test(record.previous_hash)) {
      throw new Error("invalid or duplicate legacy Maxwell fingerprint record");
    }
    hashes.add(record.hash);
    if (!children.has(record.previous_hash)) children.set(record.previous_hash, []);
    children.get(record.previous_hash).push(record.hash);
  }
  const roots = data.records.filter((record) => !hashes.has(record.previous_hash));
  if (roots.length !== 1) throw new Error("legacy archive must have one root");
  const pending = [roots[0].hash];
  const visited = /* @__PURE__ */ new Set();
  while (pending.length) {
    const digest = pending.pop();
    if (visited.has(digest)) throw new Error("cyclic legacy archive");
    visited.add(digest);
    pending.push(...children.get(digest) || []);
  }
  if (visited.size !== hashes.size) throw new Error("unreachable legacy archive records");
}
__name(validateLegacyMaxwellSnapshot, "validateLegacyMaxwellSnapshot");
function validateMaxwellSnapshot(data) {
  if (!data || data.schema_version !== 1 || data.classification !== "public" || Object.keys(data).sort().join(",") !== "chain,classification,schema_version" || !Array.isArray(data.chain) || !data.chain.length || data.chain.length > 1e3) {
    throw new Error("send a public v1 Maxwell snapshot with 1-1000 blocks");
  }
  const fields = /* @__PURE__ */ new Set(["block_number", "timestamp", "block_type", "data", "previous_hash", "nonce", "hash", "miner_id", "maxwell_signature"]);
  let previousHash = "0".repeat(64);
  for (const [index, block] of data.chain.entries()) {
    if (!block || Object.keys(block).some((key) => !fields.has(key)) || block.block_number !== index || !/^[0-9a-f]{64}$/.test(block.hash) || block.previous_hash !== previousHash || !Number.isFinite(block.timestamp) || !Number.isSafeInteger(block.nonce) || block.nonce < 0 || typeof block.block_type !== "string" || typeof block.miner_id !== "string" || !block.data || typeof block.data !== "object" || Array.isArray(block.data) || "maxwell_signature" in block && (!block.maxwell_signature || typeof block.maxwell_signature !== "object" || Array.isArray(block.maxwell_signature))) {
      throw new Error("snapshot has invalid Maxwell block structure or linkage");
    }
    screenPublicSnapshot(block.data);
    screenPublicSnapshot(block.block_type);
    screenPublicSnapshot(block.miner_id);
    if (block.maxwell_signature) screenPublicSnapshot(block.maxwell_signature);
    previousHash = block.hash;
  }
}
__name(validateMaxwellSnapshot, "validateMaxwellSnapshot");
async function readKvJson(kv, key) {
  const value = await kv.get(key);
  return value ? JSON.parse(value) : null;
}
__name(readKvJson, "readKvJson");
async function quota(env, account, kind) {
  const limits = { ...DEFAULT_QUOTAS, ...JSON.parse(env.QUOTAS || "{}") };
  const stub = env.QUOTA.get(env.QUOTA.idFromName("everyone"));
  const verdict = await (await stub.fetch("https://quota/check", {
    method: "POST",
    body: JSON.stringify({ key: `${account}|${kind}`, limit: limits[kind] })
  })).json();
  return verdict.ok;
}
__name(quota, "quota");
var Quota = class {
  static {
    __name(this, "Quota");
  }
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch(request) {
    const { key, limit, now = Date.now() } = await request.json();
    const day = new Date(now).toISOString().slice(0, 10);
    const stored = await this.ctx.storage.get(key) || { day, count: 0 };
    const state = stored.day === day ? stored : { day, count: 0 };
    if (state.count >= limit) return json(200, { ok: false });
    state.count += 1;
    await this.ctx.storage.put(key, state);
    return json(200, { ok: true });
  }
};
async function signedDevice(request, env, body) {
  const account = request.headers.get("X-Account") || "";
  const device = request.headers.get("X-Device") || "";
  const time = Number(request.headers.get("X-Time"));
  if (!ID_RE.test(account) || !ID_RE.test(device) || !Number.isFinite(time)) return { error: json(401, { error: "sign the request" }) };
  if (Math.abs(Date.now() - time) > MAX_CLOCK_SKEW_MS) return { error: json(401, { error: "this device's clock is off by more than 5 minutes" }) };
  const record = await readJson(env.SYNC, `accounts/${account}/devices/${device}.json`);
  if (!record || record.removed) return { error: json(403, { error: "this device isn't part of the account (or was removed)" }) };
  const url = new URL(request.url);
  const message = await requestMessage(request.method, url.pathname + url.search, String(time), body);
  if (!await verifySignature(b64decode(record.public_key), b64decode(request.headers.get("X-Signature")), message)) {
    return { error: json(401, { error: "the signature doesn't match" }) };
  }
  return { account, device, record };
}
__name(signedDevice, "signedDevice");
async function authorizeAgentRequest(request, env) {
  if (env.ARCHIVE_AGENT_ENABLED !== "true") return json(503, { error: "archive agent is disabled" });
  const url = new URL(request.url);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > 2048) return json(413, { error: "agent requests are limited to 2048 bytes" });
  const who = await signedDevice(request, env, body);
  if (who.error) return who.error;
  if (!env.ADMIN_ACCOUNT) return json(503, { error: "owner account is not configured" });
  if (who.account !== env.ADMIN_ACCOUNT) return json(403, { error: "only the configured owner can run archive agents" });
  if (url.search) return json(400, { error: "query parameters are not supported" });
  if (request.method === "GET" && /^\/v1\/agent\/jobs\/[0-9a-f]{32}-[0-9a-f-]{36}$/.test(url.pathname)) {
    if (!url.pathname.startsWith(`/v1/agent/jobs/${who.account}-`)) return json(404, { error: "no such owner job" });
    return json(200, { account: who.account, device: who.device });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/agent/jobs") return json(404, { error: "no such agent route" });
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, { error: "send JSON" });
  }
  if (!data || Object.keys(data).sort().join(",") !== "approved,kind,request_id,sha256,task" || data.approved !== true || data.task !== "verify_archive" || !["maxwell", "research", "legacy-maxwell"].includes(data.kind) || typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.sha256) || typeof data.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.request_id)) {
    return json(400, { error: "only explicitly approved archive-verification jobs are supported" });
  }
  if (!await quota(env, who.account, "agent_verify")) return json(429, { error: "too many agent submissions today" });
  return json(200, { account: who.account, device: who.device, kind: data.kind, sha256: data.sha256, request_id: data.request_id });
}
__name(authorizeAgentRequest, "authorizeAgentRequest");
async function verifyAgentSnapshot(params, env) {
  if (env.ARCHIVE_AGENT_ENABLED !== "true" || !params || Object.keys(params).sort().join(",") !== "account,device,kind,sha256" || !ID_RE.test(params.account) || !ID_RE.test(params.device) || params.account !== env.ADMIN_ACCOUNT || !["maxwell", "research", "legacy-maxwell"].includes(params.kind) || typeof params.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(params.sha256)) {
    throw new Error("archive verification authorization refused");
  }
  const device = await readJson(env.SYNC, `accounts/${params.account}/devices/${params.device}.json`);
  if (!device || device.removed) throw new Error("archive verification device is revoked or unavailable");
  const object = await env.SYNC.get(`accounts/${params.account}/${params.kind}/snapshots/${params.sha256}.json`);
  if (!object) throw new Error("archive snapshot is unavailable");
  if (object.size > 1048576) throw new Error("archive snapshot exceeds the verification limit");
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  if (bytes.length > 1048576) throw new Error("archive snapshot exceeds the verification limit");
  const matched = await sha256hex(bytes) === params.sha256;
  let projectStreamStatus = "not_configured";
  if (env.PROJECT_EVENTS_ENABLED === "true" && env.PROJECT_EVENTS) {
    projectStreamStatus = "not_eligible";
    if (matched) {
      try {
        const snapshot = JSON.parse(new TextDecoder().decode(bytes));
        if (params.kind === "research") validateResearchSnapshot(snapshot);
        else if (params.kind === "maxwell") validateMaxwellSnapshot(snapshot);
        else validateLegacyMaxwellSnapshot(snapshot);
        const entries = params.kind === "research" ? snapshot.events : params.kind === "maxwell" ? snapshot.chain : snapshot.records;
        projectStreamStatus = await sendProjectEvent(env, params.account, {
          event_type: "archive_checksum_verified",
          kind: params.kind,
          sha256: params.sha256,
          item_count: entries.length,
          byte_count: bytes.length,
          created_at: (/* @__PURE__ */ new Date()).toISOString()
        });
      } catch {
        projectStreamStatus = "not_eligible";
      }
    }
  }
  return {
    task: "verify_archive",
    kind: params.kind,
    sha256: params.sha256,
    bytes: bytes.length,
    matched,
    project_stream_status: projectStreamStatus,
    verification_scope: "stored snapshot checksum only; not mining consensus or origin signatures"
  };
}
__name(verifyAgentSnapshot, "verifyAgentSnapshot");
async function registerDevice(request, env, body) {
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, { error: "send JSON" });
  }
  const accountKey = b64decode(data.account_key);
  const deviceKey = b64decode(data.device_key);
  const name = String(data.name || "").slice(0, 60);
  if (accountKey.length !== 32 || deviceKey.length !== 32 || !name) return json(400, { error: "send account_key, device_key and a name" });
  if (Math.abs(Date.now() - Number(data.time)) > MAX_CLOCK_SKEW_MS) return json(401, { error: "this device's clock is off by more than 5 minutes" });
  const account = await idFor(accountKey);
  const device = await idFor(deviceKey);
  const message = `register
${account}
${data.device_key}
${name}
${data.time}`;
  if (!await verifySignature(accountKey, b64decode(data.signature), message)) return json(401, { error: "the account signature doesn't match" });
  const accountFile = `accounts/${account}/account.json`;
  if (!await env.SYNC.head(accountFile)) {
    if (env.OPEN_SIGNUP !== "true" && (!env.SIGNUP_KEY || request.headers.get("X-Signup-Key") !== env.SIGNUP_KEY)) {
      return json(403, { error: "new accounts aren't open yet" });
    }
    await env.SYNC.put(accountFile, JSON.stringify({ account_key: data.account_key, created_at: (/* @__PURE__ */ new Date()).toISOString() }));
  }
  const devices = await env.SYNC.list({ prefix: `accounts/${account}/devices/` });
  if (devices.objects.length >= MAX_DEVICES) return json(409, { error: `an account can have at most ${MAX_DEVICES} devices` });
  await env.SYNC.put(`accounts/${account}/devices/${device}.json`, JSON.stringify({
    public_key: data.device_key,
    name,
    added_at: (/* @__PURE__ */ new Date()).toISOString(),
    removed: false
  }));
  return json(200, { account, device });
}
__name(registerDevice, "registerDevice");
var RECORD_LIMITS = { source: 32, external_id: 64, title: 500, abstract: 6e3, source_url: 300, published_at: 32 };
function cleanRecords(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 200) throw new Error("send 1 to 200 records");
  return records.map((r) => {
    const kept = {};
    for (const [field, max] of Object.entries(RECORD_LIMITS)) {
      const value = String(r?.[field] ?? "").trim();
      if (value.length > max) throw new Error(`${field} is longer than ${max} characters`);
      kept[field] = value;
    }
    if (!kept.source || !kept.external_id || !kept.title || !/^https:\/\//.test(kept.source_url)) {
      throw new Error("each record needs a source, external_id, title and an https source_url");
    }
    return kept;
  });
}
__name(cleanRecords, "cleanRecords");
function cleanTraining(item) {
  const question = String(item?.question ?? "").trim();
  const answer = String(item?.answer ?? "").trim();
  const rating = Number(item?.rating ?? 0);
  const sources = Array.isArray(item?.sources) ? item.sources.slice(0, 10).map((s) => String(s).slice(0, 300)) : [];
  if (!question || question.length > 2e3 || !answer || answer.length > 4e3) throw new Error("send a question (up to 2000 characters) and an answer (up to 4000)");
  if (![-1, 0, 1].includes(rating)) throw new Error("rating must be -1, 0 or 1");
  return { question, answer, sources, rating, model: String(item?.model ?? "").slice(0, 64), shared_at: (/* @__PURE__ */ new Date()).toISOString() };
}
__name(cleanTraining, "cleanTraining");
async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : void 0;
  } while (cursor);
  return objects;
}
__name(listAll, "listAll");
function migrationConfig(env) {
  const destination = String(env.ACCOUNT_MIGRATION_DESTINATION || "").trim();
  const noticeVersion = String(env.ACCOUNT_MIGRATION_NOTICE_VERSION || "").trim();
  const notice = String(env.ACCOUNT_MIGRATION_NOTICE || "").trim();
  if (env.ACCOUNT_MIGRATION_ENABLED !== "true" || !destination || !noticeVersion || !notice) return null;
  return { destination, noticeVersion, notice };
}
__name(migrationConfig, "migrationConfig");
async function latestMigrationEvent(env, account) {
  return env.DB.prepare(
    "SELECT action, destination, notice_version, created_at FROM account_migration_events WHERE account_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(account).first();
}
__name(latestMigrationEvent, "latestMigrationEvent");
async function migrationStatus(env, account) {
  const config = migrationConfig(env);
  const latest = await latestMigrationEvent(env, account);
  if (!config) {
    if (latest?.action !== "consent") return { enabled: false, state: "disabled" };
    return {
      enabled: false,
      state: "consented",
      destination: latest.destination,
      notice_version: latest.notice_version,
      notice: null,
      consented_at: latest.created_at
    };
  }
  const consented = latest?.action === "consent" && latest.destination === config.destination && latest.notice_version === config.noticeVersion;
  return {
    enabled: true,
    state: consented ? "consented" : "not_consented",
    destination: config.destination,
    notice_version: config.noticeVersion,
    notice: config.notice,
    consented_at: consented ? latest.created_at : null
  };
}
__name(migrationStatus, "migrationStatus");
async function migrationObjects(env, account) {
  const prefix = `accounts/${account}/`;
  const [accountFile, devices, history] = await Promise.all([
    env.SYNC.head(`${prefix}account.json`),
    listAll(env.SYNC, `${prefix}devices/`),
    listAll(env.SYNC, `${prefix}history/`)
  ]);
  return [
    ...accountFile ? [{ key: `${prefix}account.json`, size: accountFile.size || 0, group: "account_metadata" }] : [],
    ...devices.map((object) => ({ key: object.key, size: object.size || 0, group: "devices" })),
    ...history.map((object) => ({ key: object.key, size: object.size || 0, group: "encrypted_history" }))
  ];
}
__name(migrationObjects, "migrationObjects");
async function migrationPreview(env, account) {
  const objects = await migrationObjects(env, account);
  const groups = {
    account_metadata: { objects: 0, bytes: 0 },
    devices: { objects: 0, bytes: 0 },
    encrypted_history: { objects: 0, bytes: 0 }
  };
  for (const object of objects) {
    groups[object.group].objects += 1;
    groups[object.group].bytes += object.size;
  }
  return {
    scope: "this account only",
    groups,
    total: Object.values(groups).reduce((sum, group) => ({
      objects: sum.objects + group.objects,
      bytes: sum.bytes + group.bytes
    }), { objects: 0, bytes: 0 }),
    content_read: false,
    data_exported: false
  };
}
__name(migrationPreview, "migrationPreview");
function b64urlDecode(text) {
  const b64 = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(b64 + "=".repeat((4 - b64.length % 4) % 4));
}
__name(b64urlDecode, "b64urlDecode");
async function verifySupabaseJwt(request, env) {
  const base = String(env.SUPABASE_URL || "").replace(/[/]+$/, "");
  if (!base) return { status: 503, error: "supabase auth is not configured" };
  const token = (request.headers.get("Authorization") || "").match(/^Bearer ([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return { status: 401, error: "send a Supabase access token as a Bearer token" };
  const [h, p, sig] = token.split(".");
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    const signed = enc.encode(`${h}.${p}`);
    let ok = false;
    if (header.alg === "HS256" && env.SUPABASE_JWT_SECRET) {
      const key = await crypto.subtle.importKey("raw", enc.encode(env.SUPABASE_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), signed);
    } else if (header.alg === "ES256" || header.alg === "RS256") {
      const res = await fetch(`${base}/auth/v1/.well-known/jwks.json`, { cf: { cacheTtl: 600, cacheEverything: true } });
      const jwk = res.ok ? (await res.json()).keys?.find((k) => k.kid === header.kid) : null;
      if (jwk) {
        const algo = header.alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
        ok = await crypto.subtle.verify(header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : algo, key, b64urlDecode(sig), signed);
      }
    }
    if (!ok) return { status: 401, error: "invalid token" };
    if (claims.iss !== `${base}/auth/v1` || claims.aud !== "authenticated" || !(claims.exp > Date.now() / 1e3)) return { status: 401, error: "invalid or expired token" };
    return { user: { id: claims.sub, email: claims.email || null, role: claims.role || null } };
  } catch {
    return { status: 401, error: "invalid token" };
  }
}
__name(verifySupabaseJwt, "verifySupabaseJwt");
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > 1048576) return json(413, { error: "at most 1 MB per request" });
  if (method === "GET" && (path === "/" || path === "/health")) return json(200, { service: "RabbitSoftware.inc sync", ok: true });
  if (method === "GET" && path === "/v1/corpus/batches") {
    const names = (await listAll(env.SYNC, "corpus/batches/")).map((o) => o.key.slice("corpus/batches/".length));
    return json(200, { batches: names }, { "Cache-Control": "public, max-age=60" });
  }
  if (method === "GET" && path === "/v1/corpus/search") {
    const words = (url.searchParams.get("q") || "").toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu) || [];
    if (!words.length || words.length > 8) return json(400, { error: "send q with 1 to 8 words" });
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    const like = words.map(() => "(lower(title) LIKE ? ESCAPE '\\' OR lower(abstract) LIKE ? ESCAPE '\\')").join(" AND ");
    const params = words.flatMap((w) => {
      const p = `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      return [p, p];
    });
    const { results } = await env.DB.prepare(
      `SELECT source, external_id, title, source_url, published_at FROM corpus_records WHERE ${like} ORDER BY added_at DESC LIMIT ?`
    ).bind(...params, limit).all();
    return json(200, { query: words.join(" "), records: results }, { "Cache-Control": "public, max-age=60" });
  }
  if (method === "GET" && path === "/v1/corpus/stats") {
    const { results } = await env.DB.prepare(
      "SELECT source, COUNT(*) AS records, MAX(added_at) AS last_added FROM corpus_records GROUP BY source ORDER BY records DESC"
    ).all();
    return json(200, { total: results.reduce((n, r) => n + r.records, 0), sources: results }, { "Cache-Control": "public, max-age=60" });
  }
  let m;
  if (method === "GET" && (m = path.match(/^\/v1\/corpus\/batches\/([0-9A-Za-z._-]{1,80})$/))) {
    const object = await env.SYNC.get(`corpus/batches/${m[1]}`);
    if (!object) return json(404, { error: "no such batch" });
    return new Response(object.body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable" } });
  }
  if (method === "POST" && path === "/v1/devices") return registerDevice(request, env, body);
  if (method === "GET" && (m = path.match(/^\/v1\/pairing\/([A-Z2-7]{4})$/))) {
    const key = `pairing/${m[1]}.json`;
    const slot = await readJson(env.SYNC, key);
    if (!slot || slot.expires_at < Date.now() || slot.attempts >= 5) {
      if (slot) await env.SYNC.delete(key);
      return json(404, { error: "that pairing code has expired; make a new one on your other device" });
    }
    slot.attempts += 1;
    await env.SYNC.put(key, JSON.stringify(slot));
    return json(200, { sealed: slot.sealed });
  }
  if (method === "GET" && path === "/v1/supabase/health") return json(200, { configured: Boolean(env.SUPABASE_URL) });
  if (method === "GET" && path === "/v1/supabase/me") {
    const auth = await verifySupabaseJwt(request, env);
    return auth.error ? json(auth.status, { error: auth.error }) : json(200, { user: auth.user });
  }
  const who = await signedDevice(request, env, body);
  if (who.error) return who.error;
  const { account } = who;
  let data = null;
  if (body.length && request.headers.get("Content-Type") === "application/json") {
    try {
      data = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json(400, { error: "send JSON" });
    }
  }
  if (method === "GET" && path === "/v1/account/migration") {
    return json(200, await migrationStatus(env, account), { "Cache-Control": "no-store" });
  }
  if (method === "GET" && path === "/v1/account/migration/preview") {
    return json(200, await migrationPreview(env, account), { "Cache-Control": "no-store" });
  }
  if (method === "GET" && path === "/v1/account/migration/export/manifest") {
    const status = await migrationStatus(env, account);
    if (!status.enabled || status.state !== "consented") {
      return json(409, { error: "active migration consent is required" }, { "Cache-Control": "no-store" });
    }
    const objects = await migrationObjects(env, account);
    return json(200, {
      scope: "this account only",
      destination: status.destination,
      notice_version: status.notice_version,
      objects,
      total: {
        objects: objects.length,
        bytes: objects.reduce((sum, object) => sum + object.size, 0)
      },
      content_read: false,
      data_exported: false
    }, { "Cache-Control": "no-store" });
  }
  if (method === "GET" && path === "/v1/account/migration/export/object") {
    const status = await migrationStatus(env, account);
    if (!status.enabled || status.state !== "consented") {
      return json(409, { error: "active migration consent is required" }, { "Cache-Control": "no-store" });
    }
    const key = url.searchParams.get("key") || "";
    const prefix = `accounts/${account}/`;
    const relativeKey = key.startsWith(prefix) ? key.slice(prefix.length) : "";
    const allowedKey = relativeKey === "account.json" || /^devices\/[0-9a-f]{32}\.json$/.test(relativeKey) || /^history\/[0-9A-Za-z._-]{1,80}$/.test(relativeKey);
    if (!allowedKey) return json(400, { error: "only this account's metadata and encrypted history can be exported" }, { "Cache-Control": "no-store" });
    const object = await env.SYNC.get(key);
    if (!object) return json(404, { error: "no such account migration object" }, { "Cache-Control": "no-store" });
    return new Response(object.body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Length": String(object.size),
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
  if (method === "POST" && path === "/v1/account/migration") {
    if (data?.action === "consent") {
      const config = migrationConfig(env);
      if (!config) return json(409, { error: "account migration consent is not configured" });
      if (data.notice_version !== config.noticeVersion) {
        return json(409, { error: "review the current migration notice before consenting" });
      }
      await env.DB.prepare(
        "INSERT INTO account_migration_events (account_id, device_id, action, destination, notice_version, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(account, who.device, "consent", config.destination, config.noticeVersion, (/* @__PURE__ */ new Date()).toISOString()).run();
      return json(200, { action: "consent", destination: config.destination, notice_version: config.noticeVersion, exported: false });
    }
    if (data?.action === "revoke") {
      const latest = await latestMigrationEvent(env, account);
      if (latest?.action !== "consent") {
        return json(409, { error: "there is no matching active migration consent to revoke" });
      }
      await env.DB.prepare(
        "INSERT INTO account_migration_events (account_id, device_id, action, destination, notice_version, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(account, who.device, "revoke", latest.destination, latest.notice_version, (/* @__PURE__ */ new Date()).toISOString()).run();
      return json(200, { action: "revoke", exported: false });
    }
    return json(400, { error: "action must be consent or revoke" });
  }
  if (method === "GET" && path === "/v1/devices") {
    const devices = [];
    for (const o of await listAll(env.SYNC, `accounts/${account}/devices/`)) {
      const d = await readJson(env.SYNC, o.key);
      devices.push({ device: o.key.split("/").pop().replace(".json", ""), name: d.name, added_at: d.added_at, removed: d.removed });
    }
    return json(200, { devices });
  }
  if (method === "DELETE" && (m = path.match(/^\/v1\/devices\/([0-9a-f]{32})$/))) {
    const key = `accounts/${account}/devices/${m[1]}.json`;
    const d = await readJson(env.SYNC, key);
    if (!d) return json(404, { error: "no such device" });
    await env.SYNC.put(key, JSON.stringify({ ...d, removed: true, removed_at: (/* @__PURE__ */ new Date()).toISOString() }));
    return json(200, { removed: m[1] });
  }
  if (method === "PUT" && (m = path.match(/^\/v1\/history\/([0-9A-Za-z._-]{1,80})$/))) {
    if (!await quota(env, account, "history")) return json(429, { error: "too many history uploads today" });
    await env.SYNC.put(`accounts/${account}/history/${m[1]}`, body);
    return json(200, { stored: m[1], bytes: body.length });
  }
  if (method === "GET" && path === "/v1/history") {
    const items = (await listAll(env.SYNC, `accounts/${account}/history/`)).map((o) => ({ name: o.key.split("/").pop(), bytes: o.size }));
    return json(200, { history: items });
  }
  if (method === "GET" && (m = path.match(/^\/v1\/history\/([0-9A-Za-z._-]{1,80})$/))) {
    const object = await env.SYNC.get(`accounts/${account}/history/${m[1]}`);
    if (!object) return json(404, { error: "no such history file" });
    return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  }
  if ((method === "PUT" || method === "GET") && (m = path.match(/^\/v1\/(maxwell|research|legacy-maxwell)\/snapshot\/([0-9a-f]{64})$/))) {
    const kind = m[1];
    const digest = m[2];
    const key = `accounts/${account}/${kind}/snapshots/${digest}.json`;
    if (method === "GET") {
      const object = await env.SYNC.get(key);
      if (!object) return json(404, { error: `no such ${kind === "maxwell" ? "Maxwell" : "research"} snapshot` });
      return new Response(object.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (await sha256hex(body) !== digest) return json(400, { error: "snapshot checksum does not match" });
    try {
      if (kind === "maxwell") validateMaxwellSnapshot(data);
      else if (kind === "research") validateResearchSnapshot(data);
      else validateLegacyMaxwellSnapshot(data);
    } catch (error) {
      return json(400, { error: error.message });
    }
    if (!await quota(env, account, kind)) return json(429, { error: `too many ${kind} uploads today` });
    await env.SYNC.put(key, body);
    const countKey = kind === "maxwell" ? "blocks" : kind === "research" ? "events" : "records";
    const entries = kind === "maxwell" ? data.chain : kind === "research" ? data.events : data.records;
    const projectStreamStatus = await sendProjectEvent(env, account, {
      event_type: "archive_snapshot_stored",
      kind,
      sha256: digest,
      item_count: entries.length,
      byte_count: body.length,
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    return json(200, { stored: digest, [countKey]: entries.length, bytes: body.length, project_stream_status: projectStreamStatus });
  }
  if (method === "GET" && (m = path.match(/^\/v1\/dna\/chain\/([0-9A-Za-z._-]{1,80})$/))) {
    if (!env.DNA_BLOCKCHAIN) return json(500, { error: "DNA_BLOCKCHAIN binding is not configured" });
    const chainKey = `accounts/${account}/dna/${m[1]}.json`;
    const chain = await readKvJson(env.DNA_BLOCKCHAIN, chainKey);
    if (!chain) return json(404, { error: "no such DNA chain" });
    return json(200, chain);
  }
  if (method === "POST" && (m = path.match(/^\/v1\/dna\/chain\/([0-9A-Za-z._-]{1,80})$/))) {
    if (!env.DNA_BLOCKCHAIN) return json(500, { error: "DNA_BLOCKCHAIN binding is not configured" });
    if (!data || typeof data.record !== "object") return json(400, { error: "send a JSON object with record" });
    const chainKey = `accounts/${account}/dna/${m[1]}.json`;
    const existing = await readKvJson(env.DNA_BLOCKCHAIN, chainKey);
    const entries = existing?.entries || [];
    const previousHash = entries.length ? entries[entries.length - 1].hash : "0x0";
    const entry = {
      index: entries.length,
      previous_hash: previousHash,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      record: data.record
    };
    const hashInput = JSON.stringify(entry);
    entry.hash = `0x${await sha256hex(enc.encode(hashInput))}`;
    const chain = { name: m[1], account, entries: [...entries, entry] };
    await env.DNA_BLOCKCHAIN.put(chainKey, JSON.stringify(chain));
    let streamStatus = "not_configured";
    if (env.DNA_EVENTS) {
      try {
        await env.DNA_EVENTS.send([{
          event_type: "dna_chain_record_appended",
          chain_name: m[1],
          index: entry.index,
          previous_hash: entry.previous_hash,
          entry_hash: entry.hash,
          created_at: entry.created_at
        }]);
        streamStatus = "sent";
      } catch {
        streamStatus = "failed";
      }
    }
    let projectStreamStatus = "not_eligible";
    if (data.record?.classification === "public") {
      try {
        const textFields = ["classification", "type", "topic", "message"];
        if (Object.keys(data.record).some((key) => !textFields.includes(key)) || Object.values(data.record).some((value) => typeof value !== "string" || value.length > 1e3)) {
          throw new Error("only simple public text records are eligible for DNA metadata streaming");
        }
        screenPublicSnapshot(data.record);
        projectStreamStatus = await sendProjectEvent(env, account, {
          event_type: "dna_public_record_appended",
          kind: "dna",
          sha256: entry.hash.slice(2),
          item_count: 1,
          byte_count: body.length,
          created_at: entry.created_at
        });
      } catch {
        projectStreamStatus = "not_eligible";
      }
    }
    return json(200, { ...chain, stream_status: streamStatus, project_stream_status: projectStreamStatus });
  }
  if (method === "POST" && path === "/v1/corpus") {
    let records;
    try {
      records = cleanRecords(data?.records);
    } catch (error) {
      return json(400, { error: error.message });
    }
    if (!await quota(env, account, "corpus")) return json(429, { error: "too many corpus uploads today" });
    const name = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}.json`;
    await env.SYNC.put(`corpus/batches/${name}`, JSON.stringify({ records }));
    const outcome = await env.DB.prepare(
      `INSERT OR IGNORE INTO corpus_records (source, external_id, title, abstract, source_url, published_at, batch, added_at)
       SELECT json_extract(value, '$.source'), json_extract(value, '$.external_id'), json_extract(value, '$.title'),
              json_extract(value, '$.abstract'), json_extract(value, '$.source_url'), json_extract(value, '$.published_at'), ?, ?
       FROM json_each(?)`
    ).bind(name, (/* @__PURE__ */ new Date()).toISOString(), JSON.stringify(records)).run();
    return json(200, { batch: name, records: records.length, new_records: outcome.meta?.changes || 0 });
  }
  if (method === "POST" && path === "/v1/training") {
    let item;
    try {
      item = cleanTraining(data);
    } catch (error) {
      return json(400, { error: error.message });
    }
    if (!await quota(env, account, "training")) return json(429, { error: "too many shared answers today" });
    await env.DB.prepare(
      // no account or device is stored with it
      "INSERT INTO training_answers (id, shared_at, question, answer, sources, rating, model) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), item.shared_at, item.question, item.answer, JSON.stringify(item.sources), item.rating, item.model).run();
    return json(200, { shared: true });
  }
  if (method === "POST" && path === "/v1/pairing") {
    const slot = String(data?.slot || "");
    const sealed = String(data?.sealed || "");
    if (!SLOT_RE.test(slot) || !sealed || sealed.length > 1024) return json(400, { error: "send a slot and the sealed secret" });
    if (await env.SYNC.head(`pairing/${slot}.json`)) return json(409, { error: "that slot is taken; try again" });
    if (!await quota(env, account, "pairing")) return json(429, { error: "too many pairing codes today" });
    await env.SYNC.put(`pairing/${slot}.json`, JSON.stringify({ sealed, expires_at: Date.now() + 6e5, attempts: 0 }));
    return json(200, { slot, expires_in: 600 });
  }
  if (path.startsWith("/v1/admin/")) {
    if (!env.ADMIN_ACCOUNT || account !== env.ADMIN_ACCOUNT) return json(403, { error: "only the owner's account can do that" });
    return admin(method, path, url, data, env);
  }
  return json(404, { error: "not found" });
}
__name(handle, "handle");
var STATUSES = ["pending", "approved", "rejected"];
var rowOut = /* @__PURE__ */ __name((r) => ({ ...r, sources: JSON.parse(r.sources || "[]") }), "rowOut");
async function admin(method, path, url, data, env) {
  if (method === "GET" && path === "/v1/admin/training") {
    const status = url.searchParams.get("status") || "pending";
    if (![...STATUSES, "all"].includes(status)) return json(400, { error: "status is pending, approved, rejected or all" });
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
    const query = status === "all" ? env.DB.prepare("SELECT * FROM training_answers ORDER BY shared_at LIMIT ?").bind(limit) : env.DB.prepare("SELECT * FROM training_answers WHERE status = ? ORDER BY shared_at LIMIT ?").bind(status, limit);
    return json(200, { items: (await query.all()).results.map(rowOut) });
  }
  if (method === "POST" && path === "/v1/admin/training/review") {
    const ids = Array.isArray(data?.ids) ? data.ids.map(String) : [];
    if (!ids.length || ids.length > 500 || !STATUSES.includes(data?.status)) return json(400, { error: "send 1 to 500 ids and a status" });
    const outcome = await env.DB.prepare(
      "UPDATE training_answers SET status = ?, reviewed_at = ? WHERE id IN (SELECT value FROM json_each(?))"
    ).bind(data.status, (/* @__PURE__ */ new Date()).toISOString(), JSON.stringify(ids)).run();
    return json(200, { updated: outcome.meta?.changes || 0 });
  }
  if (method === "GET" && path === "/v1/admin/training/export") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 1e3, 1), 5e3);
    const { results } = await env.DB.prepare(
      "SELECT id, shared_at, question, answer, sources, rating, model, status FROM training_answers WHERE exported_in IS NULL AND status != 'rejected' ORDER BY shared_at LIMIT ?"
    ).bind(limit).all();
    return json(200, { items: results.map(rowOut) });
  }
  if (method === "POST" && path === "/v1/admin/training/exported") {
    const ids = Array.isArray(data?.ids) ? data.ids.map(String) : [];
    const file = String(data?.file || "");
    if (!/^data\/[0-9A-Za-z._-]{1,80}\.parquet$/.test(file) || !/^[0-9a-f]{64}$/.test(String(data?.sha256)) || !ids.length || ids.length > 5e3) {
      return json(400, { error: "send file (data/<name>.parquet), sha256, hf_commit and the exported ids" });
    }
    if (await env.DB.prepare("SELECT 1 FROM exports WHERE file = ?").bind(file).first()) {
      return json(409, { error: `${file} is already recorded as an export` });
    }
    const [, marked] = await env.DB.batch([
      // a batch is one transaction: both or neither
      env.DB.prepare("INSERT INTO exports (file, created_at, rows, sha256, hf_commit) VALUES (?, ?, ?, ?, ?)").bind(file, (/* @__PURE__ */ new Date()).toISOString(), ids.length, data.sha256, String(data.hf_commit || "").slice(0, 80)),
      env.DB.prepare("UPDATE training_answers SET exported_in = ? WHERE exported_in IS NULL AND id IN (SELECT value FROM json_each(?))").bind(file, JSON.stringify(ids))
    ]);
    return json(200, { file, marked: marked.meta?.changes || 0 });
  }
  if (method === "GET" && path === "/v1/admin/stats") {
    const [training, corpus, exports] = await env.DB.batch([
      env.DB.prepare("SELECT status, COUNT(*) AS answers, SUM(exported_in IS NOT NULL) AS exported FROM training_answers GROUP BY status"),
      env.DB.prepare("SELECT COUNT(*) AS records, COUNT(DISTINCT source) AS sources FROM corpus_records"),
      env.DB.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(rows), 0) AS rows, MAX(created_at) AS last FROM exports")
    ]);
    const accounts = (await listAll(env.SYNC, "accounts/")).filter((o) => o.key.endsWith("/account.json")).length;
    return json(200, { accounts, training: training.results, corpus: corpus.results[0], exports: exports.results[0] });
  }
  return json(404, { error: "not found" });
}
__name(admin, "admin");
var index_default = {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      return json(500, { error: `the sync service hit an error (${error.name})` });
    }
  }
};

// src/agent-entry.js
var ArchiveAgent = class extends WorkerEntrypoint {
  static {
    __name(this, "ArchiveAgent");
  }
  async authorize(input) {
    const request = new Request(`https://agent.internal${input.path}`, {
      method: input.method,
      headers: input.headers,
      body: input.method === "GET" ? void 0 : input.body
    });
    const response = await authorizeAgentRequest(request, this.env);
    return { status: response.status, data: await response.json() };
  }
  async verify(params) {
    return verifyAgentSnapshot(params, this.env);
  }
  async fetch() {
    return Response.json({ error: "private service-binding entrypoint" }, { status: 404 });
  }
};
var agent_entry_default = index_default;
export {
  ArchiveAgent,
  Quota,
  agent_entry_default as default
};
//# sourceMappingURL=agent-entry.js.map
