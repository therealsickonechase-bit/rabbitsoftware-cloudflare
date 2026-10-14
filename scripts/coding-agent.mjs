// Confirm-then-run coding agent. Every command needs a human "y" on the terminal; there is no auto-confirm option.
import { createInterface } from "node:readline/promises";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { callCloudAccess } from "../tools/vault-agent/cloud-access.mjs";
import { createProvider, parseArgs, runAgent } from "./lib/coding-agent.mjs";

export async function main(args, env = process.env, io = {}) {
  const options = parseArgs(args);
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) throw new Error("Refusing to run non-interactively: every command needs a human y on a terminal.");
  const provider = io.provider ?? createProvider(env);
  const rl = io.ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = io.ask ?? (question => rl.question(question));
  try {
    const task = options.task ?? (await ask("Task: ")).trim();
    const config = {
      appUrl: env.RABBIT_CLOUD_TOOLS_URL, agentToken: env.CLOUD_TOOLS_AGENT_TOKEN,
      accessClientId: env.CF_ACCESS_CLIENT_ID, accessClientSecret: env.CF_ACCESS_CLIENT_SECRET,
      ...(env.CLOUD_TOOLS_PROXY_URL ? { proxy: { url: env.CLOUD_TOOLS_PROXY_URL,
        ...(env.CLOUD_TOOLS_PROXY_TOKEN_ENV ? { tokenEnv: env.CLOUD_TOOLS_PROXY_TOKEN_ENV } : {}) } } : {}),
    };
    // One call per consented command: redirect "error" and no retry live in callCloudAccess.
    const shell = io.shell ?? (input => callCloudAccess("shell", input, config));
    const secretValues = [env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY, env.CLOUD_TOOLS_AGENT_TOKEN,
      env.CF_ACCESS_CLIENT_SECRET, env.RABBIT_AGENT_APPROVAL_TOKEN, env.RABBIT_CLOUDSHELL_TOKEN].filter(Boolean);
    return await runAgent({ task, provider, shell, ask, isTTY, reportDir: options.reportDir, secretValues,
      print: io.print ?? console.log });
  } finally { rl?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
