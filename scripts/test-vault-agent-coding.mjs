import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codingAdapter, chunks, runProcess } from "../tools/vault-agent/coding-adapter.mjs";
import { withCoordinator } from "../tools/vault-agent/coordinator.mjs";
import { taskDefinition } from "../tools/vault-agent/task-protocol.mjs";

const task = { version: 1, capability: "code.repair", instruction: "Repair public synthetic addition.", adapters: ["coding"], share: true };
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "rabbit-coding-"));
  try {
    await writeFile(join(root, "cli.mjs"), "// Synthetic mocked coding host");
    await writeFile(join(root, "add.mjs"), "export const add = (a, b) => a - b;\n");
    await writeFile(join(root, "check.test.mjs"), "import { add } from './add.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(add(2, 3), 5);\n");
    const config = { projectRoot: root, cliPath: join(root, "cli.mjs"), allowRemote: true, allowExecution: true,
      files: ["add.mjs"], tests: ["check.test.mjs"], maxLines: 4, maxRounds: 3, apply: true };
    await action(root, config);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("context chunking preserves all UTF-8 content at exact byte and line budgets", () => {
  const text = "syntax \u{1f430}\n".repeat(200) + "x".repeat(6000);
  const parts = chunks(text, 128, 8);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 128 && (part.match(/\n/g)?.length ?? 0) <= 8));
  assert.equal(chunks("x".repeat(4096))[0].length, 4096);
  assert.throws(() => chunks("test", 1), /four bytes/);
});

test("coding adapter repairs, enforces line budget, validates with real Node, backs up and replays without rerunning", async () => fixture(async (root, config) => {
  let rounds = 0;
  const runner = async (command, args, options) => {
    if (args.includes("--version")) return { code: 0, output: "Synthetic host" };
    if (args.includes("--prompt")) {
      rounds++;
      if (rounds === 1) await assert.rejects(adapter.advance(request), /coding runner is locked/);
      assert.equal(options.env.COPILOT_ALLOW_ALL, "false");
      assert.ok(args.includes("--deny-tool=shell"));
      assert.ok(args.includes("--available-tools=view,edit,create,glob,grep"));
      assert.ok(!args.includes("--allow-all-tools"));
      const source = rounds === 1 ? "export const add = (a, b) => a + b;\n\n\n\n\n"
        : "export const add = (a, b) => a + b;\n";
      await writeFile(join(options.cwd, "add.mjs"), source);
      if (rounds === 2) assert.match(await readFile(join(options.cwd, "validation-feedback.txt"), "utf8"), /line budget/);
      return { code: 0, output: "Repaired" };
    }
    return runProcess(command, args, options);
  };
  const adapter = await codingAdapter(config, runner);
  const { id, definition } = await taskDefinition(task);
  const request = await adapter.prepare({ id, definition, artifacts: [] });
  assert.deepEqual((await adapter.discover()).capabilities, ["code.repair"]);
  const result = JSON.parse((await adapter.advance(request)).content);
  assert.equal(result.validated, true);
  assert.equal(result.rounds, 2);
  assert.equal(result.applied, true);
  assert.equal(result.changes[0].path, "add.mjs");
  assert.match(result.changes[0].content, /a \+ b/);
  assert.match(await readFile(join(root, "add.mjs"), "utf8"), /a \+ b/);
  assert.match(await readFile(join(root, ".wrangler", "vault-coding", id, "backups", "add.mjs"), "utf8"), /a - b/);
  assert.equal((await adapter.advance(request)).content, JSON.stringify(result));
  assert.equal(rounds, 2);
}));

test("coding source snapshots integrate with vault artifact links and scoped configuration", async () => fixture(async (root, config) => {
  const vault = join(root, "vault");
  await mkdir(vault);
  const adapter = await codingAdapter(config, async (command, args, options) => {
    if (args.includes("--version")) return { code: 0, output: "synthetic" };
    if (args.includes("--prompt")) {
      await writeFile(join(options.cwd, "add.mjs"), "export const add = (a, b) => a + b;\n");
      return { code: 0, output: "Fixed" };
    }
    return runProcess(command, args, options);
  });
  await withCoordinator(vault, async queue => {
    const { id } = await queue.enqueue(task);
    assert.equal((await queue.run({ coding: adapter }))[0].status, "done");
    const stored = JSON.parse(queue.artifact(queue.state.tasks[id].request).content);
    assert.ok(stored.sources.every(source => source.artifact && source.content === undefined));
    assert.equal(queue.state.tasks[id].snapshotArtifacts.length, 2);
  });
  await assert.rejects(codingAdapter({ ...config, allowExecution: false }), /approval/);
  await assert.rejects(codingAdapter({ ...config, files: ["../secret.mjs"] }), /safe/);
  await assert.rejects(codingAdapter({ ...config, maxRounds: 99 }), /1-3/);
}));

test("conflicting originals and modified validation files block automatic writes", async () => fixture(async (root, config) => {
  const { id, definition } = await taskDefinition(task);
  const adapter = await codingAdapter(config, async (command, args, options) => {
    if (args.includes("--prompt")) {
      await writeFile(join(options.cwd, "add.mjs"), "export const add = (a, b) => a + b;\n");
      await writeFile(join(root, "add.mjs"), "export const add = () => 999;\n");
      return { code: 0, output: "Fixed copy" };
    }
    return runProcess(command, args, options);
  });
  const request = await adapter.prepare({ id, definition, artifacts: [] });
  await assert.rejects(adapter.advance(request), /Original source changed/);
  assert.match(await readFile(join(root, "add.mjs"), "utf8"), /999/);
  await assert.rejects(adapter.advance(request), /Original source changed/);
}));

test("immutable tests and interrupted ledger are not bypassed by retries", async () => fixture(async (root, config) => {
  const { id, definition } = await taskDefinition(task);
  const adapter = await codingAdapter(config, async (command, args, options) => {
    if (args.includes("--prompt")) {
      await writeFile(join(options.cwd, "check.test.mjs"), "// tests disabled");
      return { code: 0, output: "Claims success" };
    }
    throw new Error("Validation must not execute changed tests");
  });
  const request = await adapter.prepare({ id, definition, artifacts: [] });
  await assert.rejects(adapter.advance(request), /immutable validation/);
  const ledgerPath = join(root, ".wrangler", "vault-coding", id, "ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  ledger.status = "agent-running";
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await assert.rejects(adapter.advance(request), /operator review/);
  assert.match(await readFile(join(root, "add.mjs"), "utf8"), /a - b/);
}));

test("unexpected files and context changes are rejected before validation", async () => {
  for (const changed of ["unapproved.js", "context-0.txt"]) {
    await fixture(async (root, config) => {
      const adapter = await codingAdapter(config, async (command, args, options) => {
        if (args.includes("--prompt")) {
          await writeFile(join(options.cwd, changed), "Unexpected content");
          return { code: 0, output: "Claims success" };
        }
        throw new Error("Validation must not execute unexpected inputs");
      });
      const { id, definition } = await taskDefinition(task);
      const request = await adapter.prepare({ id, definition, artifacts: [] });
      await assert.rejects(adapter.advance(request), /unapproved file|immutable task context/);
    });
  }
});

test("failed repairs stop at the budget without applying broken code", async () => fixture(async (root, config) => {
  let rounds = 0;
  const adapter = await codingAdapter({ ...config, maxRounds: 2 }, async (command, args, options) => {
    if (args.includes("--prompt")) { rounds++; return { code: 0, output: "No fix" }; }
    return runProcess(command, args, options);
  });
  const { id, definition } = await taskDefinition(task);
  const request = await adapter.prepare({ id, definition, artifacts: [] });
  await assert.rejects(adapter.advance(request), /exhausted 2 rounds/);
  await assert.rejects(adapter.advance(request), /exhausted 2 rounds/);
  assert.equal(rounds, 2);
  assert.match(await readFile(join(root, "add.mjs"), "utf8"), /a - b/);
}));
