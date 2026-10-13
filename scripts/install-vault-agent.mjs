import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safePath } from "./vault-agent-sync.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 4 || process.argv[2] !== "--vault") throw new Error("Use --vault PATH.");
const vault = resolve(process.argv[3]);
const directory = await safePath(vault, ".obsidian/plugins/rabbit-vault-agent", true);
await mkdir(directory, { recursive: true });
await copyFile(join(repository, "tools", "vault-agent", "plugin.js"), join(directory, "main.js"));
await copyFile(join(repository, "tools", "vault-agent", "manifest.json"), join(directory, "manifest.json"));
console.log("Installed Rabbit Vault Agent. Enable it in Obsidian Community plugins; no plugin settings or secrets were changed.");
