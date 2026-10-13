import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VaultMailbox } from "../tools/vault-agent/clients/VaultMailbox.mts";
import { withMailbox } from "../tools/vault-agent/mailbox.mjs";

const entrypoint = resolve("scripts", "vault-agent-network.mjs");
const runFile = promisify(execFile);
const task = "a".repeat(64);
async function temporary(action) {
  const vault = await mkdtemp(join(tmpdir(), "vault-language-clients-"));
  try { await action(vault); } finally { await rm(vault, { recursive: true, force: true }); }
}

test("TypeScript completion results persist offline, replay after restart and route to the returning agent", async () => temporary(async vault => {
  const worker = new VaultMailbox({ vault, entrypoint, sender: "typescript-worker", recipient: "returning-agent" });
  const result = 'Synthetic source:\nexport const answer = "\u00e9 \ud83d\ude80";\n';
  const sent = await worker.completeTask(task, "v1", result);
  assert.equal(sent.replay, false);
  const restarted = new VaultMailbox({ vault, entrypoint, sender: "typescript-worker", recipient: "returning-agent" });
  assert.equal((await restarted.completeTask(task, "v1", result)).id, sent.id);
  assert.equal((await restarted.completeTask(task, "v1", result)).replay, true);
  const agent = new VaultMailbox({ vault, entrypoint, sender: "returning-agent", recipient: "typescript-worker" });
  const received = await agent.receive();
  assert.equal(received.messages[0].id, sent.id);
  const message = await agent.read(sent.id);
  assert.deepEqual(JSON.parse(message.content), { version: 1, task, revision: "v1", status: "completed", result });
  assert.equal((await agent.receive()).messages.length, 1);
  await assert.rejects(agent.acknowledge(sent.id, "b".repeat(64)), /hash does not match/);
  await agent.acknowledge(sent.id, message.artifact);
  assert.equal((await agent.receive()).messages.length, 0);
  assert.equal((await worker.completeTask(task, "v1", result)).status, "acknowledged");
  await assert.rejects(worker.completeTask(task, "v1", "different result"), /different immutable content/);
  const revision = await worker.reportTask(task, "v2", "failed", "Synthetic validation failed; task needs review.");
  assert.notEqual(revision.id, sent.id);
  assert.equal((await agent.receive()).messages[0].id, revision.id);
}));

test("TypeScript client refuses invalid IDs, content limits and paths without corrupting retained work", async () => temporary(async vault => {
  assert.throws(() => new VaultMailbox({ vault, entrypoint: "relative.mjs", sender: "script", recipient: "agent" }), /absolute/);
  assert.throws(() => new VaultMailbox({ vault, entrypoint, sender: "../script", recipient: "agent" }), /lowercase/);
  const worker = new VaultMailbox({ vault, entrypoint, sender: "script", recipient: "agent" });
  await assert.rejects(worker.completeTask("task-name", "v1", "Synthetic result"), /SHA-256/);
  await assert.rejects(worker.completeTask(task, "a".repeat(33), "Synthetic result"), /revision/);
  await assert.rejects(worker.send("oversize", "code", "\u00e9".repeat(32769)), /65536/);
  const sent = await worker.send("exact-limit", "code", "x".repeat(65536));
  assert.ok(sent.id);
  await assert.rejects(worker.completeTask(task, "v1", "x".repeat(65536)), /65536/);
  await withMailbox(vault, mailbox => assert.equal(mailbox.list().storage.messages, 1));
  const missingCli = new VaultMailbox({ vault, entrypoint: join(vault, "missing.mjs"), sender: "script", recipient: "agent" });
  await assert.rejects(missingCli.completeTask(task, "v1", "Synthetic result"), /Cannot find module/);
}));

test("TypeScript completion script retains a saved result and fails explicitly on missing inputs", async () => temporary(async vault => {
  const example = resolve("tools", "vault-agent", "examples", "complete-task.mts");
  const resultFile = join(vault, "saved-result.txt");
  await writeFile(resultFile, "Synthetic script task completed.\n");
  const result = JSON.parse((await runFile(process.execPath, [example, entrypoint, vault, "script-worker", "agent", task, "v1", resultFile])).stdout);
  const agent = new VaultMailbox({ vault, entrypoint, sender: "agent", recipient: "script-worker" });
  assert.equal(JSON.parse((await agent.read(result.id)).content).result, "Synthetic script task completed.\n");
  await assert.rejects(runFile(process.execPath, [example]), /Usage:/);
}));
