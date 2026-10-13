// Keeps the vault agents current without anyone at the keyboard. Run by the "RabbitOS Vault agents" scheduled task.
//   1. Re-index the vector corpus (only changed chunks are sent; see vault-corpus-index.mjs).
//   2. Pull finished cloud job results into the vault (no uploads; submitting stays manual).
// Task queues and dispatchers are NOT run here: each run of those needs an explicit operator decision.
// Log: .wrangler/vault-live.log (last ~200 KB kept).
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vault = process.env.RABBIT_OBSIDIAN_VAULT || join(homedir(), "Documents", "RabbitOS Vault");
const logPath = join(repo, ".wrangler", "vault-live.log");
const LOG_LIMIT = 200 * 1024;

async function log(line) {
  await mkdir(dirname(logPath), { recursive: true });
  try {
    if ((await stat(logPath)).size > LOG_LIMIT) await writeFile(logPath, (await readFile(logPath, "utf8")).slice(-LOG_LIMIT / 2));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await appendFile(logPath, `${new Date().toISOString()} ${line}\n`);
}

function run(name, args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: 20 * 60000, windowsHide: true, shell: false });
  const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 500);
  return { name, ok: result.status === 0, code: result.status ?? result.error?.code, tail };
}

const steps = [run("corpus-index", ["scripts/vault-corpus-index.mjs", "--apply", "--vault", vault])];
const settings = JSON.parse(await readFile(join(vault, ".obsidian", "plugins", "rabbit-vault-agent", "data.json"), "utf8"));
if (settings.provider?.type === "cloudflare-jobs" && settings.provider.url && settings.provider.token) {
  // Same credentials the Obsidian plugin passes for "Pull previously submitted cloud results".
  steps.push(run("pull-results", ["scripts/vault-agent-sync.mjs", "--vault", vault, "--pull"],
    { ...process.env, VAULT_AGENT_URL: settings.provider.url, VAULT_AGENT_TOKEN: settings.provider.token }));
}
for (const step of steps) await log(`${step.name} ${step.ok ? "ok" : `FAILED (${step.code})`}: ${step.tail}`);
process.exitCode = steps.every(step => step.ok) ? 0 : 1;
