import assert from "node:assert/strict";
import test from "node:test";
import { handleShell } from "../workers/cloudshell/src/http.mjs";
import { runCommand } from "../workers/cloudshell/src/command.mts";

const token = "public-synthetic-test-token-32-characters";
const request = (body = { command: "printf public-synthetic", consent: true }, headers = {}) => new Request("https://shell/execute", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
  body: JSON.stringify(body),
});

test("UTF-8 command boundary is bytes, and health never allocates a sandbox", async () => {
  let calls = 0;
  const execute = async () => { calls++; return { status: 200, body: { exitCode: 0 } }; };
  assert.equal((await handleShell(request({ command: "\u00e9".repeat(2000), consent: true }), token, execute)).status, 200);
  assert.equal((await handleShell(request({ command: "\u00e9".repeat(2001), consent: true }), token, execute)).status, 400);
  const health = new Request("https://shell/health", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await handleShell(health, token, () => assert.fail("health allocated a container"))).status, 200);
  assert.equal(calls, 1);
});

test("shell refuses missing config, unauthenticated/browser requests and unapproved inputs before execution", async () => {
  let calls = 0;
  const execute = async () => { calls++; return { status: 200, body: {} }; };
  assert.equal((await handleShell(request(), "", execute)).status, 503);
  assert.equal((await handleShell(request({}, { Authorization: "Bearer wrong" }), token, execute)).status, 401);
  assert.equal((await handleShell(request(undefined, { Origin: "https://app.rabbitsoftware.io" }), token, execute)).status, 403);
  for (const body of [
    { command: "echo hello", consent: false }, { command: "echo hello", consent: true, env: { TOKEN: "forbidden" } },
    { command: "x".repeat(4001), consent: true }, { command: "\0", consent: true },
  ]) assert.equal((await handleShell(request(body), token, execute)).status, 400);
  assert.equal((await handleShell(request({ command: "x".repeat(9000), consent: true }), token, execute)).status, 413);
  assert.equal(calls, 0);
});

test("shell exposes real command result and explicit errors, never fallback or retry", async t => {
  let calls = 0;
  const response = await handleShell(request(), token, async command => {
    calls++;
    assert.equal(command, "printf public-synthetic");
    return { status: 200, body: { stdout: "public-synthetic", stderr: "synthetic warning", exitCode: 3, timedOut: false, truncated: false } };
  });

  const memoryStorage = () => {
    const entries = new Map();
    let queue = Promise.resolve();
    return {
      entries,
      transaction(callback) {
        const operation = queue.then(() => callback({
          get: async key => entries.get(key),
          put: async (key, value) => entries.set(key, value),
          delete: async key => entries.delete(key),
        }));
        queue = operation.catch(() => {});
        return operation;
      },
    };
  };

  await t.test("durable gate rejects overlap and enforces exact remote timeout and output limits", async () => {
    const storage = memoryStorage();
    let finish;
    let destroyed = false;
    const pending = new Promise(resolve => { finish = resolve; });
    const runner = {
      exec: async (argv, options) => {
        assert.deepEqual(argv, ["/bin/bash", "-lc", "echo synthetic"]);
        assert.deepEqual(options, { cwd: "/workspace", timeout: 60000 });
        return {
          output: async options => {
            assert.deepEqual(options, { encoding: "utf8", maxBytes: 65536, timeout: 70000 });
            await pending;
            return { stdout: "synthetic", stderr: "", exitCode: 0, timedOut: false, truncated: true };
          },
          kill: async () => assert.fail("must not kill completed output"),
        };
      },
      destroy: async () => { destroyed = true; },
    };
    const first = runCommand(storage, () => runner, "echo synthetic");
    const overlap = await runCommand(storage, () => assert.fail("must not allocate"), "second");
    assert.equal(overlap.status, 409);
    finish();
    const result = await first;
    assert.equal(result.body.truncated, true);
    assert.equal(destroyed, true);
    assert.equal(storage.entries.size, 0);
  });

  await t.test("failed output kills process before destruction; failed teardown leaves durable lock across recreation", async () => {
    const storage = memoryStorage();
    const events = [];
    const runner = {
      exec: async () => ({
        output: async () => { throw new Error("wait failure"); },
        kill: async signal => { assert.equal(signal, 9); events.push("kill"); },
      }),
      destroy: async () => { events.push("destroy"); throw new Error("teardown failure"); },
    };
    await assert.rejects(runCommand(storage, () => runner, "synthetic"), /teardown failure/);
    assert.deepEqual(events, ["kill", "destroy"]);
    assert.equal((await runCommand(storage, () => assert.fail("locked"), "again")).status, 409);
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).exitCode, 3);
  const failure = await handleShell(request(), token, async () => { calls++; throw new Error("do not expose secret"); });
  assert.equal(failure.status, 502);
  assert.ok(!(await failure.text()).includes("secret"));
  assert.equal(calls, 2);
});
