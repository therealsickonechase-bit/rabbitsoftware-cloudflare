const reply = (status, data) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const ID = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const JOB = /^[0-9a-f]{32}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = ["maxwell", "research", "legacy-maxwell"];

export async function runArchiveWorkflow(event, step, env) {
  const params = await step.do("validate approved archive scope", { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "10 seconds" }, async () => {
    const value = event.payload;
    if (env.AGENT_JOBS_ENABLED !== "true" || !value ||
        Object.keys(value).sort().join(",") !== "account,device,kind,sha256" ||
        !ID.test(value.account) || !ID.test(value.device) || !KINDS.includes(value.kind) || !DIGEST.test(value.sha256)) {
      throw new Error("archive job scope is invalid or disabled");
    }
    return value;
  });
  return await step.do("verify stored archive checksum", { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "30 seconds" }, async () => {
    if (env.AGENT_JOBS_ENABLED !== "true") throw new Error("archive verification is disabled");
    try {
      return await env.ARCHIVE.verify(params);
    } catch {
      throw new Error("archive verification refused or unavailable");
    }
  });
}

export async function handleAgentRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return reply(200, { service: "rabbitsoftware-node-worker", tasks: ["verify_archive"], enabled: env.AGENT_JOBS_ENABLED === "true" });
  }
  const creating = request.method === "POST" && url.pathname === "/v1/agent/jobs";
  const match = request.method === "GET" && url.pathname.match(/^\/v1\/agent\/jobs\/([^/]+)$/);
  if (!creating && !match) return reply(404, { error: "no such agent route" });
  if (match && !JOB.test(match[1])) return reply(400, { error: "invalid job identifier" });
  if (env.AGENT_JOBS_ENABLED !== "true" || !env.ARCHIVE || !env.MY_WORKFLOW) {
    return reply(503, { error: "archive agent is disabled or not configured" });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > 2048) return reply(413, { error: "agent requests are limited to 2048 bytes" });
  const headers = {};
  for (const name of ["X-Account", "X-Device", "X-Time", "X-Signature"]) headers[name] = request.headers.get(name) || "";
  try {
    const verdict = await env.ARCHIVE.authorize({ method: request.method, path: url.pathname + url.search,
      headers, body: new TextDecoder().decode(bytes) });
    if (verdict.status !== 200) return reply(verdict.status, verdict.data);
    const scope = verdict.data;
    if (!ID.test(scope.account) || !ID.test(scope.device)) return reply(503, { error: "invalid authorization response" });
    if (creating) {
      const id = `${scope.account}-${scope.request_id}`;
      if (!JOB.test(id) || !KINDS.includes(scope.kind) || !DIGEST.test(scope.sha256)) return reply(503, { error: "invalid authorized job scope" });
      const instance = await env.MY_WORKFLOW.create({ id,
        params: { account: scope.account, device: scope.device, kind: scope.kind, sha256: scope.sha256 } });
      return reply(202, { id: instance.id, task: "verify_archive" });
    }
    if (!match[1].startsWith(`${scope.account}-`)) return reply(404, { error: "no such owner job" });
    const instance = await env.MY_WORKFLOW.get(match[1]);
    const status = await instance.status();
    return reply(200, { id: instance.id, status: status.status,
      ...(status.output ? { result: status.output } : {}),
      ...(status.error ? { error: "archive workflow did not complete successfully" } : {}) });
  } catch {
    return reply(503, { error: "archive agent request failed; no automatic resubmission was made" });
  }
}
