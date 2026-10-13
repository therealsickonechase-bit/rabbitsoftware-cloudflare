import { open, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { safePath } from "./vault-agent-sync.mjs";
import { digest } from "../workers/vault-agent/src/protocol.mjs";
import { callCloudAccess } from "../tools/vault-agent/cloud-access.mjs";
import { persistRunReport } from "../tools/vault-agent/run-report.mjs";

export async function main(args, transport) {
  const options = {};
  const flags = ["--status", "--list", "--approve-allowed"];
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--vault", "--request", "--status", "--list", "--approve", "--deny", "--revoke", "--approve-allowed", "--shell", "--submit", "--job-status", "--job-result"].includes(key)
        || Object.hasOwn(options, key)) throw new Error("Use --vault PATH and exactly one cloud-access action.");
    if (flags.includes(key)) options[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${key} requires a value.`);
      options[key] = args[++index];
    }
  }
  const actions = Object.keys(options).filter(key => key !== "--vault");
  if (!options["--vault"] || actions.length !== 1) throw new Error("Use --vault PATH and one action; --shell/--submit take consented JSON files.");
  const vault = await realpath(resolve(options["--vault"]));
  const action = actions[0].slice(2);
  const id = crypto.randomUUID(), relative = `Cloud Agents/Results/cloud-access-${id}.json`;
  const path = await safePath(vault, relative, true);
  const folder = resolve(path, "..");
  if ((await readdir(folder)).filter(name => /^cloud-access-.*\.json$/.test(name)).length >= 128) {
    throw new Error("Cloud access report capacity128 reached; explicitly archive reviewed reports before running more actions.");
  }
  const report = { version: 1, id, action, share: false, started: new Date().toISOString(), status: "running",
    correctness: "unverified", independentAudit: false, calls: [] };
  await persistRunReport(path, report, true);
  const call = async (operation, input, config) => {
    const entry = { action: operation, inputHash: await digest(JSON.stringify(input ?? {})), status: "running" };
    report.calls.push(entry);
    await persistRunReport(path, report);
    const result = await callCloudAccess(operation, input, config, transport);
    entry.status = "completed";
    return result;
  };
  try {
    const config = {
      appUrl: process.env.RABBIT_CLOUD_TOOLS_URL,
      agentToken: process.env.CLOUD_TOOLS_AGENT_TOKEN,
      brokerUrl: process.env.RABBIT_CLOUDSHELL_URL,
      approvalToken: process.env.RABBIT_AGENT_APPROVAL_TOKEN,
      accessClientId: process.env.CF_ACCESS_CLIENT_ID,
      accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
      ...(process.env.CLOUD_TOOLS_PROXY_URL ? { proxy: { url: process.env.CLOUD_TOOLS_PROXY_URL,
        ...(process.env.CLOUD_TOOLS_PROXY_TOKEN_ENV ? { tokenEnv: process.env.CLOUD_TOOLS_PROXY_TOKEN_ENV } : {}) } } : {}),
    };
    let input;
    if (["shell", "submit"].includes(action)) {
      const file = await open(resolve(options[`--${action}`]), "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 70000) throw new Error("Cloud action input must be a regular file up to 70000 bytes.");
        const bytes = Buffer.alloc(70001);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 70000) throw new Error("Cloud action input exceeds 70000 bytes.");
        input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      } finally { await file.close(); }
    } else if (action === "request") input = { scopes: options["--request"].split(",") };
    else if (!["status", "list", "approve-allowed"].includes(action)) input = { id: options[`--${action}`] };
    if (action === "approve-allowed") {
      const queue = await call("list", undefined, config);
      const approved = [];
      for (const request of queue.requests.slice(0, 16)) {
        const result = await call("approve", { id: request.id }, config);
        approved.push({ id: result.id, expiresAt: result.expiresAt });
      }
      report.result = { approved, remaining: Math.max(0, queue.requests.length - 16) };
    } else report.result = await call(action, input, config);
    report.status = "completed";
  } catch (error) {
    report.status = "failed";
    report.errorType = error instanceof Error ? error.name : "Error";
    const running = report.calls.find(call => call.status === "running");
    if (running) running.status = "failed";
    throw error;
  } finally {
    report.finished = new Date().toISOString();
    await persistRunReport(path, report);
    console.log(JSON.stringify({ report: relative, status: report.status }));
  }
  console.log(JSON.stringify(report.result, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
