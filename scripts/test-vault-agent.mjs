import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  MAX_BYTES, digest, normalizeJob, modelResult, notePath, noteContent, readJson,
} from "../workers/vault-agent/src/protocol.mjs";
import { collect, safePath, saveResult, applyResult, endpoint, main } from "./vault-agent-sync.mjs";

const TOKEN = "test-only-not-a-real-secret-0123456789";
const content = "---\ncloud-agent-share: true\n---\n# Sample\nPublic test information.\n";
const sample = (mode = "answer") => normalizeJob({
  mode, instruction: "Help with these public test notes.", notes: [{ path: "Agents/Sample.md", content }],
});

test("protocol enforces exact paths, consent, byte limits, and result shape", async () => {
  for (const path of ["Agents/../secret.md", "Agents/C:\\secret.md", "Agents/.env.md", "Other/test.md", "Workers/CON.md", "Agents/test .md/", "Agents/test\\x.md"]) {
    assert.throws(() => notePath(path));
  }
  assert.throws(() => normalizeJob({ ...sample(), notes: [{ path: "Agents/a.md", content }, { path: "Agents/A.md", content }] }), /Duplicate/);
  assert.throws(() => noteContent("# Private"), /share/);
  assert.throws(() => noteContent("---\ncloud-agent-share: true\ncloud-agent-share: false\n---\nData"), /Duplicate/);
  assert.throws(() => noteContent(content + "-----BEGIN RSA PRIVATE KEY-----"), /credential/);
  assert.equal(noteContent(content + "x".repeat(16000 - Buffer.byteLength(content))).length, 16000);
  assert.throws(() => noteContent(content + "x".repeat(16001 - Buffer.byteLength(content))), /16000/);
  assert.throws(() => noteContent(content + "\u00e9".repeat(8000)), /16000/);
  assert.throws(() => normalizeJob({ ...sample(), mode: "execute" }));
  assert.throws(() => normalizeJob({ ...sample(), notes: [] }));
  assert.throws(() => normalizeJob({ ...sample(), notes: Array.from({ length: 5 }, (_, i) => ({ path: `Agents/${i}.md`, content: content + "x".repeat(15000) })) }), /64 KiB/);
  await assert.rejects(modelResult({ response: "Not JSON" }, sample(), "id"));
  await assert.rejects(modelResult({ response: JSON.stringify({ answer: "Answer", edits: [{ path: "Agents/Sample.md", content }] }) }, sample(), "id"), /shape/);
  await assert.rejects(modelResult({ response: JSON.stringify({ answer: "Answer", edits: [{ path: "Agents/Unknown.md", content }] }) }, sample("organize"), "id"), /unknown/);
  const result = await modelResult({ response: JSON.stringify({ answer: "Summary", edits: [{ path: "Agents/Sample.md", content: content + "Organized.\n" }] }) }, sample("organize"), "id");
  assert.equal(result.edits[0].baseHash, await digest(content));
  assert.throws(() => endpoint("http://example.com"));
  assert.throws(() => endpoint("https://user:password@example.com"));
  assert.throws(() => endpoint("https://example.com/path"));
  assert.equal(endpoint("http://127.0.0.1:8805"), "http://127.0.0.1:8805");
});

test("JSON reader enforces actual streaming bytes, not only Content-Length", async () => {
  const make = length => new Response(" ".repeat(length), { headers: { "Content-Type": "application/json", "Content-Length": "1" } });
  await assert.rejects(readJson(make(MAX_BYTES + 1)), /64 KiB/);
  await assert.rejects(readJson(make(MAX_BYTES)), /valid UTF-8 JSON/);
  assert.deepEqual(await readJson(new Response("{}", { headers: { "Content-Type": "application/json" } })), {});
});

test("connector selects opt-in notes from all three roots and stages conflict-safe edits", async () => {
  const vault = await mkdtemp(join(tmpdir(), "rabbit-vault-agent-"));
  try {
    for (const folder of ["Agents", "Workers", "Cloud Agents/Knowledge", "Cloud Agents/Inbox"]) await mkdir(join(vault, ...folder.split("/")), { recursive: true });
    await writeFile(join(vault, "Agents", "Sample.md"), content);
    await writeFile(join(vault, "Workers", "Sample.md"), content);
    await writeFile(join(vault, "Cloud Agents", "Knowledge", "Sample.md"), content);
    await writeFile(join(vault, "Agents", "private.md"), "# Private - do not share.");
    for (const mode of ["task", "answer", "organize"]) {
      await writeFile(join(vault, "Cloud Agents", "Inbox", `${mode}.md`), `---\ncloud-agent-share: true\ncloud-agent-mode: ${mode}\n---\nHelp with notes.\n`);
    }
    const selected = await collect(vault);
    assert.equal(selected.notes.length, 3);
    assert.deepEqual(selected.tasks.map(task => task.job.mode).sort(), ["answer", "organize", "task"]);
    assert.ok(selected.tasks.every(task => task.job.notes.length === 3));
    const job = sample("organize");
    const id = await digest(JSON.stringify(job));
    const state = { jobs: { [id]: { job } } };
    const result = await modelResult({ response: JSON.stringify({ answer: "Organized", edits: [{ path: "Agents/Sample.md", content: content + "An approved addition.\n" }] }) }, job, id);
    await saveResult(vault, state, id, result);
    assert.equal(await readFile(join(vault, "Agents", "Sample.md"), "utf8"), content);
    await writeFile(join(vault, "Agents", "Sample.md"), content + "Local change.\n");
    await assert.rejects(applyResult(vault, state, id), /changed after submission/);
    await writeFile(join(vault, "Agents", "Sample.md"), content);
    assert.equal(await applyResult(vault, state, id), 1);
    assert.equal(await readFile(join(vault, "Agents", "Sample.md"), "utf8"), result.edits[0].content);
    assert.equal(await readFile(join(vault, "Cloud Agents", "Backups", id, `${await digest("Agents/Sample.md")}.md`), "utf8"), content);
    assert.equal(await applyResult(vault, state, id), 0);
    await assert.rejects(saveResult(vault, state, id, { ...result, edits: [{ ...result.edits[0], baseHash: "0".repeat(64) }] }), /base hash/);
    await assert.rejects(safePath(vault, "../outside"), /Unsafe/);
    await symlink(join(vault, "Workers"), join(vault, "Agents", "linked"), "junction");
    await assert.rejects(collect(vault), /linked path/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test("real Worker, Workflow, R2, and SQLite runtime completes all modes without remote inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rabbit-vault-runtime-"));
  const bundle = await build({
    entryPoints: ["workers/vault-agent/src/index.js"], bundle: true, write: false,
    format: "esm", external: ["cloudflare:workers"],
  });
  const workers = [
    {
      name: "vault-agent-test", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-12",
      bindings: { VAULT_AGENT_TOKEN: TOKEN },
      r2Buckets: { VAULT: "vault-test" },
      workflows: { JOBS: { name: "vault-jobs-test", className: "VaultJob" } },
      durableObjects: { BUDGET: { className: "VaultBudget", useSQLite: true } },
      serviceBindings: { AI: { name: "fake-ai", entrypoint: "FakeAI" } },
    },
    {
      name: "fake-ai", modules: true, compatibilityDate: "2026-10-12",
      script: `import { WorkerEntrypoint } from "cloudflare:workers";
        export class FakeAI extends WorkerEntrypoint {
          async run(model, input) {
            const payload = JSON.parse(input.messages[1].content.replace(/\\n\\/no_think$/, ""));
            if (payload.instruction === "FAIL") throw new Error("Deliberate test failure");
            const organize = input.messages[0].content.startsWith("Summarize");
            return { response: JSON.stringify({ answer: "TEST ONLY: " + payload.instruction,
              edits: organize ? [{ path: payload.notes[0].path, content: payload.notes[0].content + "Organized.\\n" }] : [] }) };
          }
        }
        export default { fetch() { return new Response("Test-only AI stub"); } };`,
    },
  ];
  const configuration = { ...convertV4MiniflareOptions({ workers }), resourcePersistencePath: directory };
  let runtime;
  let server;
  let connectorState;
  const previousUrl = process.env.VAULT_AGENT_URL;
  const previousToken = process.env.VAULT_AGENT_TOKEN;
  try {
    runtime = new Miniflare(configuration);
    const request = (path, body, authenticated = true) => runtime.dispatchFetch(`http://test${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${TOKEN}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await request("/health", undefined, false)).status, 401);
    assert.equal((await request("/health")).status, 200);
    assert.equal((await request("/jobs", { ...sample(), notes: [{ path: "Agents/secret.md", content: "no consent" }] })).status, 400);
    const wait = async id => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await request(`/jobs/${id}`);
        assert.equal(response.status, 200);
        const value = await response.json();
        if (["complete", "errored"].includes(value.status)) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail("Local Workflow did not finish within 10 seconds.");
    };
    for (const mode of ["task", "answer", "organize"]) {
      const job = sample(mode);
      const response = await request("/jobs", job);
      assert.equal(response.status, 202, await response.clone().text());
      const { id } = await response.json();
      assert.equal(id, await digest(JSON.stringify(job)));
      const status = await wait(id);
      assert.equal(status.status, "complete", JSON.stringify(status));
      const output = await (await request(`/jobs/${id}/result`)).json();
      assert.equal(output.id, id);
      assert.equal(output.mode, mode);
      assert.equal(output.edits.length, mode === "organize" ? 1 : 0);
      const replay = await request("/jobs", job);
      assert.equal(replay.status, 202, await replay.clone().text());
      assert.equal((await replay.json()).id, id);
    }
    const vault = join(directory, "vault");
    for (const folder of ["Agents", "Workers", "Cloud Agents/Knowledge", "Cloud Agents/Inbox"]) await mkdir(join(vault, ...folder.split("/")), { recursive: true });
    await writeFile(join(vault, "Agents", "Sample.md"), content);
    for (const mode of ["task", "answer", "organize"]) {
      await writeFile(join(vault, "Cloud Agents", "Inbox", `${mode}.md`), `---\ncloud-agent-share: true\ncloud-agent-mode: ${mode}\n---\nConnector ${mode} task.\n`);
    }
    let posts = 0;
    let failPost = false;
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        if (incoming.method === "POST") posts++;
        const response = incoming.method === "POST" && failPost
          ? Response.json({ error: "Deliberate connector transport failure" }, { status: 503 })
          : await runtime.dispatchFetch(`http://test${incoming.url}`, {
            method: incoming.method, headers: incoming.headers,
            ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.writeHead(500, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.VAULT_AGENT_URL = origin;
    process.env.VAULT_AGENT_TOKEN = TOKEN;
    connectorState = join(process.cwd(), ".wrangler", "vault-agent-sync", await digest(`${vault.toLowerCase()}|${origin}`));
    const tasks = (await collect(vault)).tasks;
    await main(["--vault", vault, "--plan"]);
    assert.equal(posts, 0);
    await assert.rejects(main(["--vault", vault, "--sync"]), /allow-upload/);
    await main(["--vault", vault, "--sync", "--allow-upload"]);
    for (const task of tasks) assert.equal((await wait(await digest(JSON.stringify(task.job)))).status, "complete");
    await main(["--vault", vault, "--pull"]);
    for (const task of tasks) {
      const id = await digest(JSON.stringify(task.job));
      assert.match(await readFile(join(vault, "Cloud Agents", "Results", `${id}.md`), "utf8"), /TEST ONLY/);
    }
    assert.equal(posts, 3);
    const organizedId = await digest(JSON.stringify(tasks.find(task => task.job.mode === "organize").job));
    await assert.rejects(main(["--vault", vault, "--apply", organizedId]), /approve-edits/);
    await main(["--vault", vault, "--apply", organizedId, "--approve-edits"]);
    assert.match(await readFile(join(vault, "Agents", "Sample.md"), "utf8"), /Organized/);
    await main(["--vault", vault, "--sync", "--allow-upload"]);
    assert.equal(posts, 3, "Unchanged tasks must not rerun after knowledge edits.");
    const pendingPath = join(vault, "Cloud Agents", "Inbox", "pending.md");
    const pending = "---\ncloud-agent-share: true\ncloud-agent-mode: answer\n---\nRevoke pending upload.\n";
    await writeFile(pendingPath, pending);
    failPost = true;
    await assert.rejects(main(["--vault", vault, "--sync", "--allow-upload"]), /HTTP 503/);
    const postsBeforeRevocation = posts;
    failPost = false;
    await writeFile(pendingPath, pending.replace("share: true", "share: false"));
    await main(["--vault", vault, "--sync", "--allow-upload"]);
    assert.equal(posts, postsBeforeRevocation, "Revoked pending snapshots must not upload.");
    const failed = await (await request("/jobs", { ...sample(), instruction: "FAIL" })).json();
    assert.equal((await wait(failed.id)).status, "errored");
    assert.equal((await request(`/jobs/${failed.id}/result`)).status, 409);
    const budget = await runtime.getDurableObjectNamespace("BUDGET");
    const stub = budget.get(budget.idFromName("vault-inference-budget"));
    for (let index = 7; index < 20; index++) assert.equal(await stub.reserve(), true);
    assert.equal(await stub.reserve(), false);
    await runtime.dispose();
    runtime = new Miniflare(configuration);
    const restored = await runtime.getDurableObjectNamespace("BUDGET");
    assert.equal(await restored.get(restored.idFromName("vault-inference-budget")).reserve(), false);
    const id = await digest(JSON.stringify(sample("organize")));
    assert.equal((await request(`/jobs/${id}/result`)).status, 200);
  } finally {
    if (previousUrl === undefined) delete process.env.VAULT_AGENT_URL;
    else process.env.VAULT_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.VAULT_AGENT_TOKEN;
    else process.env.VAULT_AGENT_TOKEN = previousToken;
    if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.dispose();
    if (connectorState) await rm(connectorState, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
