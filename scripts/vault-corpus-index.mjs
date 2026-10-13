// Build the agent's vector corpus: public vault notes, the public research corpus and repository Markdown docs.
// Chunks are embedded and stored by the vault agent Worker (POST /v1/corpus/upsert); only changed chunks are sent.
//
//   node scripts/vault-corpus-index.mjs --plan                 # count chunks, no network
//   node scripts/vault-corpus-index.mjs --apply                # upload changes, delete removed chunks
//
// Options: --vault PATH, --repos PATH[,PATH], --config PATH (provider JSON with url + tokenFile; default: the
// plugin's local-provider.json). State: .wrangler/vault-corpus/manifest.json (Git-ignored).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkCredentials, field } from "../workers/vault-agent/src/protocol.mjs";
import { loadConfig } from "../tools/vault-agent/runtime.mjs";
import { postJson, serviceOrigin } from "../tools/vault-agent/corpus.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHUNK = 1800;
// Agent output, machine state, and the linked folders that are copies of material indexed elsewhere:
// the vault's full sync publishes GitHub Live/Imports, Code/ and the cloud-drive mirrors, which would
// otherwise put every repository doc and every note into the corpus two or three times over.
const SKIP_VAULT = /^(Cloud Agents\/(Results|Proposals|Coordination|Dispatchers|Network)\/|\.obsidian\/|\.trash\/|GitHub (Live|Imports)\/|Code\/|Computer\/|Repos\/|Drive\/|OneDrive\/|Claude\/|[^/]* library\/)/;
const SKIP_REPO = /(^|\/)(node_modules|\.next|\.wrangler|dist|build|vendor|backup|private-cloud-data)\//;

export function chunkMarkdown(text, max = CHUNK) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/\r\n/g, "\n").trim();
  const chunks = [];
  let current = "";
  for (const block of body.split(/\n(?=#{1,6} )|\n{2,}/)) {
    const piece = block.trim();
    if (!piece) continue;
    if (current && current.length + piece.length + 2 > max) { chunks.push(current); current = ""; }
    if (piece.length > max) {
      for (let at = 0; at < piece.length; at += max) chunks.push(piece.slice(at, at + max));
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

export const chunkId = (source, path, index) => createHash("sha256").update(`${source}\0${path}\0${index}`).digest("hex");
const hash = text => createHash("sha256").update(text).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export function documentChunks(source, path, text, extra = {}) {
  const title = extra.title ?? /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").at(-1).replace(/\.md$/, "");
  return chunkMarkdown(text).map((piece, index) => {
    try { checkCredentials(piece); } catch { return null; }
    return { id: chunkId(source, path, index), source, path: path.slice(0, 300), title: title.slice(0, 300), ...(extra.url ? { url: extra.url } : {}), text: piece };
  }).filter(Boolean);
}

async function vaultChunks(vault) {
  git(vault, "fetch", "-q", "origin");
  // Only what the vault already publishes: the files in its public GitHub branch.
  const files = git(vault, "ls-tree", "-r", "--name-only", "origin/main").split("\n").filter(path => path.endsWith(".md") && !SKIP_VAULT.test(path));
  const chunks = [];
  for (const path of files) {
    const text = git(vault, "show", `origin/main:${path}`);
    if (/^---\r?\n[\s\S]*?^cloud-agent-share:\s*false\s*$/m.test(text.split(/\r?\n---/)[0] + "\n")) continue;
    chunks.push(...documentChunks("vault", path, text));
  }
  return chunks;
}

async function corpusChunks() {
  const corpus = JSON.parse(await readFile(join(root, "site", "assets", "public-corpus.json"), "utf8"));
  return corpus.records.flatMap(record => documentChunks("corpus", `${record.source}/${record.external_id}`,
    `${record.title}\n\nSource: ${record.source}; published ${record.published_at ?? "unknown"}.`,
    { title: record.title, url: record.source_url }));
}

async function repoChunks(repos) {
  const chunks = [];
  for (const repo of repos) {
    const name = repo.split(/[\\/]/).filter(Boolean).at(-1);
    for (const path of git(repo, "ls-files", "*.md").split("\n").filter(Boolean)) {
      if (SKIP_REPO.test(path) || path.startsWith("site/development.md")) continue;
      chunks.push(...documentChunks("repo", `${name}/${path}`, await readFile(join(repo, path), "utf8")));
    }
  }
  return chunks;
}

async function main() {
  const { values } = parseArgs({ options: {
    plan: { type: "boolean" }, apply: { type: "boolean" },
    vault: { type: "string", default: join(homedir(), "Documents", "RabbitOS Vault") },
    repos: { type: "string", default: ["rabbit-web", "rabbitsoftware-cloudflare", "research-agents"].map(name => join(homedir(), "Projects", name)).join(",") },
    config: { type: "string" },
  } });
  if (values.plan === values.apply) throw new Error("Choose --plan or --apply.");
  const chunks = [...await vaultChunks(values.vault), ...await corpusChunks(), ...await repoChunks(values.repos.split(",").filter(Boolean))];
  const ids = new Set();
  for (const chunk of chunks) { if (ids.has(chunk.id)) throw new Error(`Duplicate chunk ${chunk.path}`); ids.add(chunk.id); }
  const statePath = join(root, ".wrangler", "vault-corpus", "manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const changed = chunks.filter(chunk => manifest[chunk.id] !== hash(JSON.stringify(chunk)));
  const removed = Object.keys(manifest).filter(id => !ids.has(id));
  const counts = Object.fromEntries(["vault", "corpus", "repo"].map(source => [source, chunks.filter(chunk => chunk.source === source).length]));
  console.log(JSON.stringify({ action: values.plan ? "plan" : "apply", chunks: chunks.length, bySource: counts, changed: changed.length, removed: removed.length }));
  if (values.plan) return;
  const config = await loadConfig(values.config ?? join(values.vault, ".obsidian", "plugins", "rabbit-vault-agent", "local-provider.json"));
  if (!config.corpus?.token) throw new Error("The provider config needs a corpus section with a token source.");
  const origin = serviceOrigin(config.corpus.url);
  await mkdir(dirname(statePath), { recursive: true });
  const save = async () => { await writeFile(`${statePath}.tmp`, JSON.stringify(manifest)); await rename(`${statePath}.tmp`, statePath); };
  for (let at = 0; at < changed.length; at += 25) {
    const batch = changed.slice(at, at + 25);
    await postJson(origin, "/v1/corpus/upsert", config.corpus.token, { chunks: batch });
    for (const chunk of batch) manifest[chunk.id] = hash(JSON.stringify(chunk));
    await save();
    process.stdout.write(`\rindexed ${Math.min(at + 25, changed.length)}/${changed.length}`);
  }
  for (let at = 0; at < removed.length; at += 100) {
    const batch = removed.slice(at, at + 100);
    await postJson(origin, "/v1/corpus/delete", config.corpus.token, { ids: batch });
    for (const id of batch) delete manifest[id];
    await save();
  }
  console.log(`\ndone: ${changed.length} chunks indexed, ${removed.length} removed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
