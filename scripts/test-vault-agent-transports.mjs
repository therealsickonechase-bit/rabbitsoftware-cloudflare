import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { once } from "node:events";
import { withMailbox, Mailbox } from "../tools/vault-agent/mailbox.mjs";
import { exportRelay, importRelay, RELAY_LIMITS } from "../tools/vault-agent/offline-relay.mjs";
import { proxySettings, networkFetch, diagnoseNetworks } from "../tools/vault-agent/network-transport.mjs";
import { buildAdapters } from "../tools/vault-agent/task-adapters.mjs";
import { withCoordinator } from "../tools/vault-agent/coordinator.mjs";
import { generator } from "../tools/vault-agent/runtime.mjs";

const runFile = promisify(execFile);
const message = (overrides = {}) => ({ version: 1, sender: "relay-sender", recipient: "relay-agent",
  kind: "handoff", route: "local", share: true, key: "public-relay-v1", content: "Public synthetic offline handoff \u{1f430}", ...overrides });
async function temporary(action) {
  const directory = await mkdtemp(join(tmpdir(), "rabbit-transport-"));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("offline relay validates share, hashes, immutable replay and exact source acknowledgment separation", async () => temporary(async root => {
  const source = join(root, "source"); const target = join(root, "target");
  await import("node:fs/promises").then(fs => Promise.all([fs.mkdir(source), fs.mkdir(target)]));
  let value, id;
  await withMailbox(source, async mailbox => {
    id = (await mailbox.send(message())).id;
    const privateMessage = await mailbox.send(message({ key: "private", share: false }));
    await assert.rejects(exportRelay(mailbox, [privateMessage.id]), /share/);
    value = await exportRelay(mailbox, [id]);
    assert.equal(mailbox.receive("relay-agent").messages[0].id, id);
    await assert.rejects(exportRelay(mailbox, [id, id]), /unique/);
  });
  await withMailbox(target, async mailbox => {
    const mutated = structuredClone(value); mutated.messages[0].message.content = "Manipulated";
    await assert.rejects(importRelay(mailbox, mutated), /intact/);
    assert.equal(mailbox.list().storage.messages, 0);
    const wrongBundle = { ...value, id: "a".repeat(64) };
    await assert.rejects(importRelay(mailbox, wrongBundle), /hash mismatch/);
    const receipt = await importRelay(mailbox, value);
    assert.equal(receipt.executed, false);
    assert.equal(receipt.acknowledgedAtSource, false);
    assert.equal(mailbox.read("relay-agent", id).content, message().content);
    assert.equal((await importRelay(mailbox, value)).imported[0].replay, true);
    const read = mailbox.read("relay-agent", id);
    await mailbox.acknowledge({ recipient: "relay-agent", id, artifact: read.artifact });
    assert.equal((await importRelay(mailbox, value)).imported[0].status, "acknowledged");
  });
  await withMailbox(source, mailbox => assert.equal(mailbox.read("relay-agent", id).status, "pending"));
}));

test("relay import is batch atomic on key conflicts and capacity overflow", async () => {
  const source = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
  const first = await source.send(message());
  const second = await source.send(message({ key: "second", content: "Second public handoff" }));
  const bundle = await exportRelay(source, [first.id, second.id]);
  const target = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
  await target.send(message({ key: "second", content: "Conflicting existing handoff" }));
  const before = JSON.stringify(target.state);
  await assert.rejects(importRelay(target, bundle), /different immutable/);
  assert.equal(JSON.stringify(target.state), before);
  const full = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
  for (let index = 0; index < 127; index++) await full.send(message({ key: `fill-${index}`, content: "Public fill" }));
  const snapshot = JSON.stringify(full.state);
  await assert.rejects(importRelay(full, bundle), /full/);
  assert.equal(JSON.stringify(full.state), snapshot);
});

test("relay output byte ceiling includes JSON escaping, with no silent content truncation", async () => {
  const mailbox = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
  const ids = [];
  for (let index = 0; index < 5; index++) ids.push((await mailbox.send(message({ key: `large-${index}`, content: '"'.repeat(32768) }))).id);
  const allowed = await exportRelay(mailbox, ids.slice(0, 3));
  assert.ok(Buffer.byteLength(JSON.stringify(allowed)) <= RELAY_LIMITS.bytes);
  await assert.rejects(exportRelay(mailbox, ids), /256 KiB/);

  const boundaryBundle = async (extra = 0) => {
    const candidate = new Mailbox({ version: 1, messages: {}, artifacts: {} }, async () => {});
    const selected = [];
    for (let index = 0; index < 5; index++) selected.push((await candidate.send(message({
      key: `boundary-${index}`, content: "x".repeat(51000 + (index === 4 ? extra : 0)),
    }))).id);
    return exportRelay(candidate, selected);
  };
  const baseline = Buffer.byteLength(JSON.stringify(await boundaryBundle()));
  const padding = RELAY_LIMITS.bytes - baseline;
  assert.equal(Buffer.byteLength(JSON.stringify(await boundaryBundle(padding))), RELAY_LIMITS.bytes);
  await assert.rejects(boundaryBundle(padding + 1), /including its hash/);
});

test("CLI exports opt-in relay without overwriting output, imports offline, and diagnoses without a vault", async () => temporary(async root => {
  const fs = await import("node:fs/promises");
  const source = join(root, "source"); const target = join(root, "target");
  await fs.mkdir(source); await fs.mkdir(target);
  const sent = await withMailbox(source, mailbox => mailbox.send(message()));
  const path = join(root, "relay.json");
  const cli = (...args) => runFile(process.execPath, [resolve("scripts", "vault-agent-network.mjs"), ...args]);
  await cli("--vault", source, "--export-relay", sent.id, "--output", path);
  await assert.rejects(cli("--vault", source, "--export-relay", sent.id, "--output", path), /EEXIST/);
  const imported = JSON.parse((await cli("--vault", target, "--import-relay", path)).stdout);
  assert.equal(imported.imported[0].id, sent.id);
  const diagnostics = JSON.parse((await cli("--diagnose")).stdout);
  assert.equal(diagnostics.hardwareControl, false);
  assert.equal(diagnostics.dnsProbed, false);
  assert.ok(!JSON.stringify(diagnostics).includes("mac"));
  await assert.rejects(cli("--diagnose", "--output", path), /required only/);
}));

test("proxy config refuses credentials, downgrades, local rerouting and missing auth", async () => {
  assert.throws(() => proxySettings({ url: "http://user:secret@proxy.example" }), /credential-free/);
  assert.throws(() => proxySettings({ url: "socks5://proxy.example" }), /CONNECT/);
  assert.throws(() => proxySettings({ url: "http://proxy.example", insecure: true }), /exact/);
  await assert.rejects(networkFetch("http://example.com", {}, { url: "http://127.0.0.1:8899" }), /HTTPS/);
  await assert.rejects(networkFetch("https://example.com", {}, { url: "http://127.0.0.1:8899", tokenEnv: "VAULT_MISSING_PROXY_TOKEN" }), /missing/);
  await assert.rejects(generator({ type: "ollama", model: "synthetic", proxy: { url: "http://proxy.example" } }), /must not/);
  await assert.rejects(buildAdapters("unused", { adapters: [{ id: "local", type: "local", proxy: { url: "http://proxy.example" } }] }), /do not accept/);
});

test("proxy selection is forwarded to agent/model transports and pinned against route changes", async () => temporary(async vault => {
  process.env.VAULT_TRANSPORT_TEST_TOKEN = "synthetic-agent-token-not-secret-32";
  try {
    const proxy = { url: "http://127.0.0.1:8999" };
    let pending = true, id;
    const transport = async (url, options, route) => {
      assert.deepEqual(route, proxy);
      if (url.endsWith("/capabilities")) return Response.json({ versions: [1], capabilities: ["text.transform"], idempotentTasks: true });
      if (options.method === "POST") { id = JSON.parse(options.body).id; return Response.json({ version: 1, id }); }
      return Response.json({ version: 1, id, status: pending ? "waiting" : "done", content: "Public proxied answer" });
    };
    const config = { adapters: [{ id: "peer", type: "agent-http", allowRemote: true, url: "https://authorized.example", tokenEnv: "VAULT_TRANSPORT_TEST_TOKEN", proxy }] };
    const adapters = await buildAdapters(vault, config, transport);
    await withCoordinator(vault, async queue => {
      await queue.enqueue({ version: 1, capability: "text.transform", instruction: "Public proxy route check", adapters: ["peer"], share: true });
      assert.equal((await queue.run(adapters))[0].status, "waiting");
      Object.values(queue.state.tasks)[0].nextAttempt = 0;
      pending = false;
      const changed = await buildAdapters(vault, { adapters: [{ ...config.adapters[0], proxy: { url: "http://127.0.0.1:8998" } }] }, transport);
      assert.equal((await queue.run(changed))[0].status, "blocked");
      assert.match(queue.list().tasks[0].error, /identity changed/);
    });
    const ask = await generator({ type: "openai-compatible", model: "synthetic", allowRemote: true, url: "https://authorized.example/chat",
      token: "synthetic-provider-token", proxy }, async (url, options, route) => {
      assert.deepEqual(route, proxy);
      return Response.json({ choices: [{ message: { content: '{"action":"answer","content":"Proxied model answer."}' } }] });
    });
    assert.match(await ask([]), /Proxied model/);
  } finally { delete process.env.VAULT_TRANSPORT_TEST_TOKEN; }
}));

test("diagnostics reveal bounded interface/route metadata, not tokens or undocumented hardware claims", async () => {
  await assert.rejects(diagnoseNetworks(null), /configuration object/);
  await assert.rejects(diagnoseNetworks({ adapters: [null] }), /entries as objects/);
  await assert.rejects(diagnoseNetworks({ adapters: [{ id: "x".repeat(10000), type: "model" }] }), /adapter/i);
  process.env.VAULT_DIAGNOSTIC_TOKEN = "do-not-print-this-value";
  try {
    const report = await diagnoseNetworks({ adapters: [{ id: "peer", type: "agent-http", url: "https://authorized.example",
      tokenEnv: "VAULT_DIAGNOSTIC_TOKEN", proxy: { url: "http://127.0.0.1:8899" } }] });
    assert.equal(report.routes[0].dns, "ip-literal-no-dns");
    assert.equal(report.routes[0].credentialConfigured, true);
    assert.ok(report.interfaces.length <= 32);
    assert.ok(!JSON.stringify(report).includes(process.env.VAULT_DIAGNOSTIC_TOKEN));
    assert.equal(report.hardwareControl, false);
    assert.deepEqual(report.connectedProviders, []);
  } finally { delete process.env.VAULT_DIAGNOSTIC_TOKEN; }
});

test("real CONNECT proxy carries TLS-verified HTTPS without target DNS or leaking proxy auth; no failed-route fallback", async () => temporary(async root => {
  const openssl = process.env.VAULT_OPENSSL ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl");
  const key = join(root, "key.pem"); const cert = join(root, "cert.pem");
  await runFile(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=relay.example", "-addext", "subjectAltName=DNS:relay.example"]);
  let originRequests = 0, connections = 0;
  const origin = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    originRequests++;
    assert.equal(request.headers["proxy-authorization"], undefined);
    assert.equal(request.headers.authorization, "Bearer synthetic-origin-token");
    if (request.url === "/redirect") { response.writeHead(302, { Location: "https://other.example" }); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}');
  });
  origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  const sockets = new Set();
  const proxy = httpServer();
  proxy.on("connect", (request, socket, head) => {
    connections++;
    assert.equal(request.url, "relay.example:443");
    assert.equal(request.headers["proxy-authorization"], "Basic synthetic-proxy-token");
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const upstream = connect(origin.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const moduleUrl = new URL("../tools/vault-agent/network-transport.mjs", import.meta.url).href;
  const script = `import {networkFetch} from ${JSON.stringify(moduleUrl)}; const response=await networkFetch(process.argv[1],{headers:{Authorization:"Bearer synthetic-origin-token"},signal:AbortSignal.timeout(10000)}, {url:process.argv[2],tokenEnv:"VAULT_REAL_PROXY_TOKEN"}); console.log(await response.text());`;
  const invoke = (url, port, trust = true) => runFile(process.execPath, ["--input-type=module", "-e", script, url, `http://127.0.0.1:${port}`],
    { env: { ...process.env, VAULT_REAL_PROXY_TOKEN: "Basic synthetic-proxy-token", NODE_EXTRA_CA_CERTS: trust ? cert : "" }, timeout: 15000 });
  try {
    const response = await invoke("https://relay.example/", proxy.address().port);
    assert.equal(JSON.parse(response.stdout).ok, true);
    assert.equal(originRequests, 1);
    await assert.rejects(invoke("https://relay.example/", proxy.address().port, false), /proxy transport failed/);
    await assert.rejects(invoke("https://relay.example/redirect", proxy.address().port), /proxy transport failed/);
    assert.equal(originRequests, 2);
    await assert.rejects(invoke("https://relay.example/", 1), /no direct fallback/);
    assert.ok(connections >= 3);
  } finally {
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(done => origin.close(done)), new Promise(done => proxy.close(done))]);
  }
}));
