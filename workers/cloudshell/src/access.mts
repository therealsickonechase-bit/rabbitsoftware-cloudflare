import { boundedJson, equalSecrets, HttpError, tokenMatches } from "./http.mjs";

export const SCOPES = ["shell.execute", "vault.submit", "vault.read"] as const;
export type Scope = typeof SCOPES[number];
type State = "pending" | "approved" | "denied" | "revoked";
type RecordEntry = { id: string; subject: string; scopes: Scope[]; state: State; expiresAt: number; jobs?: string[] };
export type Policy = { subjects: string[]; scopes: Scope[] };
const ACTIONS = ["request", "check", "requests", "approve", "deny", "revoke", "link-job", "check-job"] as const;
export type Action = typeof ACTIONS[number];
function isAction(value: string): value is Action { return ACTIONS.some(action => action === value); }
type Result = { status: number; body: Record<string, unknown> };
type Storage = Pick<DurableObjectStorage, "transaction">;

function subject(value: unknown): value is string {
  return typeof value === "string" && value.length <= 260 && (
    /^agent:[a-zA-Z0-9_-]{1,64}$/.test(value)
    || /^email:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(value)
  );
}

function scopes(value: unknown): value is Scope[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= SCOPES.length
    && value.every(item => SCOPES.includes(item)) && new Set(value).size === value.length;
}

export function accessPolicy(rawSubjects: string, rawScopes: string): Policy {
  let subjects: unknown, capabilities: unknown;
  try { subjects = JSON.parse(rawSubjects); capabilities = JSON.parse(rawScopes); }
  catch { throw new HttpError(503, "Configure a valid explicit access policy."); }
  if (!Array.isArray(subjects) || !subjects.length || subjects.length > 64
      || !subjects.every(subject) || new Set(subjects).size !== subjects.length || !scopes(capabilities)) {
    throw new HttpError(503, "Configure 1-64 exact subjects and explicit delegated capabilities.");
  }
  return { subjects, scopes: capabilities };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) {
    throw new HttpError(400, "Unexpected access request fields.");
  }
}

export async function accessOperation(
  storage: Storage, policy: Policy, action: Action, value: unknown, now = Date.now(),
): Promise<Result> {
  if (!object(value)) throw new HttpError(400, "Send an access request object.");
  if (["request", "check", "link-job", "check-job"].includes(action)) {
    keys(value, action === "request" ? ["subject", "scopes"] : action.endsWith("-job") ? ["subject", "jobId"] : ["subject"]);
    if (!subject(value.subject) || !policy.subjects.includes(value.subject)) {
      throw new HttpError(403, "Identity is not on the configured access allowlist.");
    }
    if (action === "request" && (!scopes(value.scopes) || value.scopes.some(scope => !policy.scopes.includes(scope)))) {
      throw new HttpError(403, "Requested capabilities exceed the delegated policy.");
    }
    if (action.endsWith("-job") && (typeof value.jobId !== "string" || !/^[a-f0-9]{64}$/.test(value.jobId))) {
      throw new HttpError(400, "Invalid linked job ID.");
    }
  } else if (action !== "requests") {
    keys(value, ["id"]);
    if (typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)) throw new HttpError(400, "Invalid approval request ID.");
  }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  return storage.transaction(async transaction => {
    const records = (await transaction.get<RecordEntry[]>("requests") ?? []).filter(record => record.expiresAt > now);
    let result: Result;
    const eligible = (record: RecordEntry) => policy.subjects.includes(record.subject)
      && record.scopes.every(scope => policy.scopes.includes(scope));
    if (action === "requests") {
      result = { status: 200, body: { requests: records.filter(record => record.state === "pending" && eligible(record)) } };
    } else if (action === "request") {
      // Same-subject requests reuse the live entry; a caller cannot extend its own grant.
      const existing = records.find(record => record.subject === value.subject);
      if (existing) {
        if (!eligible(existing)) throw new HttpError(403, "Existing request no longer satisfies the delegated policy.");
        const wanted = value.scopes;
        if (!scopes(wanted) || existing.scopes.length !== wanted.length || existing.scopes.some(scope => !wanted.includes(scope))) {
          throw new HttpError(409, "An existing request has different capabilities. Revoke it before replacing it.");
        }
        result = { status: 202, body: { ...existing } };
      } else {
        if (records.length >= 64) throw new HttpError(429, "Access queue capacity reached. Wait for expiration.");
        if (!subject(value.subject) || !scopes(value.scopes)) throw new HttpError(400, "Invalid access request.");
        const record: RecordEntry = { id, subject: value.subject, scopes: [...value.scopes].sort(), state: "pending", expiresAt: now + 900000 };
        records.push(record);
        result = { status: 202, body: { ...record } };
      }
    } else if (action === "check" || action === "link-job" || action === "check-job") {
      const approved = records.find(record => record.subject === value.subject && record.state === "approved" && eligible(record));
      if (action === "link-job") {
        if (!approved?.scopes.includes("vault.submit")) throw new HttpError(403, "No active vault submission grant.");
        if (typeof value.jobId !== "string") throw new HttpError(400, "Invalid linked job ID.");
        const jobs = approved.jobs ?? [];
        if (!jobs.includes(value.jobId)) {
          if (jobs.length >= 64) throw new HttpError(429, "This grant has reached its job-link capacity.");
          approved.jobs = [...jobs, value.jobId];
        }
        result = { status: 200, body: { linked: true, jobId: value.jobId } };
      } else if (action === "check-job") {
        result = { status: 200, body: {
          approved: Boolean(approved?.scopes.includes("vault.read") && approved.jobs?.some(id => id === value.jobId)),
          expiresAt: approved?.expiresAt ?? null,
        } };
      } else {
        result = { status: 200, body: {
          approved: Boolean(approved), scopes: approved?.scopes ?? [], expiresAt: approved?.expiresAt ?? null, requestId: approved?.id ?? null,
        } };
      }
    } else {
      const record = records.find(record => record.id === value.id);
      if (!record) throw new HttpError(404, "Unknown or expired access request.");
      if (!eligible(record)) throw new HttpError(403, "Request no longer satisfies the delegated policy.");
      if (action === "approve") {
        if (record.state !== "pending") throw new HttpError(409, "Only pending requests can be approved.");
        record.state = "approved";
        record.expiresAt = now + 3600000;
      } else {
        if (action === "deny" && record.state !== "pending") throw new HttpError(409, "Only pending requests can be denied.");
        record.state = action === "deny" ? "denied" : "revoked";
        record.expiresAt = now + 900000;
      }
      result = { status: 200, body: { ...record } };
    }
    await transaction.put("requests", records);
    return result;
  });
}

type BrokerConfig = {
  RABBIT_CLOUDSHELL_TOKEN: string;
  RABBIT_AGENT_APPROVAL_TOKEN: string;
  RABBIT_CLOUD_ACCESS_SUBJECTS: string;
  RABBIT_CLOUD_AGENT_SCOPES: string;
};

export async function handleAccess(
  request: Request, env: BrokerConfig,
  operation: (action: Action, value: unknown, policy: Policy) => Promise<Result>,
): Promise<Response> {
  const json = (status: number, body: Record<string, unknown>) => Response.json(body, {
    status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
  if (request.headers.has("Origin")) return json(403, { error: "Use the authenticated backend or approval agent." });
  const action = new URL(request.url).pathname.slice("/access/".length);
  if (!isAction(action)
      || (action === "requests" ? request.method !== "GET" : request.method !== "POST")) {
    return json(404, { error: "Not found." });
  }
  const approver = ["requests", "approve", "deny", "revoke"].includes(action);
  const token = approver ? env.RABBIT_AGENT_APPROVAL_TOKEN : env.RABBIT_CLOUDSHELL_TOKEN;
  if ([env.RABBIT_AGENT_APPROVAL_TOKEN, env.RABBIT_CLOUDSHELL_TOKEN].some(token => typeof token !== "string" || token.length < 32)) {
    return json(503, { error: "Access credentials are not configured." });
  }
  if (await equalSecrets(env.RABBIT_AGENT_APPROVAL_TOKEN, env.RABBIT_CLOUDSHELL_TOKEN)) {
    return json(503, { error: "Backend and approval-agent credentials must be distinct." });
  }
  if (!await tokenMatches(request, token)) return json(401, { error: "Unauthorized." });
  try {
    const policy = accessPolicy(env.RABBIT_CLOUD_ACCESS_SUBJECTS, env.RABBIT_CLOUD_AGENT_SCOPES);
    const value: unknown = action === "requests" ? {} : await boundedJson(request, 8192);
    const result = await operation(action, value, policy);
    if (["request", "approve", "deny", "revoke"].includes(action)) {
      console.log(JSON.stringify({ event: `access_${action}${result.status >= 400 ? "_rejected" : ""}`,
        status: result.status, requestId: result.body.id, state: result.body.state }));
    }
    return json(result.status, result.body);
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error(JSON.stringify({ event: "access_operation_failed", type: error instanceof Error ? error.name : "Error" }));
    return json(502, { error: "Access operation failed. No approval was assumed." });
  }
}
