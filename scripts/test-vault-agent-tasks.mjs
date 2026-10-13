import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { withCoordinator, Coordinator } from "../tools/vault-agent/coordinator.mjs";
import { buildAdapters } from "../tools/vault-agent/task-adapters.mjs";
import { taskDefinition, capabilities, LIMITS } from "../tools/vault-agent/task-protocol.mjs";
import { digest } from "../workers/vault-agent/src/protocol.mjs";

const runFile = promisify(execFile);
const definition = (overrides = {}) => ({
  version: 1, capability: "text.transform", instruction: "Explain syntax using public synthetic text.",
  adapters: ["local"], dependsOn: [], notes: [], share: false, ...overrides,
});
const manifest = { versions: [1], capabilities: ["text.transform"], idempotentTasks: true, peers: [] };
function adapter(advance = async () => ({ content: "Synthetic result" })) {
  return { remote: false, identity: "test-local-v1", discover: async () => manifest,
    prepare: async ({ id, definition: task, inputs }) => ({ id, task, inputs }), advance };
}
async function temporary(action) {
  const vault = await mkdtemp(join(tmpdir(), "rabbit-task-coordination-"));
  try { return await action(vault); } finally { await rm(vault, { recursive: true, force: true }); }
}

test("portable definitions reject unknown versions, invalid consent and dependency shapes", async () => {
  await assert.rejects(taskDefinition(definition({ version: 2 })), /version/);
  await assert.rejects(taskDefinition(definition({ share: "true" })), /boolean/);
  await assert.rejects(taskDefinition(definition({ dependsOn: ["missing"] })), /SHA-256/);
  await assert.rejects(taskDefinition(definition({ adapters: ["local", "local"] })), /Duplicate/);
  await assert.rejects(taskDefinition(definition({ command: "ignored command" })), /Unknown task field/);
  assert.equal((await taskDefinition(definition({ capability: "network.discover" }))).definition.capability, "network.discover");
  assert.throws(() => capabilities({ ...manifest, versions: [2] }), /version 1/);
  assert.throws(() => capabilities({ ...manifest, idempotentTasks: false }), /idempotent/);
  assert.throws(() => capabilities({ ...manifest, peers: ["https://user:password@example.com"] }), /credential-free/);
  assert.equal((await taskDefinition(definition())).id, (await taskDefinition(definition())).id);
});

test("dependency links, immutable requests, deduplication and approved pruning survive restart", async () => temporary(async vault => {
  let first, second;
  await withCoordinator(vault, async queue => {
    first = (await queue.enqueue(definition())).id;
    assert.equal((await queue.enqueue(definition())).replay, true);
    second = (await queue.enqueue(definition({ instruction: "Build on the syntax result.", dependsOn: [first] }))).id;
    await assert.rejects(queue.enqueue(definition({ dependsOn: ["a".repeat(64)] })), /already/);
    let calls = 0;
    const local = adapter(async data => {
      calls++;
      assert.equal(data.inputs.length, calls - 1);
      if (calls === 2) assert.equal(data.inputs[0].artifact, queue.state.tasks[first].output);
      return { content: "Synthetic result" };
    });
    assert.deepEqual((await queue.run({ local })).map(task => task.status), ["done", "done"]);
    assert.equal(queue.state.tasks[first].output, queue.state.tasks[second].output);
    assert.equal(Object.keys(queue.state.artifacts).length, 3);
  });
  await withCoordinator(vault, async queue => {
    assert.equal(queue.list().tasks.length, 2);
    assert.deepEqual(await queue.run({ local: adapter(() => { throw new Error("Must not repeat completed work"); }) }), []);
    await assert.rejects(queue.prune([first]), /depends/);
    await queue.prune([first, second]);
    assert.equal(queue.list().storage.artifacts, 0);
  });
}));

test("offline retries retain input; pinned providers do not silently change; unknown peers are hints only", async () => temporary(async vault => {
  let id;
  const local = adapter(async () => { const error = new Error("Offline"); error.retryable = true; throw error; });
  await withCoordinator(vault, async queue => {
    id = (await queue.enqueue(definition())).id;
    assert.equal((await queue.run({ local }, 100))[0].status, "waiting");
    assert.equal(queue.state.tasks[id].attempts, 1);
    assert.deepEqual(await queue.run({ local }, 101), []);
  });
  await withCoordinator(vault, async queue => {
    const prepared = queue.state.tasks[id].request;
    local.prepare = () => { throw new Error("Snapshot must not be recaptured"); };
    local.advance = async () => ({ content: "Recovered offline task" });
    assert.equal((await queue.run({ local }, 10000))[0].status, "done");
    assert.equal(queue.state.tasks[id].request, prepared);
    const other = (await queue.enqueue(definition({ instruction: "Another task" }))).id;
    local.prepare = adapter().prepare;
    local.advance = async () => ({ pending: true });
    await queue.run({ local }, 20000);
    local.identity = "different-provider";
    assert.equal((await queue.run({ local }, 100000))[0].status, "blocked");
    assert.match(queue.state.tasks[other].error, /identity changed/);
    const discovered = await queue.discover({ peer: { discover: async () => ({ ...manifest, peers: ["https://unapproved.example"] }) } });
    assert.deepEqual(discovered[0].peers, ["https://unapproved.example"]);
  });
}));

test("private dependency data never leaves through a remote or shared downstream task", async () => temporary(async vault => {
  await withCoordinator(vault, async queue => {
    const first = (await queue.enqueue(definition())).id;
    await queue.run({ local: adapter() });
    const shared = (await queue.enqueue(definition({ instruction: "Export dependency", adapters: ["peer"], share: true, dependsOn: [first] }))).id;
    const peer = { ...adapter(() => { throw new Error("Must not upload"); }), remote: true };
    const unshared = (await queue.enqueue(definition({ instruction: "Keep private", adapters: ["peer"] }))).id;
    await queue.run({ peer });
    assert.equal(queue.state.tasks[shared].status, "blocked");
    assert.match(queue.state.tasks[shared].error, /private dependency/);
    assert.equal(queue.state.tasks[unshared].status, "waiting");
    assert.match(queue.state.tasks[unshared].error, /sharing not approved/);
    assert.equal(await queue.put("Synthetic result", true), queue.state.tasks[first].output);
    assert.equal(queue.artifact(queue.state.tasks[first].output).share, false);
  });
}));

test("exact artifact/task capacity, UTF-8 bytes, corrupt state, locks and failure ceilings are explicit", async () => temporary(async vault => {
  const queue = new Coordinator({ version: 1, tasks: {}, artifacts: {} }, async () => {});
  await queue.put("x".repeat(LIMITS.artifactBytes), false);
  await assert.rejects(queue.put("x".repeat(LIMITS.artifactBytes + 1), false), /65536/);
  await assert.rejects(queue.put("\u00e9".repeat(LIMITS.artifactBytes / 2 + 1), false), /65536/);
  for (let index = 1; index < LIMITS.artifacts; index++) await queue.put(`Artifact ${index}`, false);
  await assert.rejects(queue.put("One artifact too many", false), /full/);
  for (let index = 0; index < LIMITS.tasks; index++) await queue.enqueue(definition({ instruction: `Task ${index}` }));
  await assert.rejects(queue.enqueue(definition({ instruction: "One task too many" })), /full/);
  await withCoordinator(vault, async persisted => {
    const id = (await persisted.enqueue(definition())).id;
    await assert.rejects(withCoordinator(vault, () => {}), /locked/);
    const failing = adapter(async () => { const error = new Error("offline"); error.retryable = true; throw error; });
    for (let attempt = 0; attempt < 5; attempt++) await persisted.run({ local: failing }, attempt * 1000000);
    assert.equal(persisted.state.tasks[id].status, "failed");
    assert.equal(persisted.state.tasks[id].attempts, 5);
    await persisted.retry(id);
    assert.equal(persisted.state.tasks[id].attempts, 0);
  });
  const path = join(vault, "Cloud Agents", "Coordination", "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  Object.values(state.artifacts)[0].content = "Tampered snapshot";
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(withCoordinator(vault, () => {}), /integrity/);
}));

test("local CLI performs offline discovery/search without model or network and preserves linked artifacts", async () => temporary(async vault => {
  await mkdir(join(vault, "Agents"));
  await writeFile(join(vault, "Agents", "Syntax.md"), "# Syntax\nSynthetic syntax source.");
  const file = join(vault, "task.json");
  await writeFile(file, JSON.stringify(definition({ capability: "notes.search", instruction: "syntax" })));
  const cli = (...args) => runFile(process.execPath, [join(process.cwd(), "scripts", "vault-agent-tasks.mjs"), "--vault", vault, ...args]);
  assert.equal(JSON.parse((await cli("--discover")).stdout)[0].id, "local");
  const queued = JSON.parse((await cli("--enqueue", file)).stdout);
  const run = JSON.parse((await cli("--run")).stdout);
  assert.equal(run[0].status, "done");
  const result = JSON.parse((await cli("--artifact", run[0].output)).stdout);
  assert.equal(JSON.parse(result.content).matches[0].path, "Agents/Syntax.md");
  assert.equal(JSON.parse((await cli("--list")).stdout).tasks[0].id, queued.id);
  await cli("--prune", queued.id);
}));

test("8 MiB state boundary preserves the last durable state on overflow or unsupported version", async () => temporary(async vault => {
  await withCoordinator(vault, queue => queue.enqueue(definition()));
  const path = join(vault, "Cloud Agents", "Coordination", "state.json");
  const text = await readFile(path, "utf8");
  const exact = text + " ".repeat(LIMITS.stateBytes - Buffer.byteLength(text));
  await writeFile(path, exact);
  assert.equal(await withCoordinator(vault, queue => queue.list().tasks.length), 1);
  await writeFile(path, exact + " ");
  await assert.rejects(withCoordinator(vault, () => {}), /exceeds 8 MiB/);
  assert.equal((await readFile(path)).length, LIMITS.stateBytes + 1);
  const future = '{"version":2,"tasks":{},"artifacts":{}}';
  await writeFile(path, future);
  await assert.rejects(withCoordinator(vault, () => {}), /unsupported/);
  assert.equal(await readFile(path, "utf8"), future);
  await writeFile(path, text);
  await withCoordinator(vault, async queue => {
    for (let index = 0; index < 128; index++) await queue.put(`${index}:` + "x".repeat(65530), false);
    await assert.rejects(queue.save(), /storage is full/);
  });
  assert.equal(await readFile(path, "utf8"), text);
}));

test("serial execution is bounded to eight tasks and discovery is cached per pass", async () => temporary(async vault => {
  await withCoordinator(vault, async queue => {
    for (let index = 0; index < 9; index++) await queue.enqueue(definition({ instruction: `Bounded task ${index}` }));
    let discovery = 0;
    const local = adapter();
    local.discover = async () => { discovery++; return manifest; };
    assert.equal((await queue.run({ local })).length, 8);
    assert.equal(discovery, 1);
    assert.equal((await queue.run({ local })).length, 1);
    assert.equal(discovery, 2);
  });
}));

test("local AI uses frozen note/dependency evidence without storing duplicate dependency bodies", async () => temporary(async vault => {
  await mkdir(join(vault, "Agents"));
  const path = join(vault, "Agents", "Syntax.md");
  await writeFile(path, "# Syntax\nOriginal synthetic source.");
  let offline = true, generated = 0;
  const transport = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:11434/api/chat");
    if (offline) throw new TypeError("Synthetic local connection refused");
    generated++;
    const body = JSON.parse(options.body);
    assert.equal(body.format.properties.action.const, "answer");
    assert.ok(JSON.stringify(body.messages).includes("Original synthetic source"));
    assert.ok(!JSON.stringify(body.messages).includes("Changed synthetic source"));
    return Response.json({ message: { content: '{"action":"answer","content":"Syntax based on Agents/Syntax.md and the linked dependency."}' } });
  };
  const adapters = await buildAdapters(vault, undefined, transport);
  await withCoordinator(vault, async queue => {
    const source = (await queue.enqueue(definition({ capability: "notes.read", notes: ["Agents/Syntax.md"] }))).id;
    const next = (await queue.enqueue(definition({ instruction: "Explain frozen syntax evidence", notes: ["Agents/Syntax.md"], dependsOn: [source] }))).id;
    assert.deepEqual((await queue.run(adapters, 0)).map(task => task.status), ["done", "waiting"]);
    const request = queue.artifact(queue.state.tasks[next].request).content;
    assert.ok(!request.includes("Original synthetic source"));
    assert.match(request, new RegExp(queue.state.tasks[source].output));
    await writeFile(path, "# Syntax\nChanged synthetic source.");
    offline = false;
    assert.equal((await queue.run(adapters, 10000))[0].status, "done");
    assert.equal(generated, 1);
  });
}));

test("missing remote credentials do not disable local work; incompatible versions remain explicit", async () => temporary(async vault => {
  const config = { adapters: [
    { id: "local", type: "local" },
    { id: "peer", type: "agent-http", url: "https://authorized.example", tokenEnv: "RABBIT_TASK_MISSING_TEST_TOKEN", allowRemote: true },
  ] };
  const adapters = await buildAdapters(vault, config, () => { throw new Error("No request without credentials"); });
  await withCoordinator(vault, async queue => {
    const discovery = await queue.discover(adapters);
    assert.equal(discovery[0].id, "local");
    assert.equal(discovery[1].unavailable, true);
    assert.match(discovery[1].error, /credential environment/);
    const id = (await queue.enqueue(definition())).id;
    const oldPeer = { ...adapter(), discover: async () => ({ ...manifest, versions: [0] }) };
    assert.equal((await queue.run({ local: oldPeer }, 0))[0].status, "waiting");
    assert.match(queue.state.tasks[id].error, /version 1/);
    assert.equal((await queue.run({ local: adapter() }, 60001))[0].status, "done");
  });
}));

test("HTTP agent and cloud-shell adapters negotiate capabilities, preserve task IDs and block redirects", async () => temporary(async vault => {
  process.env.RABBIT_TASK_TEST_TOKEN = "synthetic-test-token-not-a-secret-32";
  try {
    for (const type of ["agent-http", "cloud-shell-http"]) {
      let prepared;
      const calls = [];
      const transport = async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, "error");
        if (url.endsWith("/capabilities")) return Response.json({ ...manifest, capabilities: ["shell.job"], peers: ["https://unapproved.example"] });
        if (options.method === "POST") {
          prepared = JSON.parse(options.body);
          return Response.json({ version: 1, id: prepared.id }, { status: 202 });
        }
        return Response.json({ version: 1, id: prepared.id, status: "done", content: "Synthetic shell result; no shell was actually provisioned." });
      };
      const config = { adapters: [{ id: "peer", type, url: "https://authorized.example", tokenEnv: "RABBIT_TASK_TEST_TOKEN", allowRemote: true }] };
      const adapters = await buildAdapters(vault, config, transport);
      await withCoordinator(vault, async queue => {
        const id = (await queue.enqueue(definition({ capability: "shell.job", adapters: ["peer"], share: true, instruction: `Synthetic ${type} task` }))).id;
        assert.equal((await queue.run(adapters))[0].status, "done");
        assert.equal(prepared.id, id);
        assert.ok(calls.every(url => url.startsWith("https://authorized.example/")));
      });
    }
    await assert.rejects(buildAdapters(vault, { adapters: [{ id: "peer", type: "agent-http", url: "http://example.com", allowRemote: true }] }), /HTTPS/);
    await assert.rejects(buildAdapters(vault, { adapters: [{ id: "peer", type: "agent-http", url: "https://example.com" }] }), /allowRemote/);
  } finally { delete process.env.RABBIT_TASK_TEST_TOKEN; }
}));

test("hosted model adapters preserve explicit provider choice and require opted-in note evidence", async () => temporary(async vault => {
  await mkdir(join(vault, "Agents"));
  await writeFile(join(vault, "Agents", "Public.md"), "---\ncloud-agent-share: true\n---\nPublic synthetic model evidence");
  await writeFile(join(vault, "Agents", "Private.md"), "# Unshared synthetic model evidence");
  const providerConfig = join(vault, "synthetic-provider.json");
  await writeFile(providerConfig, JSON.stringify({ type: "openai-compatible", allowRemote: true, url: "https://selected.example/chat", model: "selected-model", token: "synthetic-test-token-not-a-secret" }));
  let calls = 0;
  const transport = async (url, options) => {
    calls++;
    assert.equal(url, "https://selected.example/chat");
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "selected-model");
    assert.ok(JSON.stringify(body.messages).includes("Public synthetic model evidence"));
    assert.ok(!JSON.stringify(body.messages).includes("Unshared synthetic model evidence"));
    return Response.json({ choices: [{ message: { content: '{"action":"answer","content":"Hosted synthetic answer citing Agents/Public.md."}' } }] });
  };
  const config = { adapters: [{ id: "hosted", type: "model", allowRemote: true, providerConfig }] };
  const adapters = await buildAdapters(vault, config, transport);
  await withCoordinator(vault, async queue => {
    const rejected = (await queue.enqueue(definition({ adapters: ["hosted"], notes: ["Agents/Private.md"], share: true }))).id;
    await queue.run(adapters, 0);
    assert.equal(queue.state.tasks[rejected].status, "blocked");
    assert.equal(calls, 0);
    const accepted = (await queue.enqueue(definition({ adapters: ["hosted"], notes: ["Agents/Public.md"], share: true }))).id;
    assert.equal((await queue.run(adapters, 10000))[0].status, "done");
    assert.equal(queue.state.tasks[accepted].adapter, "hosted");
    assert.equal(calls, 1);
  });
  await assert.rejects(buildAdapters(vault, { adapters: [{ id: "hosted", type: "model", providerConfig }] }), /allowRemote/);
}));

test("HTTP response interruption replays the same task safely and rejects oversized outbound messages", async () => temporary(async vault => {
  process.env.RABBIT_TASK_TEST_TOKEN = "synthetic-test-token-not-a-secret-32";
  try {
    let interrupted = true, task, calls = 0;
    const accepted = new Set();
    const transport = async (url, options) => {
      calls++;
      if (url.endsWith("/capabilities")) return Response.json(manifest);
      if (options.method === "POST") {
        task = JSON.parse(options.body);
        accepted.add(task.id);
        if (interrupted) {
          interrupted = false;
          return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Synthetic interrupted acknowledgment")); } }),
            { headers: { "Content-Type": "application/json" } });
        }
        return Response.json({ version: 1, id: task.id });
      }
      return Response.json({ version: 1, id: task.id, status: "done", content: "Resumed synthetic peer job" });
    };
    const adapters = await buildAdapters(vault, { adapters: [{ id: "peer", type: "agent-http", allowRemote: true, url: "https://selected.example", tokenEnv: "RABBIT_TASK_TEST_TOKEN" }] }, transport);
    await withCoordinator(vault, async queue => {
      const id = (await queue.enqueue(definition({ adapters: ["peer"], share: true }))).id;
      assert.equal((await queue.run(adapters, 0))[0].status, "waiting");
      assert.equal((await queue.run(adapters, 10000))[0].status, "done");
      assert.deepEqual([...accepted], [id]);
      const before = calls;
      await assert.rejects(adapters.peer.advance({ version: 1, id, inputs: [{ content: "x".repeat(65536) }] }), /request exceeds 64 KiB/);
      assert.equal(calls, before);
    });
  } finally { delete process.env.RABBIT_TASK_TEST_TOKEN; }
}));

test("Cloudflare bridge submits immutable opted-in snapshots, polls durable results and refuses private notes", async () => temporary(async vault => {
  await mkdir(join(vault, "Agents"));
  await writeFile(join(vault, "Agents", "Public.md"), "---\ncloud-agent-share: true\n---\n# Public synthetic syntax");
  await writeFile(join(vault, "Agents", "Private.md"), "# Private synthetic syntax");
  process.env.RABBIT_TASK_TEST_TOKEN = "synthetic-test-token-not-a-secret-32";
  try {
    let remoteId, body, ready = false;
    const transport = async (url, options) => {
      if (url.endsWith("/health")) return Response.json({ ok: true, modes: ["task"] });
      if (options.method === "POST") {
        const current = JSON.parse(options.body);
        if (body) assert.deepEqual(current, body);
        body = current; remoteId = await digest(JSON.stringify(body));
        return Response.json({ id: remoteId }, { status: 202 });
      }
      if (url.endsWith("/result")) return ready ? Response.json({ id: remoteId, mode: "task", answer: "Durable synthetic syntax answer", edits: [] })
        : Response.json({ error: "Pending" }, { status: 409 });
      return Response.json({ id: remoteId, status: "running" });
    };
    const adapters = await buildAdapters(vault, { adapters: [{ id: "cf", type: "cloudflare-jobs", url: "https://worker.example", tokenEnv: "RABBIT_TASK_TEST_TOKEN", allowRemote: true }] }, transport);
    await withCoordinator(vault, async queue => {
      const id = (await queue.enqueue(definition({ adapters: ["cf"], share: true, notes: ["Agents/Public.md"] }))).id;
      assert.equal((await queue.run(adapters, 0))[0].status, "waiting");
      await writeFile(join(vault, "Agents", "Public.md"), "---\ncloud-agent-share: true\n---\nChanged after submission");
      ready = true;
      assert.equal((await queue.run(adapters, 60001))[0].status, "done");
      assert.match(body.notes[0].content, /Public synthetic/);
      assert.equal(queue.artifact(queue.state.tasks[id].output).content, "Durable synthetic syntax answer");
      const privateTask = (await queue.enqueue(definition({ adapters: ["cf"], share: true, notes: ["Agents/Private.md"] }))).id;
      await queue.run(adapters, 70000);
      assert.equal(queue.state.tasks[privateTask].status, "blocked");
      assert.match(queue.state.tasks[privateTask].error, /share/);
    });
  } finally { delete process.env.RABBIT_TASK_TEST_TOKEN; }
}));
