import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callCloudAccess, cloudAccessTool } from "../tools/vault-agent/cloud-access.mjs";
import { execute } from "../tools/vault-agent/runtime.mjs";
import { main } from "./vault-cloud-access.mjs";

const config = {
  appUrl: "https://console.example", agentToken: "public-synthetic-agent-token-32-characters",
  brokerUrl: "https://broker.example", approvalToken: "public-synthetic-approver-token-32-characters",
};
const id = "a".repeat(64);

test("native vault approval tools require trusted local host actions and never expose a shell or hosted-provider grant", async () => {
  const settings = { allowRemote: true, actions: ["status"], appUrl: config.appUrl, tokenEnv: "CLOUD_TOOLS_AGENT_TOKEN" };
  assert.throws(() => cloudAccessTool(settings, true), /Hosted/);
  assert.throws(() => cloudAccessTool({ ...settings, allowRemote: false }, false), /Explicitly/);
  assert.throws(() => cloudAccessTool({ ...settings, actions: ["shell"] }, false), /shell/);
  const tool = cloudAccessTool(settings, false, () => assert.fail("unapproved action dispatched"));
  await assert.rejects(tool.execute({ action: "approve", input: { id } }), /did not authorize/);
});

test("native approval discovery returns at most 16 requests with an explicit remainder", async () => {
  const previous = process.env.RABBIT_AGENT_APPROVAL_TOKEN;
  process.env.RABBIT_AGENT_APPROVAL_TOKEN = config.approvalToken;
  try {
    const tool = cloudAccessTool({
      allowRemote: true, actions: ["list"], brokerUrl: config.brokerUrl, approvalTokenEnv: "RABBIT_AGENT_APPROVAL_TOKEN",
    }, false, async () => Response.json({
      requests: Array.from({ length: 17 }, (_, index) => ({
        id: index.toString(16).padStart(64, "0"), state: "pending", subject: "agent:public-synthetic",
        scopes: ["vault.read"], expiresAt: Date.now() + 900000,
      })),
    }));
    const result = await tool.execute({ action: "list", input: {} });
    assert.equal(result.requests.length, 16);
    assert.equal(result.remaining, 1);
  } finally {
    if (previous === undefined) delete process.env.RABBIT_AGENT_APPROVAL_TOKEN; else process.env.RABBIT_AGENT_APPROVAL_TOKEN = previous;
  }
});

test("agent uses distinct fixed approval and caller paths, no Origin/cookie or owner fields", async () => {
  const requests = [];
  const transport = async (url, options) => {
    requests.push({ url, options });
    const action = new URL(url).pathname;
    if (action === "/access/approve") return Response.json({ id, state: "approved", scopes: ["vault.read"], expiresAt: Date.now() + 3600000 });
    if (action.endsWith("/access/request")) return Response.json({ id, state: "pending", scopes: ["vault.read"], expiresAt: Date.now() + 900000 });
    return Response.json({ id, status: "running" });
  };
  await callCloudAccess("approve", { id }, config, transport);
  await callCloudAccess("request", { scopes: ["vault.read"] }, config, transport);
  await callCloudAccess("job-status", { id }, config, transport);
  assert.deepEqual(requests.map(request => request.url), [
    "https://broker.example/access/approve", "https://console.example/api/cloud-agent/access/request",
    `https://console.example/api/cloud-agent/vault/jobs/${id}`,
  ]);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${config.approvalToken}`);
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${config.agentToken}`);
  for (const { options } of requests) {
    assert.equal(options.headers.Origin, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, "error");
  }
  assert.deepEqual(JSON.parse(requests[1].options.body), { scopes: ["vault.read"] });
});

test("unsafe routes, identity overrides, credential patterns and unconsented commands fail before network", async () => {
  const noCall = () => assert.fail("unsafe action dispatched");
  await assert.rejects(callCloudAccess("request", { scopes: ["vault.read"], subject: "email:forged@example.com" }, config, noCall));
  await assert.rejects(callCloudAccess("shell", { command: "echo unsafe", consent: false }, config, noCall));
  await assert.rejects(callCloudAccess("shell", { command: "-----BEGIN PRIVATE KEY-----", consent: true }, config, noCall));
  await assert.rejects(callCloudAccess("status", undefined, { ...config, appUrl: "http://external.example" }, noCall));
  await assert.rejects(callCloudAccess("status", undefined, { ...config, appUrl: "https://user:secret@example.com" }, noCall));
  await assert.rejects(callCloudAccess("submit", { mode: "answer", instruction: "test", notes: [], consent: false }, config, noCall));
});

test("successful-looking approval/command lies, oversized output and HTTP failures are rejected without retry", async () => {
  let calls = 0;
  const fake = async () => { calls++; return Response.json({ id, state: "pending", scopes: ["vault.read"], expiresAt: Date.now() + 900000 }); };
  await assert.rejects(callCloudAccess("approve", { id }, config, fake), /decision/);
  await assert.rejects(callCloudAccess("shell", { command: "echo test", consent: true }, config, fake), /incomplete/);
  await assert.rejects(callCloudAccess("status", undefined, config, async () => {
    calls++; return Response.json({ error: "never reveal upstream credentials" }, { status: 403 });
  }), /HTTP 403/);
  assert.equal(calls, 3);
  await assert.rejects(callCloudAccess("status", undefined, config, async () => Response.json({ text: "x".repeat(262145) })), /could not be read/);
});

test("CLI retains failed calls before exit, using the shared atomic private report helper", async () => {
  const vault = await mkdtemp(join(tmpdir(), "vault-cloud-access-"));
  await mkdir(join(vault, "Cloud Agents", "Results"), { recursive: true });
  const previous = { url: process.env.RABBIT_CLOUD_TOOLS_URL, token: process.env.CLOUD_TOOLS_AGENT_TOKEN };
  process.env.RABBIT_CLOUD_TOOLS_URL = config.appUrl;
  process.env.CLOUD_TOOLS_AGENT_TOKEN = config.agentToken;
  try {
    await assert.rejects(main(["--vault", vault, "--status"], async () => Response.json({}, { status: 503 })), /HTTP 503/);
    const files = await readdir(join(vault, "Cloud Agents", "Results"));
    assert.equal(files.length, 1);
    const raw = await readFile(join(vault, "Cloud Agents", "Results", files[0]), "utf8");
    const report = JSON.parse(raw);
    assert.equal(report.status, "failed");
    assert.equal(report.calls[0].status, "failed");
    assert.equal(report.share, false);
    assert.equal(raw.includes(config.agentToken), false);
  } finally {
    if (previous.url === undefined) delete process.env.RABBIT_CLOUD_TOOLS_URL; else process.env.RABBIT_CLOUD_TOOLS_URL = previous.url;
    if (previous.token === undefined) delete process.env.CLOUD_TOOLS_AGENT_TOKEN; else process.env.CLOUD_TOOLS_AGENT_TOKEN = previous.token;
    await rm(vault, { recursive: true });
  }
});

test("CLI rejects oversized or invalid UTF-8 action files before network and retains failure reports", async () => {
  const vault = await mkdtemp(join(tmpdir(), "vault-cloud-input-"));
  await mkdir(join(vault, "Cloud Agents", "Results"), { recursive: true });
  try {
    const large = join(vault, "large.json"), invalid = join(vault, "invalid.json");
    await writeFile(large, Buffer.alloc(70001, 32));
    await writeFile(invalid, Buffer.from([0xff]));
    const noCall = () => assert.fail("invalid input dispatched");
    await assert.rejects(main(["--vault", vault, "--shell", large], noCall), /70000/);
    await assert.rejects(main(["--vault", vault, "--shell", invalid], noCall), /encoding|encoded/i);
    const reports = await readdir(join(vault, "Cloud Agents", "Results"));
    assert.equal(reports.length, 2);
    for (const name of reports) {
      const report = JSON.parse(await readFile(join(vault, "Cloud Agents", "Results", name), "utf8"));
      assert.equal(report.status, "failed");
      assert.equal(report.calls.length, 0);
    }
  } finally {
    await rm(vault, { recursive: true });
  }
});

test("synthetic local-model turn selects the approval request tool and retains model-origin evidence, not credentials", async () => {
  const vault = await mkdtemp(join(tmpdir(), "vault-native-cloud-access-"));
  await mkdir(join(vault, "Cloud Agents", "Results"), { recursive: true });
  const previous = process.env.CLOUD_TOOLS_AGENT_TOKEN;
  process.env.CLOUD_TOOLS_AGENT_TOKEN = config.agentToken;
  let modelCalls = 0, accessCalls = 0;
  const args = { action: "request", input: { scopes: ["vault.read"] } };
  try {
    const result = await execute(vault, "Request bounded public-synthetic vault access and report pending, not approved.", {
      type: "ollama", model: "public-synthetic-model",
      cloudAccess: { allowRemote: true, actions: ["request"], appUrl: config.appUrl, tokenEnv: "CLOUD_TOOLS_AGENT_TOKEN" },
      requiredCalls: [{ name: "cloud_access", arguments: args }],
    }, async (url, options) => {
      if (String(url).includes("127.0.0.1:11434")) {
        modelCalls++;
        assert.equal(options.body.includes(config.agentToken), false);
        return Response.json({ message: { content: JSON.stringify(modelCalls === 1
          ? { action: "tool", name: "cloud_access", arguments: args }
          : { action: "answer", content: "The access request is pending; no agent approved access yet." }) } });
      }
      accessCalls++;
      assert.equal(String(url), "https://console.example/api/cloud-agent/access/request");
      return Response.json({ id, state: "pending", scopes: ["vault.read"], expiresAt: Date.now() + 900000 });
    });
    assert.equal(accessCalls, 1);
    const raw = await readFile(join(vault, ...result.report.split("/")), "utf8");
    const report = JSON.parse(raw);
    const call = report.calls.find(call => call.name === "cloud_access");
    assert.equal(call.origin, "model");
    assert.equal(call.status, "succeeded");
    assert.equal(report.status, "completed");
    assert.equal(raw.includes(config.agentToken), false);
  } finally {
    if (previous === undefined) delete process.env.CLOUD_TOOLS_AGENT_TOKEN; else process.env.CLOUD_TOOLS_AGENT_TOKEN = previous;
    await rm(vault, { recursive: true });
  }
});
