import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { LIMITS, limitsFrom, shellEnabled, originAllowed } from "../workers/public-shell/src/limits.mjs";
import * as q from "../workers/public-shell/src/quota.mjs";
import { signToken, verifyToken, newSessionId, validSessionId, ipKey } from "../workers/public-shell/src/tokens.mjs";
import { egressDecision, EGRESS_HOSTS } from "../workers/public-shell/src/egress.mjs";
import { buildKeyEnv, baseEnv, terminalEnv, isProtectedEnvName, logLine } from "../workers/public-shell/src/env.mjs";
import { parseClientFrame, countCommands, inputBudget } from "../workers/public-shell/src/frames.mjs";
import { verifyTurnstile } from "../workers/public-shell/src/turnstile.mjs";

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const SECRET = "public-synthetic-signing-secret-0123456789";
const sid = () => newSessionId();

test("global and per-address session caps, then release frees a slot", () => {
  const s = q.emptyState();
  const limits = { ...LIMITS, maxGlobalSessions: 3, maxSessionsPerIp: 1 };
  assert.equal(q.admit(s, { now: T0, ipKey: "a", sid: sid() }, limits).ok, true);
  assert.deepEqual(q.admit(s, { now: T0, ipKey: "a", sid: sid() }, limits), { ok: false, reason: "ip_cap" });
  const b = sid();
  assert.equal(q.admit(s, { now: T0, ipKey: "b", sid: b }, limits).ok, true);
  assert.equal(q.admit(s, { now: T0, ipKey: "c", sid: sid() }, limits).ok, true);
  assert.equal(q.admit(s, { now: T0, ipKey: "d", sid: sid() }, limits).reason, "global_cap");
  q.release(s, b);
  assert.equal(q.admit(s, { now: T0, ipKey: "d", sid: sid() }, limits).ok, true);
});

test("daily session and command quotas reset on the next UTC day and never count when denied", () => {
  const s = q.emptyState();
  const limits = { ...LIMITS, maxSessionsPerIp: 5, maxSessionsPerIpPerDay: 2, maxCommandsPerIpPerDay: 5 };
  const ids = [sid(), sid(), sid()];
  assert.equal(q.admit(s, { now: T0, ipKey: "a", sid: ids[0] }, limits).ok, true);
  assert.equal(q.admit(s, { now: T0, ipKey: "a", sid: ids[1] }, limits).ok, true);
  assert.equal(q.admit(s, { now: T0, ipKey: "a", sid: ids[2] }, limits).reason, "daily_sessions");
  assert.deepEqual(q.consumeCommands(s, ids[0], 4, T0, limits), { ok: true, remaining: 1 });
  assert.deepEqual(q.consumeCommands(s, ids[1], 2, T0, limits), { ok: false, reason: "daily_commands", remaining: 1 });
  assert.equal(q.consumeCommands(s, ids[1], 1, T0, limits).ok, true);
  assert.equal(q.consumeCommands(s, ids[1], 1, T0, limits).reason, "daily_commands");
  const tomorrow = T0 + 24 * 3600_000;
  q.touch(s, ids[0], tomorrow - 1000);       // keep alive across the date change in this test
  const fresh = sid();
  assert.equal(q.admit(s, { now: tomorrow, ipKey: "a", sid: fresh }, { ...limits, maxLifetimeMs: 2 * 24 * 3600_000, idleMs: 2 * 24 * 3600_000 }).ok, true);
});

test("sessions expire when idle (10 min) and at the hard maximum (30 min) even with activity", () => {
  const s = q.emptyState();
  const a = sid();
  const b = sid();
  q.admit(s, { now: T0, ipKey: "a", sid: a });
  q.admit(s, { now: T0, ipKey: "b", sid: b });
  assert.deepEqual(q.expired(s, T0 + 9 * 60_000), []);
  assert.deepEqual(q.expired(s, T0 + 10 * 60_000).map((e) => e.reason), ["idle", "idle"]);
  for (let t = 5; t <= 29; t += 5) assert.equal(q.touch(s, b, T0 + t * 60_000), true);   // b stays active
  assert.equal(q.touch(s, b, T0 + 30 * 60_000), false);
  assert.deepEqual(q.expired(s, T0 + 30 * 60_000).find((e) => e.sid === b), { sid: b, reason: "max_lifetime" });
  assert.equal(q.consumeCommands(s, b, 1, T0 + 31 * 60_000).ok, false);
  assert.equal(q.attach(s, b, T0 + 31 * 60_000).ok, false);
  assert.ok(q.nextAlarm(s, T0) > T0);
});

test("one terminal connection per session", () => {
  const s = q.emptyState();
  const a = sid();
  q.admit(s, { now: T0, ipKey: "a", sid: a });
  assert.equal(q.attach(s, a, T0).ok, true);
  assert.equal(q.attach(s, a, T0).reason, "already_attached");
  q.detach(s, a);
  assert.equal(q.attach(s, a, T0).ok, true);
  assert.equal(q.attach(s, sid(), T0).reason, "unknown");
});

test("operator overrides can only lower limits; kill switch fails closed", () => {
  assert.equal(limitsFrom({ idleMs: 1000 }).idleMs, 1000);
  assert.equal(limitsFrom({ idleMs: 10 ** 9 }).idleMs, LIMITS.idleMs);
  assert.equal(limitsFrom({ bogus: 1 }).bogus, undefined);
  assert.equal(shellEnabled({ PUBLIC_SHELL_ENABLED: "true" }), true);
  for (const v of ["false", "", "1", "TRUE", undefined]) assert.equal(shellEnabled({ PUBLIC_SHELL_ENABLED: v }), false);
  assert.equal(shellEnabled({}), false);
  assert.equal(originAllowed("https://app.rabbitsoftware.io", {}), true);
  assert.equal(originAllowed("https://evil.example", {}), false);
  assert.equal(originAllowed(null, {}), false);
});

test("session tokens: random ids, tampering, expiry, wrong secret and short secret are rejected", async () => {
  const id = newSessionId();
  assert.ok(validSessionId(id));
  assert.notEqual(id, newSessionId());
  const token = await signToken(SECRET, { sid: id, exp: T0 + 60_000 });
  assert.deepEqual(await verifyToken(SECRET, token, T0), { sid: id, exp: T0 + 60_000 });
  assert.equal(await verifyToken(SECRET, token, T0 + 60_000), null);
  assert.equal(await verifyToken(SECRET + "x", token, T0), null);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sid: newSessionId(), exp: T0 + 60_000 })).toString("base64url");
  assert.equal(await verifyToken(SECRET, `${forged}.${sig}`, T0), null);
  assert.equal(await verifyToken(SECRET, `${body}.AAAA`, T0), null);
  for (const bad of ["", "x", "a.b.c", null, 5, "x".repeat(600)]) assert.equal(await verifyToken(SECRET, bad, T0), null);
  await assert.rejects(signToken("short", { sid: id, exp: T0 }));
  assert.equal(await verifyToken("short", token, T0), null);
  const k = await ipKey(SECRET, "203.0.113.9");
  assert.equal(k, await ipKey(SECRET, "203.0.113.9"));
  assert.ok(!k.includes("203"));
});

test("Turnstile: any failure denies, success needs the exact siteverify answer", async () => {
  const ok = async () => Response.json({ success: true, hostname: "app.rabbitsoftware.io" });
  assert.deepEqual(await verifyTurnstile({ token: "t", secret: "1x0000000000000000", ip: "1.2.3.4" }, ok), { ok: true });
  let called = 0;
  const spy = async () => { called++; return Response.json({ success: true }); };
  assert.equal((await verifyTurnstile({ token: "t", secret: "", ip: "x" }, spy)).ok, false);
  assert.equal((await verifyTurnstile({ token: "", secret: "12345678" }, spy)).ok, false);
  assert.equal((await verifyTurnstile({ token: undefined, secret: "12345678" }, spy)).ok, false);
  assert.equal((await verifyTurnstile({ token: "x".repeat(3000), secret: "12345678" }, spy)).ok, false);
  assert.equal(called, 0);
  const cases = [
    async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    async () => new Response("nope", { status: 500 }),
    async () => new Response("not json", { status: 200 }),
    async () => Response.json({ success: "true" }),
    async () => { throw new Error("network"); },
  ];
  for (const f of cases) assert.equal((await verifyTurnstile({ token: "t", secret: "12345678" }, f)).ok, false);
  assert.equal((await verifyTurnstile({ token: "t", secret: "12345678", expectedHostnames: ["other"] }, ok)).ok, false);
});

test("egress allowlist: registries and APIs yes; everything else, IPs, other ports, http and writes no", () => {
  for (const url of ["https://registry.npmjs.org/left-pad", "https://pypi.org/simple/", "https://api.anthropic.com/v1/messages", "https://generativelanguage.googleapis.com/v1/models",
    "https://github.com/a/b", "https://raw.githubusercontent.com/a/b/main/x", "https://app.rabbitsoftware.io/api/chain/head"]) {
    assert.equal(egressDecision(url, url.includes("anthropic") || url.includes("generative") ? "POST" : "GET").allow, true, url);
  }
  for (const url of ["http://registry.npmjs.org/x", "https://evil.example/", "https://registry.npmjs.org:8443/x", "https://169.254.169.254/latest", "https://[::1]/",
    "https://10.0.0.1/", "https://metadata.google.internal/", "https://npmjs.org.evil.example/", "https://app.rabbitsoftware.io/api/brain/live", "not a url", "https://xmr.pool.example/"]) {
    assert.equal(egressDecision(url).allow, false, url);
  }
  assert.equal(egressDecision("https://github.com/a/b.git/git-upload-pack", "POST").allow, true);
  assert.equal(egressDecision("https://github.com/a/b.git/git-receive-pack", "POST").allow, false);
  assert.equal(egressDecision("https://api.github.com/x").allow, false);
  assert.equal(egressDecision("https://app.rabbitsoftware.io/api/chain/restore", "POST").allow, false);
  // data hub: GET/HEAD on /api/data and /api/data/*; nothing else on the origin
  for (const url of ["https://app.rabbitsoftware.io/api/data", "https://app.rabbitsoftware.io/api/data/research_records?limit=50", "https://app.rabbitsoftware.io/api/data/ledger?format=csv"]) {
    assert.equal(egressDecision(url, "GET").allow, true, url);
    assert.equal(egressDecision(url, "HEAD").allow, true, url);
    assert.equal(egressDecision(url, "POST").allow, false, url);
    assert.equal(egressDecision(url, "DELETE").allow, false, url);
  }
  for (const url of ["https://app.rabbitsoftware.io/api/database", "https://app.rabbitsoftware.io/api/datax/y", "https://app.rabbitsoftware.io/data", "https://app.rabbitsoftware.io/api/self/daily"]) {
    assert.equal(egressDecision(url, "GET").allow, false, url);
  }
  assert.ok(EGRESS_HOSTS.every((h) => !h.includes("*")));
});

test("keys: only the three API-key names are accepted and nothing is persisted or logged", () => {
  const ok = buildKeyEnv({ ANTHROPIC_API_KEY: "sk-ant-synthetic-key-0001", GEMINI_API_KEY: "AIzaSyntheticKey00001" });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.env).sort(), ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"]);
  assert.deepEqual(buildKeyEnv(undefined), { ok: true, env: {} });
  assert.deepEqual(buildKeyEnv({ GOOGLE_API_KEY: "" }), { ok: true, env: {} });
  for (const bad of [{ PATH: "/tmp" }, { LD_PRELOAD: "x" }, { ANTHROPIC_BASE_URL: "https://evil.example" }, { SUPABASE_SERVICE_ROLE_KEY: "sk-service-role-abcdef" },
    { CLOUDFLARE_API_TOKEN: "abcdefghijkl" }, { ANTHROPIC_API_KEY: "has space in it 123" }, { ANTHROPIC_API_KEY: "short" }, { ANTHROPIC_API_KEY: "x".repeat(600) },
    { ANTHROPIC_API_KEY: 12345678 }, [], "str"]) assert.equal(buildKeyEnv(bad).ok, false, JSON.stringify(bad));
  // logging helper never emits keys, frames or unknown fields
  const line = logLine({ event: "x", sid: "abcdef0123456789", frame: "ANTHROPIC_API_KEY=sk-ant-secret", env: ok.env, reason: "y".repeat(200) });
  assert.ok(!line.includes("sk-ant") && !line.includes("frame") && !line.includes("env"));
  assert.equal(JSON.parse(line).sid, "abcdef01");
  // the Worker source never writes a key anywhere: no storage of frames, no console of frame data
  const src = readFileSync(new URL("../workers/public-shell/src/index.ts", import.meta.url), "utf8");
  assert.ok(!/setEnvVars/.test(src), "keys must go through the terminal launch env only");
  assert.ok(!/console\.log\((?!logLine)/.test(src), "only logLine may be logged");
  assert.ok(!/storage\.put\([^)]*(keys|frame|hello)/i.test(src));
});

test("protected env names are never forwarded into the container", () => {
  for (const n of ["SESSION_SIGNING_KEY", "TURNSTILE_SECRET_KEY", "RABBIT_CLOUDSHELL_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "CLOUDFLARE_API_TOKEN", "MY_SECRET", "GITHUB_TOKEN",
    "PUBLIC_SHELL_ENABLED", "AWS_ACCESS_KEY_ID", "CF_ACCOUNT_ID", "WRANGLER_TOKEN"]) assert.equal(isProtectedEnvName(n), true, n);
  assert.equal(isProtectedEnvName("ANTHROPIC_API_KEY"), false);
  const forced = terminalEnv({ ANTHROPIC_API_KEY: "sk-ant-synthetic-key-0001", SUPABASE_SERVICE_ROLE_KEY: "leak", FOO_TOKEN: "leak", SESSION_SIGNING_KEY: "leak" });
  assert.deepEqual(Object.keys(forced).filter((k) => !(k in baseEnv())), ["ANTHROPIC_API_KEY"]);
  for (const k of Object.keys(baseEnv())) assert.equal(isProtectedEnvName(k), false, k);
  assert.ok(!Object.keys(baseEnv()).some((k) => /KEY|TOKEN|SECRET/.test(k)));
  assert.equal(baseEnv.length, 0, "baseEnv takes no Worker env");
});

test("frames: oversized, binary, malformed and out-of-order frames are rejected; valid ones parse", () => {
  const hello = JSON.stringify({ t: "hello", cols: 80, rows: 24, keys: { ANTHROPIC_API_KEY: "sk-ant-synthetic-key-0001" } });
  assert.equal(parseClientFrame(hello, { first: true }).ok, true);
  assert.equal(parseClientFrame(JSON.stringify({ t: "i", d: "ls" }), { first: true }).ok, false);          // must start with hello
  assert.equal(parseClientFrame(JSON.stringify({ t: "i", d: "x".repeat(LIMITS.maxFrameBytes) }), { first: false }).close, 1009);
  assert.equal(parseClientFrame(JSON.stringify({ t: "hello", cols: 80, rows: 24, pad: "x".repeat(LIMITS.maxHelloBytes) }), { first: true }).close, 1009);
  assert.equal(parseClientFrame(new Uint8Array(4), { first: false }).close, 1003);
  assert.equal(parseClientFrame("{not json", { first: false }).ok, false);
  for (const bad of ["[]", "null", "5", JSON.stringify({ t: "zzz" }), JSON.stringify({ t: "i", d: "" }), JSON.stringify({ t: "i", d: "a\0b" }), JSON.stringify({ t: "i", d: 5 }),
    JSON.stringify({ t: "r", cols: 5, rows: 24 }), JSON.stringify({ t: "r", cols: 80, rows: 9999 }), JSON.stringify({ t: "r", cols: 80.5, rows: 24 })]) {
    assert.equal(parseClientFrame(bad, { first: false }).ok, false, bad);
  }
  assert.deepEqual(parseClientFrame(JSON.stringify({ t: "r", cols: 100, rows: 30 }), { first: false }).frame, { t: "r", cols: 100, rows: 30 });
  assert.equal(countCommands("ls\rpwd\r\nfoo"), 3);
  const budget = { windowStart: T0, used: 0 };
  assert.equal(inputBudget(budget, LIMITS.maxInputBytesPerSecond, T0), true);
  assert.equal(inputBudget(budget, 1, T0 + 500), false);
  assert.equal(inputBudget(budget, 1, T0 + 1000), true);
});

test("wrangler config has no owner bindings or secrets and defaults the kill switch to off", () => {
  const raw = readFileSync(new URL("../workers/public-shell/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(config.vars.PUBLIC_SHELL_ENABLED, "false");
  assert.deepEqual(config.secrets.required.sort(), ["SESSION_SIGNING_KEY", "TURNSTILE_SECRET_KEY"]);
  assert.ok(!/supabase|vault|service_role|RABBIT_CLOUD|deploy/i.test(JSON.stringify({ ...config, name: undefined })));
  assert.deepEqual(config.durable_objects.bindings.map((b) => b.name).sort(), ["GATE", "SANDBOX"]);
  assert.notEqual(config.name, "rabbitsoftware-cloudshell");
  assert.equal(config.containers[0].max_instances, LIMITS.maxGlobalSessions);
  const docker = readFileSync(new URL("../workers/public-shell/Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /0\.13\.0-next\.776\.1/);
  assert.ok(!/COPY[^\n]*(\.env|\.claude|vault)/i.test(docker));
});

test("copilot: egress allows only the documented Copilot hosts and paths", () => {
  assert.equal(egressDecision("https://api.githubcopilot.com/chat/completions", "POST").allow, true);
  assert.equal(egressDecision("https://api.github.com/copilot_internal/v2/token").allow, true);
  assert.equal(egressDecision("https://api.github.com/user").allow, true);
  assert.equal(egressDecision("https://github.com/login/device/code", "POST").allow, true);
  assert.equal(egressDecision("https://github.com/login/oauth/access_token", "POST").allow, true);
  for (const [url, method] of [["https://api.github.com/repos/a/b/issues", "GET"], ["https://api.github.com/user", "POST"], ["https://api.github.com/copilot_internal/x", "POST"],
    ["https://github.com/a/b/issues", "POST"], ["https://github.com/login/device/code", "PUT"], ["https://evil.githubcopilot.com/", "GET"],
    ["https://githubcopilot.com.evil.example/", "GET"], ["https://copilot-telemetry.githubusercontent.com/telemetry", "POST"]]) {
    assert.equal(egressDecision(url, method).allow, false, `${method} ${url}`);
  }
  assert.ok(EGRESS_HOSTS.every((h) => !h.includes("*")));
});

test("copilot: COPILOT_GITHUB_TOKEN is accepted only as a visitor key, injected into the launch env only, never logged", () => {
  const token = "github_pat_synthetic_0123456789abcdef";
  const ok = buildKeyEnv({ COPILOT_GITHUB_TOKEN: token });
  assert.deepEqual(ok, { ok: true, env: { COPILOT_GITHUB_TOKEN: token } });
  assert.equal(isProtectedEnvName("COPILOT_GITHUB_TOKEN"), false);
  for (const n of ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_TOKEN", "NPM_TOKEN"]) {
    assert.equal(buildKeyEnv({ [n]: token }).ok, false, n);
    assert.equal(terminalEnv({ [n]: token })[n], undefined, n);
  }
  assert.equal(buildKeyEnv({ COPILOT_GITHUB_TOKEN: "short" }).ok, false);
  assert.equal(terminalEnv(ok.env).COPILOT_GITHUB_TOKEN, token);
  assert.equal("COPILOT_GITHUB_TOKEN" in baseEnv(), false, "not in the fixed base env");
  assert.equal("COPILOT_GITHUB_TOKEN" in terminalEnv({}), false, "per-session only");
  assert.ok(!logLine({ event: "hello", env: ok.env, COPILOT_GITHUB_TOKEN: token }).includes("github_pat"));
  const src = readFileSync(new URL("../workers/public-shell/src/index.ts", import.meta.url), "utf8");
  assert.ok(!/COPILOT_GITHUB_TOKEN/.test(src), "the Worker never names or stores the token");
});

test("image: pins the Copilot CLI, checks Node 22+, ships help-rabbit", () => {
  const docker = readFileSync(new URL("../workers/public-shell/Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /ARG COPILOT_CLI_VERSION=\d+\.\d+\.\d+\n/);
  assert.match(docker, /"@github\/copilot@\$\{COPILOT_CLI_VERSION\}"/);
  assert.match(docker, />= 22/);
  assert.match(docker, /container\/help-rabbit/);
  assert.match(readFileSync(new URL("../workers/public-shell/container/motd", import.meta.url), "utf8"), /help-rabbit/);
  assert.match(readFileSync(new URL("../workers/public-shell/container/help-rabbit", import.meta.url), "utf8"), /COPILOT_GITHUB_TOKEN/);
});

const ps = (f) => readFileSync(new URL(`../workers/public-shell/${f}`, import.meta.url), "utf8");

test("PowerShell: official release tarball is pinned with a SHA256 checked in the build (or flagged TODO), bash stays the login shell", () => {
  const docker = ps("Dockerfile");
  const ver = docker.match(/^ARG POWERSHELL_VERSION=(\d+\.\d+\.\d+)$/m);
  const sum = docker.match(/^ARG POWERSHELL_SHA256=([0-9a-f]{64})$/m);
  if (ver && sum) {
    assert.match(docker, /github\.com\/PowerShell\/PowerShell\/releases\/download\/v\$\{POWERSHELL_VERSION\}\/powershell-\$\{POWERSHELL_VERSION\}-linux-x64\.tar\.gz/);
    assert.match(docker, /sha256sum -c -/);
    assert.match(docker, /\$\{POWERSHELL_SHA256\}/);
  } else {
    assert.match(docker, /TODO[^\n]*PowerShell/i, "no pinned version and checksum, so a TODO must flag it");
    assert.doesNotMatch(docker, /powershell-.*linux-x64/, "never download PowerShell without a verified checksum");
  }
  assert.match(docker, /useradd[^\n]*--shell \/bin\/bash[^\n]*visitor/);
  assert.doesNotMatch(docker, /--shell [^\n]*pwsh/);
  assert.match(docker, /chmod 0755[^\n]*\/usr\/local\/bin\/pwsh/);
  const launcher = ps("container/pwsh");
  assert.match(launcher, /exec \/opt\/microsoft\/powershell\/7\/pwsh "\$@"/);
});

test("image has no scanner, ICMP or DNS-probing packages", () => {
  const docker = ps("Dockerfile").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(docker, /\b(nmap|masscan|zmap|netcat|ncat|nc|socat|traceroute|mtr|tcpdump|hping3?|iputils-ping|iputils|ping|dnsutils|bind9-dnsutils|bind9-host|dig|nslookup|whois|arp-scan|nikto|hydra|sqlmap|metasploit|wireshark|tshark|iproute2|net-tools)\b/i);
});

test("rabbit-net: HTTPS HEAD to the allowlisted hosts only, no raw-socket or scanning tools, host list equals the egress list", () => {
  const src = ps("container/rabbit-net");
  // Drop comments, the usage heredoc and quoted message text (they may name the absent tools); what is left is the executable code.
  const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").replace(/<<'USAGE'[\s\S]*?\nUSAGE\n/, "").replace(/"[^"\n]*"/g, '""');
  assert.match(src, /curl --head/);
  assert.match(src, /--max-time 5/);
  assert.doesNotMatch(code, /\b(nmap|masscan|nc|ncat|netcat|socat|ping|traceroute|tracepath|mtr|dig|nslookup|telnet|hping3?|arp-scan)\b|\/dev\/tcp|\/dev\/udp/);
  const hosts = src.match(/^HOSTS="([^"]+)"/m)[1].split(/\s+/);
  assert.deepEqual([...hosts].sort(), [...EGRESS_HOSTS].sort());
  for (const h of hosts) assert.ok(!/^\d+\.\d+\.\d+\.\d+$/.test(h));
  assert.match(src, /rabbit-net status/);
  assert.match(src, /rabbit-net check/);
  assert.match(ps("Dockerfile"), /COPY container\/rabbit-net \/usr\/local\/bin\/rabbit-net/);
});

test("motd, help-rabbit and README mention pwsh, rabbit-net and why scanners are absent", () => {
  assert.match(ps("container/motd"), /pwsh/);
  assert.match(ps("container/motd"), /rabbit-net/);
  const help = ps("container/help-rabbit");
  assert.match(help, /rabbit-net check/);
  assert.match(help, /Not installed on purpose/);
  assert.match(ps("README.md"), /ICMP/);
});
