import assert from "node:assert/strict";
import test from "node:test";
import { handleShell } from "../workers/cloudshell/src/http.mjs";
import { SESSION, endSession, expireSession, redact, runSessionCommand, sessionStatus, startSession, toolsStatus } from "../workers/cloudshell/src/session.mts";

const token = "public-synthetic-test-token-32-characters";
const post = (path, body, headers = {}) => new Request(`https://shell${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body),
});
const get = path => new Request(`https://shell${path}`, { headers: { Authorization: `Bearer ${token}` } });

const memoryStorage = () => {
  const entries = new Map();
  let queue = Promise.resolve();
  return {
    entries,
    transaction(callback) {
      const operation = queue.then(() => callback({
        get: async key => entries.get(key), put: async (key, value) => { entries.set(key, value); }, delete: async key => entries.delete(key),
      }));
      queue = operation.catch(() => {});
      return operation;
    },
  };
};
const fakeAlarm = () => { const calls = []; return { calls, set: async at => { calls.push(["set", at]); }, clear: async () => { calls.push(["clear"]); } }; };
const runnerWith = (log, over = {}) => ({
  exec: async (argv, options) => {
    log.push({ argv, options });
    return {
      output: async o => { log.push({ output: o }); return over.output ?? { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false }; },
      kill: async () => { log.push("kill"); },
    };
  },
  destroy: async () => { log.push("destroy"); if (over.destroyFails) throw new Error("teardown failed"); },
});

test("without a session handler nothing changes: the extra fields and the session routes do not exist", async () => {
  let calls = 0;
  const execute = async () => { calls++; return { status: 200, body: {} }; };
  assert.equal((await handleShell(post("/execute", { command: "echo", consent: true, session: true }), token, execute)).status, 400);
  assert.equal((await handleShell(get("/session"), token, execute)).status, 404);
  assert.equal((await handleShell(post("/session/start", { consent: true }), token, execute)).status, 404);
  assert.equal(calls, 0);
  const health = await (await handleShell(get("/health"), token, execute)).json();
  assert.equal(health.sessionMode, undefined);
  assert.equal(health.commandTimeoutMs, 60000);
});

test("a plain command still goes to the ephemeral path with only the command; a session command carries its options", async () => {
  const seen = [];
  const execute = async (...args) => { seen.push(args); return { status: 200, body: { exitCode: 0 } }; };
  const session = { status: async () => ({ status: 200, body: {} }), start: async () => ({ status: 200, body: {} }), end: async () => ({ status: 200, body: {} }) };
  await handleShell(post("/execute", { command: "echo a", consent: true }), token, execute, session);
  await handleShell(post("/execute", { command: "echo b", consent: true, session: false }), token, execute, session);
  await handleShell(post("/execute", { command: "echo c", consent: true, session: true, timeoutSeconds: 120 }), token, execute, session);
  assert.deepEqual(seen, [["echo a"], ["echo b"], ["echo c", { session: true, timeoutSeconds: 120 }]]);
  assert.equal((await (await handleShell(get("/health"), token, execute, session)).json()).sessionMode, true);
});

test("session fields are validated strictly and approval is still required for every command and session action", async () => {
  let calls = 0;
  const execute = async () => { calls++; return { status: 200, body: {} }; };
  const session = { status: async () => { calls++; return { status: 200, body: {} }; }, start: async () => { calls++; return { status: 200, body: {} }; }, end: async () => { calls++; return { status: 200, body: {} }; } };
  for (const body of [
    { command: "x", consent: true, session: "yes" }, { command: "x", consent: true, timeoutSeconds: 60 },                 // a timeout without a session
    { command: "x", consent: true, session: true, timeoutSeconds: 151 }, { command: "x", consent: true, session: true, timeoutSeconds: 0 },
    { command: "x", consent: true, session: true, timeoutSeconds: 1.5 }, { command: "x", consent: true, session: true, timeoutSeconds: "60" },
    { command: "x", consent: false, session: true }, { command: "x", consent: true, session: true, env: { A: "b" } },
  ]) assert.equal((await handleShell(post("/execute", body), token, execute, session)).status, 400, JSON.stringify(body));
  for (const path of ["/session/start", "/session/end"]) {
    for (const body of [{}, { consent: false }, { consent: true, extra: 1 }]) assert.equal((await handleShell(post(path, body), token, execute, session)).status, 400);
  }
  assert.equal(calls, 0);
  assert.equal((await handleShell(post("/session/start", { consent: true }), token, execute, session)).status, 200);
  assert.equal((await handleShell(post("/session/end", { consent: true }), token, execute, session)).status, 200);
  assert.equal((await handleShell(get("/session"), token, execute, session)).status, 200);
  assert.equal(calls, 3);
  assert.equal((await handleShell(get("/session"), "", execute, session)).status, 503);
  assert.equal((await handleShell(new Request("https://shell/session", { headers: { Authorization: "Bearer wrong" } }), token, execute, session)).status, 401);
  assert.equal((await handleShell(post("/session/end", { consent: true }, { Origin: "https://app.rabbitsoftware.io" }), token, execute, session)).status, 403);
});

test("a session command runs in the persistent sandbox with the longer limits, keeps the sandbox, and schedules the teardown before it runs", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  let t = 1_000_000;
  const r = await runSessionCommand(storage, () => runnerWith(log), "npm test", 120, alarm, () => t);
  assert.equal(r.status, 200);
  assert.deepEqual(log[0], { argv: ["/bin/bash", "-lc", "npm test"], options: { cwd: "/workspace", timeout: 120000 } });
  assert.deepEqual(log[1], { output: { encoding: "utf8", maxBytes: 131072, timeout: 130000 } });
  assert.ok(!log.includes("destroy"));                                              // the sandbox stays
  assert.equal(r.body.limits.commandTimeoutMs, 120000);
  assert.equal(r.body.session.active, true);
  assert.equal(alarm.calls[0][1], 1_000_000 + SESSION.idleMs);                       // scheduled before the command
  assert.equal(storage.entries.has("active"), false);                                // the single-command gate is released
  assert.equal(storage.entries.get("session").hardExpiresAt, 1_000_000 + SESSION.maxMs);
  t += 5 * 60_000;
  await runSessionCommand(storage, () => runnerWith(log), "ls", undefined, alarm, () => t);
  assert.equal(storage.entries.get("session").startedAt, 1_000_000);                // the same session
  assert.equal(storage.entries.get("session").idleExpiresAt, t + SESSION.idleMs);   // activity extends the idle window
  assert.equal(log.filter(x => x?.options).at(-1).options.timeout, SESSION.defaultTimeoutS * 1000);
});

test("the idle window never extends past the two-hour limit, and the timeout is clamped to the maximum", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  let t = 0;
  await runSessionCommand(storage, () => runnerWith(log), "a", 9999, alarm, () => t);
  assert.equal(log[0].options.timeout, SESSION.maxTimeoutS * 1000);
  t = SESSION.maxMs - 60_000;                                                         // one minute before the hard limit, still inside the idle window
  storage.entries.get("session").idleExpiresAt = SESSION.maxMs + 10 * 60_000;
  storage.entries.get("session").hardExpiresAt = SESSION.maxMs;
  await runSessionCommand(storage, () => runnerWith(log), "b", 30, alarm, () => t);
  assert.equal(storage.entries.get("session").idleExpiresAt, SESSION.maxMs);          // capped by the hard limit
});

test("commands never overlap, and an ephemeral or session command is refused while another is running", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  const slow = { exec: async () => ({ output: async () => { await hold; return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }; }, kill: async () => {} }), destroy: async () => {} };
  const first = runSessionCommand(storage, () => slow, "sleep 100", 60, alarm);
  await new Promise(r => setTimeout(r, 10));
  const second = await runSessionCommand(storage, () => assert.fail("must not allocate"), "echo", 60, alarm);
  assert.equal(second.status, 409);
  assert.equal((await endSession(storage, () => assert.fail("must not allocate"), alarm)).status, 409);
  finish();
  await first;
  assert.equal(storage.entries.has("active"), false);
});

test("a timed-out or failed command kills its process but keeps the session", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  const broken = { exec: async () => ({ output: async () => { throw new Error("wait failure"); }, kill: async s => { assert.equal(s, 9); log.push("kill"); } }), destroy: async () => log.push("destroy") };
  await assert.rejects(runSessionCommand(storage, () => broken, "x", 60, alarm), /wait failure/);
  assert.deepEqual(log, ["kill"]);
  assert.ok(storage.entries.get("session"));                                          // still open
  assert.equal(storage.entries.has("active"), false);                                 // the gate is free again
  const timed = await runSessionCommand(storage, () => runnerWith([], { output: { stdout: "", stderr: "", exitCode: 124, timedOut: true, truncated: false } }), "sleep 999", 5, alarm);
  assert.equal(timed.body.timedOut, true);
});

test("an expired session is destroyed before a new one starts, and a failed teardown refuses the command and keeps the record", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  let t = 0;
  await runSessionCommand(storage, () => runnerWith(log), "first", 60, alarm, () => t);
  t = SESSION.idleMs + 1;
  await runSessionCommand(storage, () => runnerWith(log), "second", 60, alarm, () => t);
  assert.equal(log.filter(x => x === "destroy").length, 1);
  assert.equal(storage.entries.get("session").startedAt, t);                         // a fresh session
  t += SESSION.idleMs + 1;
  await assert.rejects(runSessionCommand(storage, () => runnerWith(log, { destroyFails: true }), "third", 60, alarm, () => t), /teardown failed/);
  assert.ok(storage.entries.get("session"));
  assert.equal(storage.entries.has("active"), false);
});

test("ending the session destroys it, clears the alarm and reports honestly when teardown fails", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  assert.deepEqual((await endSession(storage, () => assert.fail("nothing to end"), alarm)).body, { ended: false, session: { active: false } });
  await startSession(storage, () => runnerWith(log), alarm);
  const failed = await endSession(storage, () => runnerWith(log, { destroyFails: true }), alarm);
  assert.equal(failed.status, 502);
  assert.ok(storage.entries.get("session"));                                          // kept, so the alarm retries it
  const ended = await endSession(storage, () => runnerWith(log), alarm);
  assert.equal(ended.body.ended, true);
  assert.equal(storage.entries.has("session"), false);
  assert.deepEqual(alarm.calls.at(-1), ["clear"]);
});

test("the alarm destroys an expired session, waits when it is still live, and retries a failed or blocked teardown", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  assert.equal(await expireSession(storage, () => assert.fail("none"), alarm, () => 0), "none");
  let t = 0;
  await runSessionCommand(storage, () => runnerWith(log), "x", 60, alarm, () => t);
  assert.equal(await expireSession(storage, () => assert.fail("still live"), alarm, () => t + 1000), "waiting");
  t = SESSION.idleMs + 5;
  storage.entries.set("active", { id: "running" });
  assert.equal(await expireSession(storage, () => assert.fail("busy"), alarm, () => t), "busy");
  assert.equal(alarm.calls.at(-1)[1], t + 30_000);
  storage.entries.delete("active");
  assert.equal(await expireSession(storage, () => runnerWith(log, { destroyFails: true }), alarm, () => t), "retry");
  assert.equal(alarm.calls.at(-1)[1], t + 60_000);
  assert.ok(storage.entries.get("session"));
  assert.equal(await expireSession(storage, () => runnerWith(log), alarm, () => t), "destroyed");
  assert.equal(storage.entries.has("session"), false);
  assert.equal(storage.entries.has("active"), false);
});

test("the status shows the session only while it is live and always states the limits", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm();
  let t = 10;
  assert.deepEqual((await sessionStatus(storage, () => t)).body.session, { active: false });
  await runSessionCommand(storage, () => runnerWith([]), "x", 60, alarm, () => t);
  const live = await sessionStatus(storage, () => t + 1000);
  assert.equal(live.body.session.active, true);
  assert.equal(live.body.limits.idleMinutes, 20);
  assert.equal(live.body.limits.maxMinutes, 120);
  assert.deepEqual(live.body.limits.timeoutSeconds, { default: 90, max: 150 });
  assert.deepEqual((await sessionStatus(storage, () => t + SESSION.idleMs + 1)).body.session, { active: false });   // expired but not yet swept
  assert.ok(!JSON.stringify(live.body).match(/token|secret|command/i));
});

const KEY = "AIzaSyTESTKEY-synthetic-0123456789abcdef";

test("a configured key goes to the session command as its environment only; without one the options are exactly as before", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm(), log = [];
  await runSessionCommand(storage, () => runnerWith(log), "gemini -p hi", 60, alarm, () => 1000, { GEMINI_API_KEY: KEY });
  assert.deepEqual(log[0].options, { cwd: "/workspace", timeout: 60000, env: { GEMINI_API_KEY: KEY } });
  const plain = [];
  await runSessionCommand(memoryStorage(), () => runnerWith(plain), "ls", 60, fakeAlarm(), () => 1000, {});
  assert.deepEqual(plain[0].options, { cwd: "/workspace", timeout: 60000 });                    // no env key at all
  const empty = [];
  await runSessionCommand(memoryStorage(), () => runnerWith(empty), "ls", 60, fakeAlarm(), () => 1000, { GEMINI_API_KEY: undefined });
  assert.deepEqual(empty[0].options, { cwd: "/workspace", timeout: 60000 });
  const tiny = [];
  await runSessionCommand(memoryStorage(), () => runnerWith(tiny), "ls", 60, fakeAlarm(), () => 1000, { GEMINI_API_KEY: "short" });
  assert.deepEqual(tiny[0].options, { cwd: "/workspace", timeout: 60000 });                     // a value too short to be a key is never passed
});

test("a command that prints the key does not return it, in stdout or stderr", async () => {
  const storage = memoryStorage(), alarm = fakeAlarm();
  const noisy = { output: { stdout: `GEMINI_API_KEY=${KEY}\nok`, stderr: `warning ${KEY} twice ${KEY}`, exitCode: 0, timedOut: false, truncated: false } };
  const r = await runSessionCommand(storage, () => runnerWith([], noisy), "env", 60, alarm, () => 1000, { GEMINI_API_KEY: KEY });
  assert.equal(r.body.stdout, "GEMINI_API_KEY=[redacted]\nok");
  assert.equal(r.body.stderr, "warning [redacted] twice [redacted]");
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.equal(redact("nothing here", { GEMINI_API_KEY: KEY }), "nothing here");
  assert.equal(redact(`a${KEY}b`, { A: undefined, B: "short" }), `a${KEY}b`);                    // only real secrets are removed
});

test("the one-command shell never receives the key: its module has no secrets path", async () => {
  const fs = await import("node:fs");
  const command = fs.readFileSync(new URL("../workers/cloudshell/src/command.mts", import.meta.url), "utf8");
  assert.ok(!/GEMINI|secrets|env:/i.test(command));
  const index = fs.readFileSync(new URL("../workers/cloudshell/src/index.ts", import.meta.url), "utf8");
  assert.equal((index.match(/sessionSecrets\(\)/g) ?? []).length, 3);                           // its definition, the session path and the status: nothing else
  assert.match(index, /return runCommand\(this\.ctx\.storage, \(\) => this\.ephemeral\(\), command\)/);
});

test("the status says whether Gemini is ready without ever including the key", async () => {
  assert.deepEqual(toolsStatus({}), { gemini: { installed: true, keyConfigured: false } });
  assert.deepEqual(toolsStatus({ GEMINI_API_KEY: "short" }), { gemini: { installed: true, keyConfigured: false } });
  assert.deepEqual(toolsStatus({ GEMINI_API_KEY: KEY }), { gemini: { installed: true, keyConfigured: true } });
  const r = await sessionStatus(memoryStorage(), () => 5, { GEMINI_API_KEY: KEY });
  assert.equal(r.body.tools.gemini.keyConfigured, true);
  assert.ok(!JSON.stringify(r.body).includes(KEY));
});

test("the image installs the pinned Gemini CLI with settings that hold no key, and the sandbox is big enough to run it", async () => {
  const fs = await import("node:fs");
  const docker = fs.readFileSync(new URL("../workers/cloudshell/Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /ARG GEMINI_CLI_VERSION=0\.64\.0/);
  assert.match(docker, /gemini --version/);
  assert.ok(!/GEMINI_API_KEY\s*=|AIza/.test(docker));
  const settings = JSON.parse(fs.readFileSync(new URL("../workers/cloudshell/container/gemini-settings.json", import.meta.url), "utf8"));
  assert.equal(settings.privacy.usageStatisticsEnabled, false);
  assert.equal(settings.general.disableAutoUpdate, true);
  assert.equal(settings.mcpServers["rabbitos-hub"].trust, false);
  assert.ok(!JSON.stringify(settings).match(/key|token|secret/i));
  assert.match(fs.readFileSync(new URL("../workers/cloudshell/wrangler.jsonc", import.meta.url), "utf8"), /"instance_type": "basic"/);
  assert.ok(!/GEMINI_API_KEY/.test(fs.readFileSync(new URL("../workers/cloudshell/wrangler.jsonc", import.meta.url), "utf8")), "the key is a Cloudflare secret, never in the config");
});
