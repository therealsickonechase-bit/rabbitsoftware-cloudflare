import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { access, realpath } from "node:fs/promises";
import { execute, createTools, approveLearning, loadConfig } from "../tools/vault-agent/runtime.mjs";
import { collect, safePath, writeOnce, endpoint, main as sync } from "./vault-agent-sync.mjs";
import { checkCredentials, digest, normalizeJob } from "../workers/vault-agent/src/protocol.mjs";

export async function main(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--vault", "--task", "--search", "--read", "--config", "--approve-learning", "--require-cloud-status"].includes(args[index]) || !args[index + 1]) {
      throw new Error("Use --vault PATH with one of --task TEXT, --search TERMS, --read PATH, or --approve-learning PROPOSAL. Optional --config ignored-local-config.json.");
    }
    values[args[index].slice(2)] = args[index + 1];
  }
  if (!values.vault) throw new Error("Supply --vault PATH.");
  if (values["require-cloud-status"] !== undefined && (values["require-cloud-status"] !== "true" || !values.task)) {
    throw new Error("--require-cloud-status true is only valid for a local task.");
  }
  if (["task", "search", "read", "approve-learning"].filter(key => values[key]).length !== 1) throw new Error("Choose exactly one action.");
  if (values.task === "@stdin") {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 4000) throw new Error("Task exceeds 4000 bytes.");
      chunks.push(chunk);
    }
    values.task = Buffer.concat(chunks).toString("utf8");
  }
  const vault = resolve(values.vault);
  if (values["approve-learning"]) {
    console.log(await approveLearning(vault, values["approve-learning"]));
  } else if (values.search || values.read) {
    const { tools } = createTools(vault, false, crypto.randomUUID());
    console.log(JSON.stringify(await (values.search ? tools.search.execute({ query: values.search }) : tools.read.execute({ path: values.read })), null, 2));
  } else {
    // Default to the vault's hosted provider config when present; --config or --require-cloud-status keep the explicit/Ollama path.
    const defaultConfig = join(vault, ".obsidian", "plugins", "rabbit-vault-agent", "local-provider.json");
    const useDefault = !values.config && !values["require-cloud-status"] && await access(defaultConfig).then(() => true, () => false);
    const config = await loadConfig(values.config ?? (useDefault ? defaultConfig : undefined));
    if (values["require-cloud-status"]) {
      if (config.type !== "ollama" || config.cloudAccess?.allowRemote !== true || !config.cloudAccess.actions?.includes("status")) {
        throw new Error("A required cloud status call needs explicitly enabled local caller tools.");
      }
      config.requiredCalls = [...(config.requiredCalls ?? []), { name: "cloud_access", arguments: { action: "status", input: {} } }];
      config.cloudStatusOnly = true;
    }
    if (config.type === "cloudflare-jobs") {
      if (config.allowRemote !== true) throw new Error("Cloud job submission requires explicit allowRemote approval.");
      checkCredentials(values.task);
      const { notes } = await collect(vault);
      if (!notes.length) throw new Error("Opt in at least one non-private knowledge note before submitting cloud work.");
      normalizeJob({ mode: "task", instruction: values.task, notes });
      endpoint(config.url);
      if (typeof config.token !== "string" || config.token.length < 32) throw new Error("Configure a local cloud token of at least 32 characters.");
      const taskPath = `Cloud Agents/Inbox/Submitted-${await digest(values.task)}.md`;
      await writeOnce(await safePath(vault, taskPath, true), `---\ncloud-agent-share: true\ncloud-agent-mode: task\n---\n${values.task}\n`);
      const previous = { url: process.env.VAULT_AGENT_URL, token: process.env.VAULT_AGENT_TOKEN };
      try {
        process.env.VAULT_AGENT_URL = config.url;
        process.env.VAULT_AGENT_TOKEN = config.token;
        await sync(["--vault", vault, "--sync", "--allow-upload"]);
      } finally {
        if (previous.url === undefined) delete process.env.VAULT_AGENT_URL; else process.env.VAULT_AGENT_URL = previous.url;
        if (previous.token === undefined) delete process.env.VAULT_AGENT_TOKEN; else process.env.VAULT_AGENT_TOKEN = previous.token;
      }
      console.log(JSON.stringify({ submitted: true, task: taskPath }));
      return;
    }
    const result = await execute(vault, values.task, config);
    console.log(JSON.stringify({ result: result.path, report: result.report, staged: result.staged, toolCalls: result.trace.length }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
