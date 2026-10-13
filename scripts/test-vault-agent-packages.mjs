import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolPackage, PACKAGE_LIMITS } from "../tools/vault-agent/tool-package.mjs";
import { withMailbox, Mailbox } from "../tools/vault-agent/mailbox.mjs";
import { mailboxServer } from "../tools/vault-agent/mailbox-server.mjs";
import { createTools, execute } from "../tools/vault-agent/runtime.mjs";
import { withCoordinator } from "../tools/vault-agent/coordinator.mjs";
import { codingAdapter, runProcess } from "../tools/vault-agent/coding-adapter.mjs";

const runFile = promisify(execFile);
const pack = (overrides = {}) => ({
  version: 1, name: "synthetic-add", description: "Synthetic addition utility with reviewable usage.",
  capabilities: ["code.add"],
  files: [{ path: "add.mjs", content: "export const add = (a, b) => a + b;\n" },
    { path: "SKILL.md", content: '---\nname: synthetic-add\ndescription: "Use for approved synthetic addition tasks."\n---\n# Addition\nReview and test add.mjs before executing it. No network access is required.\n' }],
  ...overrides,
});
async function temporary(action) {
  const root = await mkdtemp(join(tmpdir(), "rabbit-package-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("tool-package protocol preserves source/skills, exact byte limits and safe fields", async () => {
  const first = await toolPackage(pack());
  assert.equal((await toolPackage(pack({ files: [...pack().files].reverse() }))).id, first.id);
  await assert.rejects(toolPackage(pack({ files: [{ path: "../tool.mjs", content: "source" }] })), /safe/);
  await assert.rejects(toolPackage(pack({ validation: { passed: true } })), /exact/);
  await assert.rejects(toolPackage(pack({ version: 2 })), /version 1/);
  const languages = await toolPackage(pack({ files: [{ path: "VaultMailbox.java", content: "public class VaultMailbox {}" }, { path: "client.mts", content: "export const version: number = 1;" }] }));
  assert.equal(languages.definition.files.length, 2);
  await assert.rejects(toolPackage(pack({ files: [{ path: "client.jar", content: "not source" }] })), /safe/);
  await assert.rejects(toolPackage(pack({ capabilities: ["not namespaced"] })), /namespaced/);
  await assert.rejects(toolPackage(pack({ files: [{ path: "add.mjs", content: "source" }, { path: "ADD.mjs", content: "source" }] })), /unique/);
  const base = pack({ files: [{ path: "large.mjs", content: "x" }] });
  const overhead = Buffer.byteLength((await toolPackage(base)).content) - 1;
  assert.equal(Buffer.byteLength((await toolPackage({ ...base, files: [{ path: "large.mjs", content: "x".repeat(32768 - overhead) }] })).content), 32768);
  await assert.rejects(toolPackage({ ...base, files: [{ path: "large.mjs", content: "x".repeat(32769 - overhead) }] }), /32 KiB/);
});

test("large advertisements respect the exact gossip byte ceiling and resume without missing packages", async () => {
  const mailbox = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
  const capabilities = Array.from({ length: 8 }, (_, index) => `code.${"x".repeat(90)}${index}`);
  for (let index = 0; index < 20; index++) await mailbox.retainPackage(pack({ name: `large-${index}`, capabilities }), "test-agent");
  let cursor = 0;
  const seen = new Set();
  do {
    const page = mailbox.gossip(cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= PACKAGE_LIMITS.gossipBytes);
    assert.ok(page.packages.length > 0 && page.packages.length < 16);
    for (const item of page.packages) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
    cursor = page.cursor;
  } while (mailbox.gossip(cursor).remaining || mailbox.gossip(cursor).packages.length);
  assert.equal(seen.size, 20);
});

test("package CLI writes, fetches and reviews the same immutable hash across separate processes", async () => temporary(async vault => {
  const entrypoint = join(process.cwd(), "scripts", "vault-agent-network.mjs");
  const run = async (...args) => JSON.parse((await runFile(process.execPath, [entrypoint, "--vault", vault, ...args])).stdout);
  const input = join(vault, "package.json");
  await writeFile(input, JSON.stringify(pack()));
  const retained = await run("--package", input);
  const gossip = await run("--gossip", "0");
  assert.equal(gossip.packages[0].id, retained.id);
  assert.deepEqual((await run("--fetch-package", retained.id)).package.files, retained.package.files);
  const approval = join(vault, "review.json");
  await writeFile(approval, JSON.stringify({ id: retained.id, reviewer: "human-review" }));
  assert.equal((await run("--approve-package", approval)).executable, false);
  assert.equal((await run("--gossip", String(gossip.cursor))).packages[0].review, "approved");
}));

test("invalid provenance and duplicate catalog revisions preserve the committed mailbox", async () => temporary(async vault => {
  await withMailbox(vault, async mailbox => {
    await assert.rejects(mailbox.retainPackage(pack(), "test-agent", { passed: true }), /provenance/);
    assert.equal(mailbox.list().storage.packages, 0);
    await mailbox.retainPackage(pack(), "test-agent");
    await mailbox.retainPackage(pack({ name: "second-utility" }), "test-agent");
  });
  const path = join(vault, "Cloud Agents", "Network", "mailbox.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  Object.values(state.packages)[1].revision = Object.values(state.packages)[0].revision;
  const corrupted = JSON.stringify(state);
  await writeFile(path, corrupted);
  await assert.rejects(withMailbox(vault, mailbox => mailbox.gossip(0)), /record/);
  assert.equal(await readFile(path, "utf8"), corrupted);
}));

test("package persistence, compact gossip cursors, review and message pruning preserve skill/code", async () => temporary(async vault => {
  let id;
  await withMailbox(vault, async mailbox => {
    id = (await mailbox.retainPackage(pack(), "test-agent")).id;
    assert.equal((await mailbox.retainPackage(pack(), "test-agent")).revision, 1);
    assert.equal(mailbox.gossip(0).packages[0].validation, "unvalidated");
    assert.ok(!JSON.stringify(mailbox.gossip(0)).includes("export const"));
    assert.ok(Buffer.byteLength(JSON.stringify(mailbox.gossip(0))) < 1024);
    await mailbox.approvePackage({ id, reviewer: "human-review" });
    assert.equal(mailbox.gossip(1).packages[0].review, "approved");
    assert.equal(mailbox.readPackage(id).executable, false);
    assert.deepEqual(mailbox.gossip(2).packages, []);
    const sent = await mailbox.send({ version: 1, sender: "test-agent", recipient: "test-peer", key: "test", kind: "handoff", route: "local", share: false, content: "Synthetic notification" });
    const msg = mailbox.read("test-peer", sent.id);
    await mailbox.acknowledge({ recipient: "test-peer", id: sent.id, artifact: msg.artifact });
    await mailbox.prune([sent.id]);
  });
  await withMailbox(vault, mailbox => {
    assert.match(mailbox.readPackage(id).package.files.find(file => file.path === "SKILL.md").content, /description:/);
    assert.equal(mailbox.readPackage(id).review, "approved");
  });
  const guide = await readFile(join(vault, "Cloud Agents", "Network", "Packages", `${id}.md`), "utf8");
  assert.match(guide, /cloud-agent-share: false/);
  assert.match(guide, /not installed/);
}));

test("gossip is bounded to 16 changes and package capacity refuses deletion", async () => {
  const mailbox = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
  for (let index = 0; index < PACKAGE_LIMITS.packages; index++) await mailbox.retainPackage(pack({ name: `utility-${index}` }), "test-agent");
  const first = mailbox.gossip(0);
  assert.equal(first.packages.length, 16);
  assert.equal(first.remaining, 48);
  assert.equal(mailbox.gossip(first.cursor).packages[0].revision, 17);
  assert.throws(() => mailbox.gossip(65), /cursor/);
  await assert.rejects(mailbox.retainPackage(pack({ name: "overflow" }), "test-agent"), /full/);
  assert.equal(mailbox.readPackage(first.packages[0].id).package.name, "utility-0");
});

test("AI tool loop can develop and retain a tool and skill but cannot authorize its execution", async () => temporary(async vault => {
  const actions = [{ action: "tool", name: "stage_tool", arguments: pack() },
    { action: "tool", name: "package_catalog", arguments: { cursor: 0 } },
    { action: "answer", content: "Synthetic tool and usage skill retained for review; not executed." }];
  let calls = 0;
  const result = await execute(vault, "Develop a synthetic addition tool and retain its usage skill.", { type: "ollama", model: "qwen2.5:3b" },
    async (url, request) => {
      assert.ok(JSON.stringify(JSON.parse(request.body).format).includes("stage_tool"));
      return Response.json({ message: { content: JSON.stringify(actions[calls++]) } });
    });
  assert.equal(result.staged.length, 1);
  assert.match(result.staged[0], /Network\/Packages/);
  await assert.rejects(createTools(vault, true, "test").tools.package_catalog.execute({ cursor: 0 }), /private/);
  await withMailbox(vault, mailbox => {
    assert.equal(mailbox.gossip(0).packages.length, 1);
    assert.equal(mailbox.readPackage(mailbox.gossip(0).packages[0].id).review, "pending");
  });
}));

test("authenticated local gossip fetches packages on demand without installs, broadcast or approval endpoint", async () => temporary(async vault => {
  const token = "synthetic-mailbox-token-not-a-secret-32";
  const server = mailboxServer(vault, token);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(`${url}/gossip/0`)).status, 401);
    assert.equal((await fetch(`${url}/packages`, { method: "POST", headers, body: JSON.stringify(pack({ validation: { passed: true } })) })).status, 400);
    const retained = await (await fetch(`${url}/packages`, { method: "POST", headers, body: JSON.stringify(pack()) })).json();
    const gossip = await (await fetch(`${url}/gossip/0`, { headers })).json();
    assert.equal(gossip.packages[0].id, retained.id);
    assert.ok(!JSON.stringify(gossip).includes("export const"));
    const fetched = await (await fetch(`${url}/packages/${retained.id}`, { headers })).json();
    assert.equal(fetched.package.files.length, 2);
    assert.equal(fetched.executable, false);
    assert.equal((await fetch(`${url}/approve-package`, { method: "POST", headers, body: "{}" })).status, 404);
  } finally { await new Promise(accept => server.close(accept)); }
}));

test("approved local test runner develops code then task publisher retains scoped validation provenance", async () => temporary(async root => {
  const vault = join(root, "vault"); await mkdir(vault);
  await writeFile(join(root, "cli.mjs"), "// Mock code generator");
  await writeFile(join(root, "tool.mjs"), "export const add = (a, b) => a - b;\n");
  await writeFile(join(root, "test.mjs"), "import {add} from './tool.mjs'; import assert from 'node:assert/strict'; assert.equal(add(2,3),5);\n");
  const adapter = await codingAdapter({
    projectRoot: root, cliPath: join(root, "cli.mjs"), allowExecution: true, allowRemote: true,
    files: ["tool.mjs"], tests: ["test.mjs"], apply: false,
  }, async (command, args, options) => {
    if (args.includes("--version")) return { code: 0, output: "Mock generator" };
    if (args.includes("--prompt")) { await writeFile(join(options.cwd, "tool.mjs"), "export const add = (a, b) => a + b;\n"); return { code: 0, output: "Developed" }; }
    return runProcess(command, args, options);
  });
  await withCoordinator(vault, async queue => {
    await queue.enqueue({ version: 1, capability: "code.repair", instruction: "Develop tested addition utility", adapters: ["coding"], share: true });
    assert.equal((await queue.run({ coding: adapter }))[0].status, "done");
  });
  const publish = () => runFile(process.execPath, [join(process.cwd(), "scripts", "vault-agent-tasks.mjs"), "--vault", vault, "--publish", "test-agent"]);
  await publish(); await publish();
  await withMailbox(vault, mailbox => {
    const catalog = mailbox.gossip(0);
    assert.equal(catalog.packages.length, 1);
    assert.equal(catalog.packages[0].validation, "scoped-tests-passed");
    const retained = mailbox.readPackage(catalog.packages[0].id);
    assert.equal(retained.review, "pending");
    assert.match(retained.package.files[0].content, /a \+ b/);
    assert.equal(retained.validation.tests[0].path, "test.mjs");
    assert.equal(retained.executable, false);
  });
  assert.match(await readFile(join(root, "tool.mjs"), "utf8"), /a - b/);
  let original;
  await withCoordinator(vault, async queue => {
    const record = Object.values(queue.state.tasks)[0];
    original = JSON.parse(queue.artifact(record.output).content);
    const invalid = structuredClone(original);
    invalid.validation.tests[0].hash = "a".repeat(64);
    record.output = await queue.put(JSON.stringify(invalid), false);
    await queue.save();
  });
  await assert.rejects(publish(), /matching scoped validation/);
  await withCoordinator(vault, async queue => {
    const record = Object.values(queue.state.tasks)[0];
    record.output = await queue.put(JSON.stringify({ ...original, changes: [], changed: [] }), false);
    await queue.save();
  });
  await publish();
  await withMailbox(vault, mailbox => {
    assert.equal(mailbox.gossip(0).packages.length, 1);
    assert.equal(mailbox.receive("test-agent").messages.length, 2);
  });
}));
