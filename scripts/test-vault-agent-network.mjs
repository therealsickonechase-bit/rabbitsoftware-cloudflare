import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { withMailbox, Mailbox, envelope, MAILBOX_LIMITS } from "../tools/vault-agent/mailbox.mjs";
import { mailboxServer } from "../tools/vault-agent/mailbox-server.mjs";
import { withCoordinator } from "../tools/vault-agent/coordinator.mjs";
import { digest } from "../workers/vault-agent/src/protocol.mjs";

const runFile = promisify(execFile);
const message = (overrides = {}) => ({
  version: 1, sender: "coding-agent", recipient: "local-shell", key: "syntax-v1",
  kind: "code", route: "local", share: false, content: "export const add = (a, b) => a + b;\n", ...overrides,
});
async function temporary(action) {
  const vault = await mkdtemp(join(tmpdir(), "rabbit-network-"));
  try { await action(vault); } finally { await rm(vault, { recursive: true, force: true }); }
}

test("mailbox validates exact fields, version, routes, consent and bounded UTF-8 content", async () => {
  await assert.rejects(envelope(message({ version: 2 })), /version/);
  await assert.rejects(envelope(message({ recipient: "../shell" })), /names/);
  await assert.rejects(envelope(message({ unknown: "ignored" })), /Unknown/);
  await assert.rejects(envelope(message({ route: "cloud" })), /share/);
  await assert.rejects(envelope(message({ share: "false" })), /boolean/);
  await assert.rejects(envelope(message({ content: "x".repeat(65537) })), /65536/);
  await assert.rejects(envelope(message({ content: "\u00e9".repeat(32769) })), /65536/);
  assert.equal((await envelope(message({ content: "x".repeat(65536) }))).definition.artifact, await digest("x".repeat(65536)));
});

test("away agents retrieve unchanged code after restart; reads replay until exact hash acknowledgment", async () => temporary(async vault => {
  let id, artifact;
  await withMailbox(vault, async mailbox => {
    id = (await mailbox.send(message())).id;
    assert.equal((await mailbox.send(message())).replay, true);
    await assert.rejects(mailbox.send(message({ content: "changed code" })), /different immutable/);
    artifact = mailbox.receive("local-shell").messages[0].artifact;
    assert.equal(mailbox.read("local-shell", id).content, message().content);
    assert.equal(mailbox.receive("local-shell").messages.length, 1);
    await assert.rejects(mailbox.prune([id]), /acknowledged/);
  });
  await withMailbox(vault, async mailbox => {
    assert.equal(mailbox.read("local-shell", id).content, message().content);
    assert.equal(mailbox.receive("local-shell").messages.length, 1);
    assert.throws(() => mailbox.read("another-agent", id), /recipient/);
    await assert.rejects(mailbox.acknowledge({ recipient: "local-shell", id, artifact: "a".repeat(64) }), /hash/);
    await mailbox.acknowledge({ recipient: "local-shell", id, artifact });
    await mailbox.acknowledge({ recipient: "local-shell", id, artifact });
    assert.equal(mailbox.receive("local-shell").messages.length, 0);
    assert.equal(mailbox.read("local-shell", id).content, message().content);
  });
  await withMailbox(vault, async mailbox => {
    assert.equal((await mailbox.send(message())).status, "acknowledged");
    await mailbox.prune([id]);
    assert.equal(mailbox.list().storage.artifacts, 0);
  });
}));

test("bounded batches, deduplicated storage and queued cloud routes never silently deliver or discard", async () => temporary(async vault => {
  await withMailbox(vault, async mailbox => {
    for (let index = 0; index < 17; index++) await mailbox.send(message({ key: `batch-${index}` }));
    assert.equal(mailbox.list().storage.artifacts, 1);
    const batch = mailbox.receive("local-shell");
    assert.equal(batch.messages.length, 16);
    assert.equal(batch.remaining, 1);
    const cloud = await mailbox.send(message({ key: "cloud-job", route: "cloud", share: true }));
    assert.equal(cloud.status, "cloud-pending");
    assert.ok(!mailbox.receive("local-shell").messages.some(item => item.id === cloud.id));
    await assert.rejects(mailbox.prune([cloud.id]), /pending\/cloud/);
    await assert.rejects(mailbox.acknowledge({ recipient: "local-shell", id: cloud.id, artifact: batch.messages[0].artifact }), /Unknown local/);
  });
}));

test("capacity exhaustion, corrupted state, future versions and concurrent locking preserve retained data", async () => temporary(async vault => {
  const mailbox = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
  for (let index = 0; index < MAILBOX_LIMITS.messages; index++) await mailbox.send(message({ key: `full-${index}` }));
  await assert.rejects(mailbox.send(message({ key: "overflow" })), /full/);
  await withMailbox(vault, async box => {
    await box.send(message());
    await assert.rejects(withMailbox(vault, () => {}), /busy/);
  });
  const path = join(vault, "Cloud Agents", "Network", "mailbox.json");
  const text = await readFile(path, "utf8");
  const state = JSON.parse(text);
  Object.keys(state.artifacts).forEach(id => { state.artifacts[id] = "Tampered code"; });
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(withMailbox(vault, () => {}), /integrity/);
  await writeFile(path, '{"version":2,"messages":{},"artifacts":{}}');
  await assert.rejects(withMailbox(vault, () => {}), /unsupported/);
  await writeFile(path, text + " ".repeat(MAILBOX_LIMITS.stateBytes - Buffer.byteLength(text)));
  assert.equal(await withMailbox(vault, box => box.list().storage.messages), 1);
  await writeFile(path, text + " ".repeat(MAILBOX_LIMITS.stateBytes - Buffer.byteLength(text) + 1));
  await assert.rejects(withMailbox(vault, () => {}), /exceeds 8 MiB/);
  assert.equal((await readFile(path)).length, MAILBOX_LIMITS.stateBytes + 1);
}));

test("real loopback network requires auth, rejects browsers, replays across server restart and validates acks", async () => temporary(async vault => {
  const token = "synthetic-mailbox-token-not-a-secret-32";
  assert.throws(() => mailboxServer(vault, "short"), /32/);
  let server;
  const listen = async () => {
    server = mailboxServer(vault, token);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())); };
  try {
    let url = await listen();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: { ...headers, Origin: "https://browser.example" } })).status, 403);
    assert.equal((await fetch(`${url}/health`, { headers })).status, 200);
    const sent = await (await fetch(`${url}/messages`, { method: "POST", headers, body: JSON.stringify(message()) })).json();
    assert.equal(sent.status, "pending");
    assert.equal((await fetch(`${url}/messages`, { method: "POST", headers, body: "invalid JSON" })).status, 400);
    assert.equal((await fetch(`${url}/messages`, { method: "POST", headers, body: JSON.stringify(message({ sender: "../unsafe" })) })).status, 400);
    assert.equal((await fetch(`${url}/messages`, { method: "POST", headers, body: JSON.stringify(message({ content: "x".repeat(65536) })) })).status, 400);
    await stop(); url = await listen();
    const inbox = await (await fetch(`${url}/inbox/local-shell`, { headers })).json();
    assert.equal(inbox.messages[0].id, sent.id);
    const received = await (await fetch(`${url}/inbox/local-shell/${sent.id}`, { headers })).json();
    assert.equal(received.content, message().content);
    assert.equal((await fetch(`${url}/ack`, { method: "POST", headers, body: JSON.stringify({ recipient: "local-shell", id: sent.id, artifact: received.artifact }) })).status, 200);
    assert.equal((await (await fetch(`${url}/inbox/local-shell`, { headers })).json()).messages.length, 0);
  } finally { if (server?.listening) await stop(); }
}));

test("serialized storage overflow keeps the last committed mailbox intact", async () => temporary(async vault => {
  const path = join(vault, "Cloud Agents", "Network", "mailbox.json");
  await withMailbox(vault, async mailbox => { await mailbox.send(message()); });
  const prior = await readFile(path, "utf8");
  await withMailbox(vault, async mailbox => {
    const oversized = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
    for (let index = 0; index < 128; index++) {
      await oversized.send(message({ key: `large-${index}`, content: `${String(index).padStart(3, "0")}:` + "x".repeat(65532) }));
    }
    assert.ok(Buffer.byteLength(JSON.stringify(oversized.state)) > MAILBOX_LIMITS.stateBytes);
    Object.assign(mailbox.state, oversized.state);
    await assert.rejects(mailbox.save(), /storage is full/);
  });
  assert.equal(await readFile(path, "utf8"), prior);
}));

test("CLI and task receipt publishing retain completed results without rerunning agents", async () => temporary(async vault => {
  const definition = { version: 1, capability: "text.transform", instruction: "Synthetic linked code", adapters: ["local"], share: false };
  await withCoordinator(vault, async queue => {
    await queue.enqueue(definition);
    const local = { remote: false, identity: "synthetic-local", discover: async () => ({ versions: [1], capabilities: ["text.transform"], idempotentTasks: true }),
      prepare: async ({ id }) => ({ id }), advance: async () => ({ content: message().content }) };
    await queue.run({ local });
  });
  const cli = (...args) => runFile(process.execPath, [join(process.cwd(), "scripts", "vault-agent-network.mjs"), "--vault", vault, ...args]);
  const publish = () => runFile(process.execPath, [join(process.cwd(), "scripts", "vault-agent-tasks.mjs"), "--vault", vault, "--publish", "local-shell"]);
  const first = JSON.parse((await publish()).stdout)[0];
  assert.equal(JSON.parse((await publish()).stdout)[0].replay, true);
  const received = JSON.parse((await cli("--read", `local-shell:${first.id}`)).stdout);
  assert.equal(JSON.parse(received.content).result, message().content);
  const ackPath = join(vault, "ack.json");
  await writeFile(ackPath, JSON.stringify({ recipient: "local-shell", id: first.id, artifact: received.artifact }));
  await cli("--ack", ackPath);
  assert.equal(JSON.parse((await cli("--receive", "local-shell")).stdout).messages.length, 0);
  await cli("--prune", first.id);
  assert.equal(JSON.parse((await cli("--list")).stdout).storage.messages, 0);
}));
