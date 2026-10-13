import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, parseEnv } from "node:util";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { runAgent, actionSchema } from "../tools/vault-agent/engine.mjs";
import { execute, createTools, generator, approveLearning } from "../tools/vault-agent/runtime.mjs";

const runFile = promisify(execFile);
const publicNote = "---\ncloud-agent-share: true\n---\n# Blockchain\nUse source hashes to track provenance, not as proof that a claim is correct.\n";

test("agent rejects unavailable tools, malformed actions and turn exhaustion explicitly", async () => {
  assert.equal(actionSchema([]).properties.action.const, "answer");
  assert.ok(!JSON.stringify(actionSchema([])).includes('"enum":[]'));
  await assert.rejects(runAgent("", {}, () => "{}"), /task/);
  await assert.rejects(runAgent("Run", {}, () => '{"action":"tool","name":"shell","arguments":{}}'), /unavailable/);
  await assert.rejects(runAgent("Run", {}, () => "Not JSON"), /three times/);
  const replies = ['{"action":"answer","content":"cut o', '{"action":"answer","content":"Short."}'];
  const seen = [];
  assert.equal((await runAgent("Run", {}, messages => { seen.push(messages.at(-1).content); return replies.shift(); })).answer, "Short.");
  assert.match(seen[1], /cut off/);
  await assert.rejects(runAgent("Run", { noop: { description: "No op", execute: () => ({ ok: true }) } }, () => '{"action":"tool","name":"noop","arguments":{}}', { maxTurns: 1 }), /execution budget/);
});

test("local and hosted adapters never silently switch providers", async () => {
  await assert.rejects(generator({ type: "google-cloud", model: "x" }), /explicit/);
  await assert.rejects(generator({ type: "openai-compatible", model: "x", url: "https://example.com/chat" }), /allowRemote/);
  await assert.rejects(generator({ type: "ollama", model: "x", baseUrl: "https://example.com" }), /loopback/);
  const seen = [];
  const ask = await generator({ type: "openai-compatible", allowRemote: true, model: "configured-model", url: "https://example.com/chat", token: "test-only" }, async (url, request) => {
    seen.push({ url, request });
    return Response.json({ choices: [{ message: { content: '{"action":"answer","content":"Hello"}' } }] });
  });
  assert.match(await ask([{ role: "user", content: "Public synthetic task" }]), /Hello/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].request.headers.Authorization, "Bearer test-only");
  assert.equal(seen[0].request.redirect, "error");
});

test("host-required exact calls reject premature answers without silently executing a tool", async () => {
    let count = 0, turn = 0;
    const tools = { read: { description: "Synthetic read", execute: args => { count++; return args; } } };
    const requiredCalls = [{ name: "read", arguments: { path: "Tools/Exact.md", detail: { a: 1, b: 2 } } }];
    const actions = [
      { action: "answer", content: "I read it (unsupported)." },
      { action: "tool", name: "read", arguments: { detail: { b: 2, a: 1 }, path: "Tools/Exact.md" } },
      { action: "answer", content: "Read completed." },
    ];
    const result = await runAgent("Read exact evidence", tools, messages => {
      if (turn === 1) assert.match(messages.at(-1).content, /Answer not accepted/);
      return JSON.stringify(actions[turn++]);
    }, { requiredCalls, maxTurns: 3 });
    assert.equal(count, 1);
    assert.equal(result.trace[0].origin, "model");
    assert.equal(result.trace[0].status, "succeeded");
    assert.equal(requiredCalls.length, 1);
    await assert.rejects(runAgent("Read", tools, () => JSON.stringify(actions[0]),
      { requiredCalls, maxTurns: 2 }), /execution budget/);
    assert.equal(count, 1);
    await assert.rejects(runAgent("Read", tools, () => JSON.stringify(actions[2]),
      { requiredCalls: [{ name: "shell", arguments: {} }] }), /Required calls/);
  });

  test("CPU-local inference has a bounded ten-minute wait while hosted inference stays at three minutes", async t => {
    const deadlines = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", milliseconds => {
      deadlines.push(milliseconds);
      return timeout(milliseconds);
    });
    const local = await generator({ type: "ollama", model: "public-synthetic" }, async () =>
      Response.json({ message: { content: '{"action":"answer","content":"local"}' } }));
    const hosted = await generator({
      type: "openai-compatible", allowRemote: true, model: "public-synthetic",
      url: "https://example.com/chat", token: "test-only",
    }, async () => Response.json({ choices: [{ message: { content: '{"action":"answer","content":"hosted"}' } }] }));
    await local([]);
    await hosted([]);
    assert.deepEqual(deadlines, [600000, 180000]);
  });

test("run reports retain completed and failed calls without prompts, arguments or provider tokens", async () => {
    const vault = await mkdtemp(join(tmpdir(), "rabbit-run-report-"));
    try {
      const prompt = "Public synthetic report marker";
      const failedTransport = async () => { throw new TypeError("synthetic credential-bearing diagnostic"); };
      await assert.rejects(execute(vault, prompt, { type: "ollama", model: "test-model" }, failedTransport), /diagnostic/);
      const directory = join(vault, "Cloud Agents", "Results");
      const failurePath = (await readdir(directory)).find(path => path.startsWith("run-"));
      const failure = JSON.parse(await readFile(join(directory, failurePath), "utf8"));
      assert.equal(failure.status, "failed");
      assert.equal(failure.errorType, "TypeError");
      assert.equal(failure.calls[0].origin, "host");
      assert.equal(failure.calls[0].status, "succeeded");
      assert.equal(failure.correctness, "unverified");
      assert.ok(!JSON.stringify(failure).includes(prompt));
      assert.ok(!JSON.stringify(failure).includes("credential-bearing"));
      const result = await execute(vault, "Public synthetic success", { type: "ollama", model: "test-model" },
        async () => Response.json({ message: { content: '{"action":"answer","content":"Public synthetic response"}' } }));
      const success = JSON.parse(await readFile(join(vault, ...result.report.split("/")), "utf8"));
      assert.equal(success.status, "completed");
      assert.equal(success.result, result.path);
      assert.equal(success.calls.every(call => call.origin === "host"), true);
      assert.equal(success.answerHash.length, 64);
      let index = 0;
      const events = [
        { action: "tool", name: "stage_learning", arguments: { title: "No source", content: "Must fail" } },
      ];
      await assert.rejects(execute(vault, "Public synthetic failed tool", { type: "ollama", model: "test-model" },
        async () => Response.json({ message: { content: JSON.stringify(events[index++]) } })), /source evidence/);
      const reports = await Promise.all((await readdir(directory)).filter(path => path.startsWith("run-"))
        .map(async path => JSON.parse(await readFile(join(directory, path), "utf8"))));
      assert.ok(reports.some(report => report.calls.some(call => call.name === "stage_learning"
        && call.origin === "model" && call.status === "failed")));
    } finally { await rm(vault, { recursive: true, force: true }); }
  });

  test("status-only local reports require a model call without loading vault context or exposing other actions", async () => {
    const vault = await mkdtemp(join(tmpdir(), "rabbit-status-only-"));
    const previous = process.env.RABBIT_STATUS_TEST_TOKEN;
    process.env.RABBIT_STATUS_TEST_TOKEN = "public-synthetic-status".padEnd(40, "x");
    try {
      let turns = 0, statusCalls = 0;
      const actions = [
        { action: "answer", content: "Unsupported claim." },
        { action: "tool", name: "cloud_access", arguments: { action: "status", input: {} } },
        { action: "answer", content: "Actual status: not approved." },
      ];
      const result = await execute(vault, "Check current status only.", {
        type: "ollama", model: "public-synthetic", cloudStatusOnly: true,
        cloudAccess: { allowRemote: true, actions: ["request", "status"], appUrl: "https://console.example", tokenEnv: "RABBIT_STATUS_TEST_TOKEN" },
      }, async (url, request) => {
        if (url.endsWith("/api/chat")) {
          const body = JSON.parse(request.body);
          assert.deepEqual(body.format.oneOf[1].properties.name.enum, ["cloud_access"]);
          assert.ok(body.messages[0].content.includes('only [\\"status\\"]'));
          return Response.json({ message: { content: JSON.stringify(actions[turns++]) } });
        }
        assert.equal(url, "https://console.example/api/cloud-agent/access/status");
        statusCalls++;
        return Response.json({ approved: false, scopes: [], expiresAt: null, requestId: null });
      });
      assert.equal(turns, 3);
      assert.equal(statusCalls, 1);
      assert.deepEqual(result.staged, []);
      const report = JSON.parse(await readFile(join(vault, result.report), "utf8"));
      assert.deepEqual(report.sources, []);
      assert.equal(report.calls.length, 1);
      assert.equal(report.calls[0].origin, "model");
      assert.equal(report.calls[0].status, "succeeded");
    } finally {
      if (previous === undefined) delete process.env.RABBIT_STATUS_TEST_TOKEN;
      else process.env.RABBIT_STATUS_TEST_TOKEN = previous;
      await rm(vault, { recursive: true, force: true });
    }
  });
test("local tool loop persists proposals and cited learning; hosted search filters unshared notes", async () => {
  const vault = await mkdtemp(join(tmpdir(), "rabbit-local-agent-"));
  try {
    await mkdir(join(vault, "Agents"));
    await writeFile(join(vault, "Agents", "Blockchain.md"), publicNote);
    await writeFile(join(vault, "Agents", "Private.md"), "# Blockchain\nUnshared synthetic private note.");
    const local = createTools(vault, false, crypto.randomUUID());
    assert.equal((await local.tools.search.execute({ query: "blockchain" })).matches.length, 2);
    const hosted = createTools(vault, true, crypto.randomUUID());
    const results = await hosted.tools.search.execute({ query: "blockchain" });
    assert.equal(results.matches.length, 1);
    assert.ok(!JSON.stringify(results).includes("Private.md"));
    await assert.rejects(hosted.tools.read.execute({ path: "Agents/Private.md" }), /share/);
    await assert.rejects(local.tools.read.execute({ path: "Code/private.md" }), /registered/);
    await mkdir(join(vault, "Cloud Agents"));
    await writeFile(join(vault, "Cloud Agents", "Vault Agent Service.md"), "# Service guide\nLocal-only capabilities.");
    assert.match((await local.tools.read.execute({ path: "Cloud Agents/Vault Agent Service.md" })).content, /Local-only/);
    await assert.rejects(hosted.tools.read.execute({ path: "Cloud Agents/Vault Agent Service.md" }), /share/);
    await assert.rejects(createTools(vault, false, crypto.randomUUID()).tools.stage_learning.execute({ title: "Claim", content: "No evidence" }), /source evidence/);
    const actions = [
      { action: "tool", name: "resources", arguments: {} },
      { action: "tool", name: "search", arguments: { query: "blockchain" } },
      { action: "tool", name: "read", arguments: { path: "Agents/Blockchain.md" } },
      { action: "tool", name: "stage_learning", arguments: { title: "Provenance", content: "Source hashes track provenance, not factual truth. Source: Agents/Blockchain.md." } },
      { action: "tool", name: "stage_proposal", arguments: { title: "Code proposal", content: "```js\nconst sourceHash = 'example';\n```" } },
      { action: "answer", content: "Read Agents/Blockchain.md; staged cited learning and code for review." },
    ];
    let index = 0;
    const result = await execute(vault, "Research provenance and propose code.", { type: "ollama", model: "qwen2.5:3b" }, async (url, request) => {
      assert.equal(url, "http://127.0.0.1:11434/api/chat");
      assert.equal(JSON.parse(request.body).model, "qwen2.5:3b");
      assert.equal(JSON.parse(request.body).options.num_predict, 1500);
      assert.equal(JSON.parse(request.body).options.num_ctx, 8192);
      return Response.json({ message: { content: JSON.stringify(actions[index++]) } });
    });
    assert.ok(result.trace.length >= 7);
    assert.deepEqual(result.trace.slice(0, 2).map(call => call.name), ["resources", "search"]);
    assert.equal(result.staged.length, 2);
    assert.match(await readFile(join(vault, ...result.staged[0].replace(".json", ".md").split("/")), "utf8"), /staged only, not applied/);
    assert.match(await readFile(join(vault, ...result.path.split("/")), "utf8"), /cloud-agent-share: false/);
    const learned = await approveLearning(vault, result.staged[0]);
    assert.match(await readFile(join(vault, ...learned.split("/")), "utf8"), /Sources/);
    await assert.rejects(approveLearning(vault, result.staged[1]), /Only cited learning/);
    assert.equal(await readFile(join(vault, "Agents", "Blockchain.md"), "utf8"), publicNote);
    await writeFile(join(vault, "Agents", "Blockchain.md"), publicNote + "Changed source.\n");
    await assert.rejects(approveLearning(vault, result.staged[0]), /source changed/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("knowledge scope limit includes the service guides", async () => {
  const vault = await mkdtemp(join(tmpdir(), "rabbit-agent-scope-"));
  try {
    await mkdir(join(vault, "Agents"));
    await mkdir(join(vault, "Cloud Agents"));
    for (let offset = 0; offset < 1999; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 1999 - offset) }, (_, index) =>
        writeFile(join(vault, "Agents", `Note-${offset + index}.md`), "# Synthetic scope note")));
    }
    await writeFile(join(vault, "Cloud Agents", "Cloud Agents.md"), "# Synthetic scope guide");
    const local = createTools(vault, false, crypto.randomUUID());
    assert.equal((await local.tools.search.execute({ query: "synthetic" })).matches.length, 8);
    await writeFile(join(vault, "Cloud Agents", "Vault Agent Service.md"), "# Synthetic scope guide");
    await assert.rejects(local.tools.search.execute({ query: "synthetic" }), /exceeds 2000 notes/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("dispatcher and language guides are readable locally without indexing private dispatch state", async () => {
  const vault = await mkdtemp(join(tmpdir(), "rabbit-dispatch-guides-"));
  try {
    await mkdir(join(vault, "Cloud Agents", "Dispatchers", "agent"), { recursive: true });
    await writeFile(join(vault, "Cloud Agents", "Agent Dispatcher.md"), "# Agent Dispatcher\nInspect and approve agent requests.");
    await writeFile(join(vault, "Cloud Agents", "TypeScript and Java Task Mailbox.md"), "# Task mailbox\nDurable receipts.");
    await writeFile(join(vault, "Cloud Agents", "Dispatchers", "agent", "state.md"), "# Private dispatcher snapshot");
    const context = createTools(vault, false, "test-guides");
    assert.match((await context.tools.read.execute({ path: "Cloud Agents/Agent Dispatcher.md" })).content, /approve/);
    assert.match((await context.tools.read.execute({ path: "Cloud Agents/TypeScript and Java Task Mailbox.md" })).content, /Durable/);
    const found = await context.tools.search.execute({ query: "dispatcher" });
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].path, "Cloud Agents/Agent Dispatcher.md");
    await assert.rejects(context.tools.read.execute({ path: "Cloud Agents/Dispatchers/agent/state.md" }), /registered/);
    await assert.rejects(createTools(vault, true, "hosted").tools.read.execute({ path: "Cloud Agents/Agent Dispatcher.md" }), /cloud-agent-share/);
  } finally { await rm(vault, { recursive: true, force: true }); }
});

test("CLI runs correctly through the vault's Code junction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rabbit-agent-junction-"));
  try {
    await mkdir(join(directory, "Agents"));
    await writeFile(join(directory, "Agents", "Blockchain.md"), publicNote);
    const link = join(directory, "source");
    await symlink(process.cwd(), link, "junction");
    const { stdout } = await runFile(process.execPath, [join(link, "scripts", "vault-agent.mjs"), "--vault", directory, "--search", "blockchain"]);
    assert.equal(JSON.parse(stdout).matches[0].path, "Agents/Blockchain.md");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native plugin uses fixed entrypoints, stdin tasks, explicit provider selection and saved results", async () => {
  const opened = [];
  const spawned = [];
  let settings = null;
  class Plugin {
    constructor(app) { this.app = app; this.commands = []; }
    addCommand(command) { this.commands.push(command); }
    async loadData() { return settings; }
  }
  const module = { exports: {} };
  const context = {
    module, process, Promise, Set, Error, JSON, Buffer, TextDecoder,
    require(name) {
      if (name === "obsidian") return { Plugin, Modal: class {}, Notice: class {} };
      if (name === "node:path") return { join };
      if (name === "node:fs/promises") return { open };
      if (name === "node:util") return { parseEnv };
      if (name === "node:child_process") return { spawn(command, args, options) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.kill = () => {};
        child.stdin.end = input => {
          spawned.push({ command, args, options, input });
          queueMicrotask(() => {
            const output = args.some(value => value.endsWith("data.json"))
              ? 'Submitted job synthetic.\n{"submitted":true,"task":"Cloud Agents/Inbox/synthetic.md"}\n'
              : '{"result":"Cloud Agents/Results/local-synthetic.md","staged":[],"toolCalls":1}';
            child.stdout.emit("data", Buffer.from(output));
            child.emit("close", 0);
          });
        };
        return child;
      } };
      throw new Error(`Unexpected module: ${name}`);
    },
  };
  vm.runInNewContext(await readFile("tools/vault-agent/plugin.js", "utf8"), context);
  const plugin = new module.exports({
    vault: { adapter: { getBasePath: () => "C:\\synthetic-vault" } },
    workspace: { async openLinkText(path) { opened.push(path); } },
  });
  await plugin.onload();
  assert.equal(plugin.commands.length, 4);
  await plugin.run(["--task", "Synthetic task not visible in arguments."]);
  assert.equal(spawned[0].command, "node");
  assert.equal(spawned[0].options.shell, false);
  assert.ok(spawned[0].args.includes("@stdin"));
  assert.ok(!spawned[0].args.includes("Synthetic task not visible in arguments."));
  assert.equal(spawned[0].input, "Synthetic task not visible in arguments.");
  assert.equal(opened[0], "Cloud Agents/Results/local-synthetic.md");
  await plugin.run(["--task", "Explicit remote task."], false, true);
  assert.ok(spawned[1].args.includes("--config"));
  assert.equal(opened.length, 1);
  const folder = await mkdtemp(join(tmpdir(), "rabbit-native-access-"));
  try {
    const credentials = join(folder, "credentials.env");
    const caller = "public-synthetic-caller".padEnd(40, "x");
    await writeFile(credentials, `CLOUD_TOOLS_AGENT_TOKEN=${caller}\nRABBIT_CLOUDSHELL_TOKEN=must-not-transfer\nRABBIT_AGENT_APPROVAL_TOKEN=must-not-transfer\n`);
    settings = { localProviderConfig: join(folder, "local-provider.json"), localCallerCredentials: credentials };
    await plugin.run(["--task", "Check exact access status."]);
    assert.ok(spawned[2].args.includes(settings.localProviderConfig));
    assert.equal(spawned[2].options.env.CLOUD_TOOLS_AGENT_TOKEN, caller);
    assert.equal(spawned[2].options.env.RABBIT_CLOUDSHELL_TOKEN, undefined);
    assert.equal(spawned[2].options.env.RABBIT_AGENT_APPROVAL_TOKEN, undefined);
    assert.equal(opened[1], "Cloud Agents/Results/local-synthetic.md");
    await plugin.commands.find(command => command.id === "report-cloud-access").callback();
    assert.ok(spawned[3].args.includes("--require-cloud-status"));
    assert.ok(spawned[3].args.includes("true"));
    await writeFile(credentials, "CLOUD_TOOLS_AGENT_TOKEN=short\n");
    await assert.rejects(plugin.run(["--task", "Rejected configuration."]), /valid dedicated caller/);
    assert.equal(spawned.length, 4);
  } finally { await rm(folder, { recursive: true, force: true }); }
  plugin.onunload();
});

test("required native cloud status cannot enable missing tools or accept an invalid selector", async () => {
  await assert.rejects(runFile(process.execPath, ["scripts/vault-agent.mjs", "--vault", "C:\\synthetic-vault",
    "--task", "Check status", "--require-cloud-status", "true"]), error => /explicitly enabled local caller tools/.test(error.stderr));
  await assert.rejects(runFile(process.execPath, ["scripts/vault-agent.mjs", "--vault", "C:\\synthetic-vault",
    "--task", "Check status", "--require-cloud-status", "false"]), error => /only valid for a local task/.test(error.stderr));
});
