import { checkCredentials, normalizeJob, validId } from "../../workers/vault-agent/src/protocol.mjs";
import { networkFetch, proxySettings } from "./network-transport.mjs";

const SCOPES = ["shell.execute", "vault.submit", "vault.read"];
const ACTIONS = ["request", "status", "shell", "submit", "job-status", "job-result", "list", "approve", "deny", "revoke"];
const NOTE_AGENT_ACTIONS = ["request", "status", "list", "approve", "deny", "revoke"];

export function cloudAccessTool(config, remote, transport) {
  if (remote) throw new Error("Hosted note providers cannot use private agent approval tools.");
  if (!config || typeof config !== "object" || Array.isArray(config) || config.allowRemote !== true
      || Object.keys(config).some(key => !["allowRemote", "actions", "appUrl", "brokerUrl", "tokenEnv", "approvalTokenEnv", "proxy"].includes(key))
      || !Array.isArray(config.actions) || !config.actions.length || config.actions.length > NOTE_AGENT_ACTIONS.length
      || new Set(config.actions).size !== config.actions.length || config.actions.some(action => !NOTE_AGENT_ACTIONS.includes(action))) {
    throw new Error("Explicitly authorize the local agent's exact access-decision actions; no shell tool or wildcard.");
  }
  const callsApprover = config.actions.some(action => ["list", "approve", "deny", "revoke"].includes(action));
  const callsCaller = config.actions.some(action => ["request", "status"].includes(action));
  const envName = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value);
  if (callsCaller && (!envName(config.tokenEnv) || !config.appUrl)) throw new Error("Caller actions need an explicit app origin and tokenEnv.");
  if (callsApprover && (!envName(config.approvalTokenEnv) || !config.brokerUrl)) throw new Error("Approval actions need an explicit broker origin and approvalTokenEnv.");
  if (callsCaller) origin(config.appUrl);
  if (callsApprover) origin(config.brokerUrl);
  proxySettings(config.proxy);
  return {
    description: `Arguments {"action":"configured action","input":{...}}. Trusted host permits only ${JSON.stringify(config.actions)}. request input is {"scopes":["vault.read"]}; status/list use {}; approve/deny/revoke require {"id":"exact pending request hash"}. Operator policy and verified identities are authoritative. Decisions do not execute commands, expand allowlists, or trust AI prose as approval. Credentials remain host environment-only.`,
    async execute(args) {
      if (!args || typeof args !== "object" || Array.isArray(args)
          || Object.keys(args).some(key => !["action", "input"].includes(key))
          || !config.actions.includes(args.action)) throw new Error("The host did not authorize this cloud-access action.");
      const result = await callCloudAccess(args.action, args.input, {
        appUrl: config.appUrl, brokerUrl: config.brokerUrl,
        agentToken: config.tokenEnv ? process.env[config.tokenEnv] : undefined,
        approvalToken: config.approvalTokenEnv ? process.env[config.approvalTokenEnv] : undefined,
        proxy: config.proxy,
        accessClientId: process.env.CF_ACCESS_CLIENT_ID,
        accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
      }, transport);
      return args.action === "list"
        ? { requests: result.requests.slice(0, 16), remaining: Math.max(0, result.requests.length - 16) }
        : result;
    },
  };
}

function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Configure an explicit cloud-tools origin."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use a credential-free HTTPS origin, or explicit loopback HTTP for local tests.");
  }
  return url.origin;
}

function token(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[^\x20-\x7e]/.test(value)) {
    throw new Error("Configure the dedicated credential in an environment variable.");
  }
  return value;
}

export async function callCloudAccess(action, input, config, transport = networkFetch) {
  if (!ACTIONS.includes(action)) throw new Error("Unknown cloud access action.");
  const fields = action === "request" ? ["scopes"] : action === "shell" ? ["command", "consent"]
    : action === "submit" ? ["mode", "instruction", "notes", "consent"] : ["status", "list"].includes(action) ? [] : ["id"];
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !fields.includes(key)))) throw new Error("Unexpected cloud action input fields.");
  const approval = ["list", "approve", "deny", "revoke"].includes(action);
  const base = origin(approval ? config.brokerUrl : config.appUrl);
  const secret = token(approval ? config.approvalToken : config.agentToken);
  let path, body, method = "POST";
  if (action === "list") { path = "/access/requests"; method = "GET"; }
  else if (["approve", "deny", "revoke"].includes(action)) { path = `/access/${action}`; body = { id: validId(input?.id) }; }
  else if (action === "request") {
    if (!Array.isArray(input?.scopes) || !input.scopes.length || input.scopes.length > 3
        || new Set(input.scopes).size !== input.scopes.length || input.scopes.some(scope => !SCOPES.includes(scope))) {
      throw new Error("Request an explicit subset of shell.execute, vault.submit and vault.read.");
    }
    path = "/api/cloud-agent/access/request"; body = { scopes: input.scopes };
  } else if (action === "status") { path = "/api/cloud-agent/access/status"; method = "GET"; }
  else if (action === "shell") {
    if (typeof input?.command !== "string" || !input.command.trim() || input.consent !== true
        || new TextEncoder().encode(input.command).length > 4000 || input.command.includes("\0")) {
      throw new Error("Send an explicitly consented command of 1-4000 UTF-8 bytes.");
    }
    checkCredentials(input.command);
    path = "/api/cloud-agent/shell"; body = { command: input.command, consent: true };
  } else if (action === "submit") {
    if (input?.consent !== true) throw new Error("Explicit consent is required for sharing the snapshot.");
    path = "/api/cloud-agent/vault/jobs"; body = { ...normalizeJob(input), consent: true };
  } else {
    path = `/api/cloud-agent/vault/jobs/${validId(input?.id)}${action === "job-result" ? "/result" : ""}`;
    method = "GET";
  }
  const headers = { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) };
  if (config.accessClientId || config.accessClientSecret) {
    if (!config.accessClientId || !config.accessClientSecret) throw new Error("Configure both Access service-token environment variables.");
    for (const value of [config.accessClientId, config.accessClientSecret]) {
      if (typeof value !== "string" || !value.length || value.length > 4096 || /[^\x20-\x7e]/.test(value)) throw new Error("Invalid Access service credential.");
    }
    headers["CF-Access-Client-Id"] = config.accessClientId;
    headers["CF-Access-Client-Secret"] = config.accessClientSecret;
  }
  const proxy = proxySettings(config.proxy);
  let response;
  try {
    response = await transport(new URL(path, base).href, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(225000),
    }, proxy);
  } catch (error) {
    throw new Error(`Cloud transport failed (${error.name}). Execution or approval may already have happened; no automatic retry.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cloud action failed (HTTP ${response.status}). No operation was automatically retried.`);
  }
  if (!response.headers.get("Content-Type")?.includes("application/json") || !response.body) {
    await response.body?.cancel();
    throw new Error("Cloud action returned no bounded JSON result.");
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) { await reader.cancel(); throw new Error("Cloud result exceeds 256 KiB."); }
      chunks.push(value);
    }
  } catch (error) {
    throw new Error(`Cloud result could not be read (${error.name}). No automatic retry.`);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let result;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Cloud result is not valid UTF-8 JSON."); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Cloud result is not an object.");
  if (action === "list" && (!Array.isArray(result.requests) || result.requests.length > 64
      || result.requests.some(request => request.state !== "pending" || !/^[a-f0-9]{64}$/.test(request.id)
        || typeof request.subject !== "string" || !Array.isArray(request.scopes) || !request.scopes.length
        || request.scopes.some(scope => !SCOPES.includes(scope))
        || !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()))) {
    throw new Error("Cloud approval queue returned invalid request identities.");
  }
  if (["request", "approve", "deny", "revoke", "submit"].includes(action)) validId(result.id);
  if (["approve", "deny", "revoke"].includes(action) && (result.id !== input.id
      || result.state !== ({ approve: "approved", deny: "denied", revoke: "revoked" })[action]
      || !Array.isArray(result.scopes) || !result.scopes.length || result.scopes.some(scope => !SCOPES.includes(scope))
      || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now())) {
    throw new Error("Cloud approval response does not match the requested decision.");
  }
  if (action === "request" && (!["pending", "approved", "denied", "revoked"].includes(result.state)
      || !Array.isArray(result.scopes) || result.scopes.length !== input.scopes.length
      || result.scopes.some(scope => !input.scopes.includes(scope)))) {
    throw new Error("Cloud approval request receipt is inconsistent.");
  }
  if (action === "status" && (typeof result.approved !== "boolean" || !Array.isArray(result.scopes)
      || result.scopes.some(scope => !SCOPES.includes(scope))
      || (result.approved && (!result.scopes.length || !/^[a-f0-9]{64}$/.test(result.requestId)
        || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now())))) {
    throw new Error("Cloud access status is invalid or expired.");
  }
  if (action === "shell" && (typeof result.stdout !== "string" || typeof result.stderr !== "string"
      || !Number.isInteger(result.exitCode) || typeof result.timedOut !== "boolean" || typeof result.truncated !== "boolean")) {
    throw new Error("Cloud command result is incomplete.");
  }
  return result;
}
