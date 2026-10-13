import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { requestAgent, inspectRequest, approveRequest, listDispatcher, runDispatcher } from "../tools/vault-agent/dispatcher.mjs";
import { withMailbox } from "../tools/vault-agent/mailbox.mjs";
import { withCoordinator } from "../tools/vault-agent/coordinator.mjs";
import { createTools, execute } from "../tools/vault-agent/runtime.mjs";
import { buildAdapters } from "../tools/vault-agent/task-adapters.mjs";

const runFile = promisify(execFile);
const task = (overrides = {}) => ({ version: 1, capability: "text.transform",
  instruction: "Explain public synthetic addition.", adapters: ["local"], ...overrides });
const mock = (advance, identity = "test-v1") => ({ remote: false, identity,
  discover: async () => ({ versions: [1], capabilities: ["text.transform"], idempotentTasks: true }),
  prepare: async ({ id, definition }) => ({ id, definition }), advance });
async function temporary(action) {
  const vault = await mkdtemp(join(tmpdir(), "rabbit-dispatch-"));
  try { await action(vault); } finally { await rm(vault, { recursive: true, force: true }); }
}

test("per-agent dispatcher executes only approved requests and returns durable results without reexecution", async () => temporary(async vault => {
  let calls = 0;
  const adapters = { local: mock(async () => { calls++; return { content: "Synthetic dispatched result" }; }) };
  const sent = await requestAgent(vault, "requesting-agent", "coding-dispatcher", task());
  assert.equal((await requestAgent(vault, "requesting-agent", "coding-dispatcher", task())).replay, true);
  assert.deepEqual((await runDispatcher(vault, "coding-dispatcher", adapters)).reports, []);
  assert.equal(calls, 0);
  const inspected = await inspectRequest(vault, "coding-dispatcher", sent.id);
  assert.equal(inspected.sender, "requesting-agent");
  await approveRequest(vault, "coding-dispatcher", sent.id);
  assert.equal((await approveRequest(vault, "coding-dispatcher", sent.id)).replay, true);
  const report = await runDispatcher(vault, "coding-dispatcher", adapters);
  assert.equal(calls, 1);
  assert.equal(report.returned[0].recipient, "requesting-agent");
  await withMailbox(vault, mailbox => {
    assert.equal(mailbox.receive("coding-dispatcher").messages.length, 0);
    const response = mailbox.read("requesting-agent", report.returned[0].receipt);
    const content = JSON.parse(response.content);
    assert.equal(content.type, "agent-response");
    assert.equal(content.request, sent.id);
    assert.equal(content.result, "Synthetic dispatched result");
    assert.equal(mailbox.receive("requesting-agent").messages.length, 1);
  });
  assert.equal((await runDispatcher(vault, "coding-dispatcher", adapters)).returned.length, 0);
  assert.equal(calls, 1);
  assert.equal((await listDispatcher(vault, "coding-dispatcher")).requests[0].delivered, true);
  assert.equal((await listDispatcher(vault, "other-dispatcher")).queue.tasks.length, 0);
  await withCoordinator(vault, queue => assert.equal(queue.list().tasks.length, 0));
}));

test("dispatcher gates remote sharing, unsupported requests, exact recipient and invalid dependencies", async () => temporary(async vault => {
  await assert.rejects(requestAgent(vault, "self-agent", "self-agent", task()), /self-dispatch/);
  await assert.rejects(requestAgent(vault, "requester", "../bad", task()), /lowercase/);
  await assert.rejects(requestAgent(vault, "requester", "dispatcher", task({ command: "run silently" })), /Unknown task/);
  const sent = await requestAgent(vault, "requester", "dispatcher", task());
  await assert.rejects(approveRequest(vault, "other-agent", sent.id), /Unknown local/);
  let calls = 0;
  await approveRequest(vault, "dispatcher", sent.id);
  const remote = { ...mock(async () => { calls++; return { content: "Not approved" }; }), remote: true };
  const report = await runDispatcher(vault, "dispatcher", { local: remote });
  assert.equal(report.reports[0].status, "waiting");
  assert.equal(calls, 0);
  assert.equal(report.returned.length, 0);
  const dependent = await requestAgent(vault, "requester", "dispatcher", task({ dependsOn: ["a".repeat(64)] }));
  await assert.rejects(approveRequest(vault, "dispatcher", dependent.id), /already/);
  const malformed = await withMailbox(vault, mailbox => mailbox.send({
    version: 1, sender: "requester", recipient: "dispatcher", key: "untrusted", kind: "handoff", route: "local",
    share: false, content: JSON.stringify({ version: 1, type: "agent-request", task: task(), authorize: true }),
  }));
  await assert.rejects(approveRequest(vault, "dispatcher", malformed.id), /Unsupported/);
}));

test("failed tasks return explicit failure feedback; resumed pinned adapters do not silently switch", async () => temporary(async vault => {
  const sent = await requestAgent(vault, "requester", "dispatcher", task());
  await approveRequest(vault, "dispatcher", sent.id);
  const first = await runDispatcher(vault, "dispatcher", { local: mock(async () => ({ pending: true })) });
  assert.equal(first.reports[0].status, "waiting");
  await withCoordinator(vault, async queue => {
    Object.values(queue.state.tasks)[0].nextAttempt = 0;
    await queue.save();
  }, "Cloud Agents/Dispatchers/dispatcher/state.json");
  let calls = 0;
  const next = await runDispatcher(vault, "dispatcher", { local: mock(async () => { calls++; return { content: "Incorrect" }; }, "changed-provider") });
  assert.equal(next.returned[0].status, "blocked");
  assert.equal(calls, 0);
  await withMailbox(vault, mailbox => {
    const content = JSON.parse(mailbox.read("requester", next.returned[0].receipt).content);
    assert.match(content.error, /identity changed/);
    assert.equal(content.result, undefined);
  });
}));

test("full mailbox preserves completed work and retries return delivery without running the task again", async () => temporary(async vault => {
  const sent = await requestAgent(vault, "requester", "dispatcher", task());
  await approveRequest(vault, "dispatcher", sent.id);
  let removable;
  await withMailbox(vault, async mailbox => {
    for (let index = 0; index < 127; index++) {
      const result = await mailbox.send({ version: 1, sender: "filler", recipient: "recipient", key: `filler-${index}`,
        kind: "handoff", route: "local", share: false, content: "Synthetic capacity fixture" });
      removable ??= result.id;
    }
  });
  let calls = 0;
  const adapters = { local: mock(async () => { calls++; return { content: "Durably completed before return" }; }) };
  await assert.rejects(runDispatcher(vault, "dispatcher", adapters), /Mailbox is full/);
  assert.equal((await listDispatcher(vault, "dispatcher")).queue.tasks[0].status, "done");
  await withMailbox(vault, async mailbox => {
    const message = mailbox.read("recipient", removable);
    await mailbox.acknowledge({ recipient: "recipient", id: removable, artifact: message.artifact });
    await mailbox.prune([removable]);
  });
  assert.equal((await runDispatcher(vault, "dispatcher", adapters)).returned.length, 1);
  assert.equal(calls, 1);
}));

test("local AI action requests agent work but cannot approve or execute its own request", async () => temporary(async vault => {
  let turn = 0;
  const result = await execute(vault, "Ask another agent to explain synthetic addition.", { type: "ollama", model: "qwen2.5:3b" },
    async (url, request) => {
      assert.match(JSON.stringify(JSON.parse(request.body).format), /agent_request/);
      return Response.json({ message: { content: JSON.stringify(turn++ === 0
        ? { action: "tool", name: "agent_request", arguments: { dispatcher: "ai-dispatcher", task: task() } }
        : { action: "answer", content: "Agent request retained; approval required before execution." }) } });
    });
  assert.match(result.answer, /approval/);
  const state = await listDispatcher(vault, "ai-dispatcher");
  assert.equal(state.inbox.messages[0].sender, "note-agent");
  assert.equal(state.queue.tasks.length, 0);
  await assert.rejects(createTools(vault, true, "hosted").tools.agent_request.execute({ dispatcher: "ai-dispatcher", task: task() }), /Hosted/);
}));

test("installed dispatcher CLI calls existing offline local adapter and routes result back across processes", async () => temporary(async vault => {
  await mkdir(join(vault, "Agents"));
  await writeFile(join(vault, "Agents", "Synthetic.md"), "# Synthetic dispatch\nPublic dispatch syntax example.");
  const input = join(vault, "task.json");
  await writeFile(input, JSON.stringify(task({ capability: "notes.search", instruction: "dispatch syntax" })));
  const cli = (...args) => runFile(process.execPath, [resolve("scripts", "vault-agent-dispatch.mjs"), "--vault", vault, "--agent", "offline-dispatcher", ...args]);
  const sent = JSON.parse((await cli("--request", input, "--sender", "script-agent")).stdout);
  await cli("--approve", sent.id);
  const report = JSON.parse((await cli("--run")).stdout);
  assert.equal(report.returned[0].status, "done");
  await withMailbox(vault, mailbox => {
    const response = JSON.parse(mailbox.read("script-agent", report.returned[0].receipt).content);
    assert.equal(JSON.parse(response.result).matches[0].path, "Agents/Synthetic.md");
  });
  assert.equal(JSON.parse((await cli("--run")).stdout).reports.length, 0);
  await assert.rejects(cli("--approve", sent.id, "--sender", "forged"), /required only/);
  assert.ok(await buildAdapters(vault));
}));

test("configured agent connection is called once and shared task results return to each approved requester", async () => temporary(async vault => {
  const prior = process.env.VAULT_DISPATCH_TEST_TOKEN;
  process.env.VAULT_DISPATCH_TEST_TOKEN = "synthetic-dispatch-token-not-secret-32";
  try {
    let prepared;
    let submissions = 0;
    const adapters = await buildAdapters(vault, { adapters: [{
      id: "peer", type: "agent-http", url: "https://authorized.example",
      allowRemote: true, tokenEnv: "VAULT_DISPATCH_TEST_TOKEN",
    }] }, async (url, options) => {
      assert.ok(url.startsWith("https://authorized.example/"));
      if (url.endsWith("/capabilities")) return Response.json({ versions: [1], capabilities: ["text.transform"], idempotentTasks: true });
      if (options.method === "POST") {
        submissions++; prepared = JSON.parse(options.body);
        return Response.json({ version: 1, id: prepared.id }, { status: 202 });
      }
      return Response.json({ version: 1, id: prepared.id, status: "done", content: "Synthetic connected-agent result" });
    });
    const definition = task({ adapters: ["peer"], share: true });
    const first = await requestAgent(vault, "first-agent", "connection-dispatcher", definition);
    const second = await requestAgent(vault, "second-agent", "connection-dispatcher", definition);
    await approveRequest(vault, "connection-dispatcher", first.id);
    await approveRequest(vault, "connection-dispatcher", second.id);
    const report = await runDispatcher(vault, "connection-dispatcher", adapters);
    assert.equal(submissions, 1);
    assert.equal(report.returned.length, 2);
    await withMailbox(vault, mailbox => {
      for (const returned of report.returned) {
        assert.equal(JSON.parse(mailbox.read(returned.recipient, returned.receipt).content).result, "Synthetic connected-agent result");
      }
    });
  } finally {
    if (prior === undefined) delete process.env.VAULT_DISPATCH_TEST_TOKEN;
    else process.env.VAULT_DISPATCH_TEST_TOKEN = prior;
  }
}));

test("return batches stop at eight and replay a response after interrupted delivery bookkeeping", async () => temporary(async vault => {
  const requests = [];
  for (let index = 0; index < 9; index++) {
    const sent = await requestAgent(vault, `requester-${index}`, "dispatcher", task());
    requests.push(sent.id);
    await approveRequest(vault, "dispatcher", sent.id);
  }
  let calls = 0;
  const adapters = { local: mock(async () => { calls++; return { content: "Shared synthetic task result" }; }) };
  const first = await runDispatcher(vault, "dispatcher", adapters);
  assert.equal(first.returned.length, 8);
  assert.equal(first.pendingReturns, 1);
  assert.equal((await runDispatcher(vault, "dispatcher", adapters)).returned.length, 1);
  assert.equal(calls, 1);
  await withCoordinator(vault, async queue => {
    const record = queue.state.dispatchRequests[requests[0]];
    record.delivered = false;
    delete record.receipt;
    await queue.save();
  }, "Cloud Agents/Dispatchers/dispatcher/state.json");
  const replay = await runDispatcher(vault, "dispatcher", adapters);
  assert.equal(replay.returned[0].receipt, first.returned[0].receipt);
  assert.equal(calls, 1);
  await withMailbox(vault, mailbox => assert.equal(mailbox.receive("requester-0").messages.length, 1));
}));

test("oversized response envelopes preserve completed output and never truncate or reexecute", async () => temporary(async vault => {
  const sent = await requestAgent(vault, "requester", "dispatcher", task());
  await approveRequest(vault, "dispatcher", sent.id);
  let calls = 0;
  const adapters = { local: mock(async () => { calls++; return { content: "x".repeat(65536) }; }) };
  await assert.rejects(runDispatcher(vault, "dispatcher", adapters), /65536/);
  await assert.rejects(runDispatcher(vault, "dispatcher", adapters), /65536/);
  const state = await listDispatcher(vault, "dispatcher");
  assert.equal(state.queue.tasks[0].status, "done");
  assert.equal(state.requests[0].delivered, false);
  assert.equal(calls, 1);
  await withMailbox(vault, mailbox => {
    assert.equal(mailbox.receive("dispatcher").messages[0].id, sent.id);
    assert.equal(mailbox.receive("requester").messages.length, 0);
  });
}));
