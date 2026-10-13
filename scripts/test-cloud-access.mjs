import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { accessOperation, accessPolicy, handleAccess } from "../workers/cloudshell/src/access.mts";

const subject = "email:public-synthetic@example.com";
const agent = "agent:vault-public-synthetic";
const policy = accessPolicy(JSON.stringify([subject, agent]), '["shell.execute","vault.submit","vault.read"]');
const fixture = () => {
  const entries = new Map();
  let queue = Promise.resolve();
  return {
    entries,
    transaction(callback) {
      const operation = queue.then(() => callback({
        get: async key => structuredClone(entries.get(key)),
        put: async (key, value) => entries.set(key, structuredClone(value)),
      }));
      queue = operation.catch(() => {});
      return operation;
    },
  };
};

test("policy defaults fail closed, reject wildcards/unknown scopes and require distinct exact identities", () => {
  for (const [subjects, scopes] of [
    ["[]", "[]"], ['["*"]', '["shell.execute"]'], [JSON.stringify([subject]), '["admin"]'],
    [JSON.stringify([subject, subject]), '["vault.read"]'],
  ]) assert.throws(() => accessPolicy(subjects, scopes));
});

test("approval is pending until agent decision, exactly one hour, scoped and subject-bound across recreation", async () => {
  const storage = fixture(), now = 100000;
  const pending = await accessOperation(storage, policy, "request", { subject, scopes: ["vault.read"] }, now);
  assert.equal(pending.status, 202);
  assert.equal(pending.body.state, "pending");
  assert.equal((await accessOperation(storage, policy, "check", { subject }, now)).body.approved, false);
  const approved = await accessOperation(storage, policy, "approve", { id: pending.body.id }, now + 1);
  assert.equal(approved.body.expiresAt, now + 1 + 3600000);
  const freshOperation = (action, body, time) => accessOperation(storage, policy, action, body, time);
  const live = await freshOperation("check", { subject }, now + 3600000);
  assert.equal(live.body.approved, true);
  assert.deepEqual(live.body.scopes, ["vault.read"]);
  assert.equal((await freshOperation("check", { subject: agent }, now + 10)).body.approved, false);
  assert.equal((await freshOperation("check", { subject }, now + 3600001)).body.approved, false);
});

test("agent cannot approve unknown, expired, forged or escalated requests; policy removal revokes access", async () => {
  const storage = fixture(), now = 500000;
  await assert.rejects(accessOperation(storage, policy, "request", { subject: "email:stranger@example.com", scopes: ["vault.read"] }, now));
  await assert.rejects(accessOperation(storage, policy, "request", { subject, scopes: ["admin"] }, now));
  const pending = await accessOperation(storage, policy, "request", { subject, scopes: ["shell.execute"] }, now);
  await assert.rejects(accessOperation(storage, policy, "approve", { id: pending.body.id, subject: agent }, now));
  await assert.rejects(accessOperation(storage, policy, "approve", { id: pending.body.id }, now + 900000), /expired/);
  const next = await accessOperation(storage, policy, "request", { subject, scopes: ["shell.execute"] }, now + 900001);
  await accessOperation(storage, policy, "approve", { id: next.body.id }, now + 900002);
  const narrowed = { ...policy, scopes: ["vault.read"] };
  assert.equal((await accessOperation(storage, narrowed, "check", { subject }, now + 900003)).body.approved, false);
  await assert.rejects(accessOperation(storage, narrowed, "approve", { id: next.body.id }, now + 900003));
});

test("revocation and denial stay enforced; repeated requests cannot refresh grants", async () => {
  const storage = fixture(), now = 200000;
  const first = await accessOperation(storage, policy, "request", { subject, scopes: ["vault.submit"] }, now);
  await accessOperation(storage, policy, "approve", { id: first.body.id }, now);
  const repeat = await accessOperation(storage, policy, "request", { subject, scopes: ["vault.submit"] }, now + 10000);
  assert.equal(repeat.body.id, first.body.id);
  assert.equal(repeat.body.expiresAt, now + 3600000);
  await assert.rejects(accessOperation(storage, policy, "approve", { id: first.body.id }, now + 10001), /pending/);
  await accessOperation(storage, policy, "revoke", { id: first.body.id }, now + 10002);
  assert.equal((await accessOperation(storage, policy, "check", { subject }, now + 10003)).body.approved, false);
  const second = await accessOperation(storage, policy, "request", { subject: agent, scopes: ["vault.read"] }, now);
  await accessOperation(storage, policy, "deny", { id: second.body.id }, now + 1);
  await assert.rejects(accessOperation(storage, policy, "approve", { id: second.body.id }, now + 2));
});

test("job links enforce current-grant ownership instead of treating guessed job IDs as authorization", async () => {
  const storage = fixture(), now = 1000, jobId = "a".repeat(64);
  for (const identity of [subject, agent]) {
    const request = await accessOperation(storage, policy, "request", { subject: identity, scopes: ["vault.read", "vault.submit"] }, now);
    await accessOperation(storage, policy, "approve", { id: request.body.id }, now);
  }
  assert.equal((await accessOperation(storage, policy, "check-job", { subject, jobId }, now)).body.approved, false);
  await accessOperation(storage, policy, "link-job", { subject, jobId }, now);
  assert.equal((await accessOperation(storage, policy, "check-job", { subject, jobId }, now)).body.approved, true);
  assert.equal((await accessOperation(storage, policy, "check-job", { subject: agent, jobId }, now)).body.approved, false);
  assert.equal((await accessOperation(storage, policy, "check-job", { subject, jobId }, now + 3600000)).body.approved, false);
});

test("concurrent repeated requests produce one durable record; queue is bounded at64", async () => {
  const storage = fixture();
  const requests = await Promise.all(Array.from({ length: 8 }, () => accessOperation(storage, policy, "request", { subject, scopes: ["vault.read"] }, 1000)));
  assert.equal(new Set(requests.map(response => response.body.id)).size, 1);
  const full = Array.from({ length: 64 }, (_, index) => ({ id: `${index}`.padStart(64, "0"), subject: `agent:test${index}`, scopes: ["vault.read"], state: "pending", expiresAt: 99999 }));
  storage.entries.set("requests", full);
  await assert.rejects(accessOperation(storage, policy, "request", { subject: agent, scopes: ["vault.read"] }, 1000), /capacity/);
});

test("approval credential cannot execute shell/backend actions; backend credential cannot approve; browser Origins refused", async t => {
  const env = {
    RABBIT_CLOUDSHELL_TOKEN: "public-synthetic-backend-token-32-characters",
    RABBIT_AGENT_APPROVAL_TOKEN: "public-synthetic-approver-token-32-characters",
    RABBIT_CLOUD_ACCESS_SUBJECTS: JSON.stringify([subject]),
    RABBIT_CLOUD_AGENT_SCOPES: '["vault.read"]',
  };
  const request = (action, token, body, headers = {}) => new Request(`https://shell/access/${action}`, {
    method: action === "requests" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    ...(action === "requests" ? {} : { body: JSON.stringify(body) }),
  });

  await t.test("actual Worker persists agent grants and job ownership across workerd restart without starting a container", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rabbit-cloud-access-"));
    const bundled = await build({
      entryPoints: ["workers/cloudshell/src/index.ts"], bundle: true, write: false,
      format: "esm", external: ["cloudflare:workers", "node:*"],
    });
    const backendToken = "public-synthetic-backend-token-32-characters";
    const approverToken = "public-synthetic-approver-token-32-characters";
    const config = {
      ...convertV4MiniflareOptions({ workers: [{
        name: "cloud-access-test", modules: true, script: bundled.outputFiles[0].text,
        compatibilityDate: "2026-10-12", compatibilityFlags: ["nodejs_compat"],
        bindings: {
          RABBIT_CLOUDSHELL_TOKEN: backendToken, RABBIT_AGENT_APPROVAL_TOKEN: approverToken,
          RABBIT_CLOUD_ACCESS_SUBJECTS: JSON.stringify([subject, agent]),
          RABBIT_CLOUD_AGENT_SCOPES: JSON.stringify(["vault.read", "vault.submit"]),
        },
        durableObjects: {
          ACCESS_GATE: { className: "AccessGate", useSQLite: true },
          COMMAND_GATE: { className: "CommandGate", useSQLite: true },
          SANDBOX: { className: "Sandbox", useSQLite: true },
        },
      }] }),
      resourcePersistencePath: directory,
    };
    let runtime;
    try {
      runtime = new Miniflare(config);
      const call = (action, body, token = backendToken) => runtime.dispatchFetch(`https://test/access/${action}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const pending = await Promise.all(Array.from({ length: 8 }, () => call("request", { subject, scopes: ["vault.read", "vault.submit"] }).then(response => response.json())));
      assert.equal(new Set(pending.map(record => record.id)).size, 1);
      assert.equal((await call("approve", { id: pending[0].id })).status, 401);
      const before = Date.now();
      const decisions = await Promise.all(Array.from({ length: 4 }, () => call("approve", { id: pending[0].id }, approverToken)));
      assert.equal(decisions.filter(response => response.status === 200).length, 1);
      assert.equal(decisions.filter(response => response.status === 409).length, 3);
      const approved = await decisions.find(response => response.status === 200).json();
      assert.ok(approved.expiresAt >= before + 3600000 && approved.expiresAt <= Date.now() + 3600000);
      const jobId = "b".repeat(64);
      assert.equal((await call("link-job", { subject, jobId })).status, 200);
      await runtime.dispose();
      runtime = new Miniflare(config);
      assert.equal((await (await call("check", { subject })).json()).approved, true);
      assert.equal((await (await call("check-job", { subject, jobId })).json()).approved, true);
      assert.equal((await (await call("check-job", { subject: agent, jobId })).json()).approved, false);
      assert.equal((await call("revoke", { id: approved.id }, approverToken)).status, 200);
      await runtime.dispose();
      runtime = new Miniflare(config);
      assert.equal((await (await call("check-job", { subject, jobId })).json()).approved, false);
    } finally {
      await runtime?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const noCall = () => assert.fail("unauthorized operation invoked");
  assert.equal((await handleAccess(request("approve", env.RABBIT_CLOUDSHELL_TOKEN, {}), env, noCall)).status, 401);
  assert.equal((await handleAccess(request("request", env.RABBIT_AGENT_APPROVAL_TOKEN, {}), env, noCall)).status, 401);
  assert.equal((await handleAccess(request("requests", env.RABBIT_AGENT_APPROVAL_TOKEN, undefined, { Origin: "null" }), env, noCall)).status, 403);
  assert.equal((await handleAccess(request("check", env.RABBIT_CLOUDSHELL_TOKEN, { subject }), { ...env, RABBIT_AGENT_APPROVAL_TOKEN: env.RABBIT_CLOUDSHELL_TOKEN }, noCall)).status, 503);
  const store = fixture();
  const operate = (action, value, policy) => accessOperation(store, policy, action, value, 5000);
  assert.equal((await handleAccess(request("request", env.RABBIT_CLOUDSHELL_TOKEN, { subject, scopes: ["vault.read"] }), env, operate)).status, 202);
  const listing = await handleAccess(request("requests", env.RABBIT_AGENT_APPROVAL_TOKEN), env, operate);
  assert.equal((await listing.json()).requests.length, 1);
});
