import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VaultMailbox } from "../tools/vault-agent/clients/VaultMailbox.mts";

const runFile = promisify(execFile);
const executable = name => process.env.VAULT_JAVA_HOME
  ? join(process.env.VAULT_JAVA_HOME, "bin", process.platform === "win32" ? `${name}.exe` : name) : name;
const task = "c".repeat(64);

test("real compiled Java and TypeScript agents exchange retained completion receipts without HTTP or internet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-java-validation-"));
  try {
    await runFile(executable("javac"), ["--release", "11", "-Xlint:all", "-Werror", "-d", directory, resolve("tools", "vault-agent", "clients", "VaultMailbox.java")]);
    const entrypoint = resolve("scripts", "vault-agent-network.mjs");
    const java = async (sender, recipient, ...args) => JSON.parse((await runFile(executable("java"), ["-cp", directory, "VaultMailbox",
      process.execPath, entrypoint, directory, sender, recipient, ...args], { timeout: 45000, maxBuffer: 1024 * 1024 })).stdout);
    const result = 'Synthetic Java result: "quoted" \\ backslash\n\u00e9 \ud83d\ude80\t';
    const resultFile = join(directory, "result.txt");
    await writeFile(resultFile, result);
    const sent = await java("java-worker", "typescript-agent", "complete", task, "v1", resultFile);
    assert.equal(sent.replay, false);
    assert.equal((await java("java-worker", "typescript-agent", "complete", task, "v1", resultFile)).replay, true);
    const typescript = new VaultMailbox({ vault: directory, entrypoint, sender: "typescript-agent", recipient: "java-worker" });
    const read = await typescript.read((await typescript.receive()).messages[0].id);
    assert.equal(JSON.parse(read.content).result, result);
    await typescript.acknowledge(read.id, read.artifact);
    assert.equal((await java("java-worker", "typescript-agent", "complete", task, "v1", resultFile)).status, "acknowledged");
    const reply = await typescript.completeTask(task, "reply-v1", "Synthetic TypeScript processing completed.");
    const inbox = await java("java-worker", "typescript-agent", "receive");
    assert.equal(inbox.messages[0].id, reply.id);
    const javaRead = await java("java-worker", "typescript-agent", "read", reply.id);
    assert.equal(JSON.parse(javaRead.content).status, "completed");
    await assert.rejects(java("java-worker", "typescript-agent", "ack", reply.id, "a".repeat(64)), /hash does not match/);
    await java("java-worker", "typescript-agent", "ack", reply.id, javaRead.artifact);
    assert.equal((await java("java-worker", "typescript-agent", "receive")).messages.length, 0);
    await writeFile(resultFile, "Changed synthetic result");
    await assert.rejects(java("java-worker", "typescript-agent", "complete", task, "v1", resultFile), /different immutable content/);
    await assert.rejects(java("java-worker", "typescript-agent", "complete", "not-a-hash", "v2", resultFile), /SHA-256/);
    await writeFile(resultFile, "x".repeat(65536));
    await assert.rejects(java("java-worker", "typescript-agent", "complete", task, "v2", resultFile), /65536/);
    assert.equal((await typescript.read(read.id)).content, read.content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
