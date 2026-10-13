import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { safePath, writeOnce } from "../../scripts/vault-agent-sync.mjs";
import { relativeFile, chunks } from "./coding-adapter.mjs";
import { adapterName } from "./task-protocol.mjs";
import { digest, checkCredentials } from "../../workers/vault-agent/src/protocol.mjs";

function codingEntry(config, id) {
  adapterName(id);
  const entry = config?.adapters?.find(entry => entry.id === id);
  if (!entry || entry.type !== "coding-local" || !isAbsolute(entry.projectRoot ?? "")
      || !Array.isArray(entry.files) || !Array.isArray(entry.tests)) throw new Error("Select an operator-configured coding-local project for editor inspection.");
  return entry;
}

async function source(root, path) {
  relativeFile(path);
  const file = await open(await safePath(root, path), "r");
  try {
    if ((await file.stat()).size > 1024 * 1024) throw new Error("Editor source exceeds 1 MiB; use approved host editor ranges instead.");
    const bytes = await file.readFile();
    if (bytes.length > 1024 * 1024) throw new Error("Editor source grew beyond 1 MiB.");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\0")) throw new Error("Editor requires UTF-8 source text.");
    checkCredentials(content);
    return { path, hash: await digest(content), bytes: bytes.length, content };
  } finally { await file.close(); }
}

export async function inspectEditor(config, value) {
  if (!value || Object.keys(value).some(key => !["adapter", "path", "cursor"].includes(key))) throw new Error("Editor view accepts only adapter, path and cursor.");
  const { adapter, path, cursor = 0 } = value;
  const entry = codingEntry(config, adapter);
  const file = await source(await realpath(entry.projectRoot), path);
  const pages = chunks(file.content);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= Math.max(1, pages.length)) throw new Error("Use an editor page cursor within the source.");
  const before = pages.slice(0, cursor).join("");
  return { version: 1, adapter, path, hash: file.hash, bytes: file.bytes,
    approvedEditable: entry.files.some(file => file.toLowerCase() === path.toLowerCase()), immutableTest: entry.tests.some(file => file.toLowerCase() === path.toLowerCase()),
    cursor, startLine: 1 + (before.match(/\n/g)?.length ?? 0), content: pages[cursor] ?? "",
    nextCursor: cursor + 1 < pages.length ? cursor + 1 : null, pages: pages.length,
    editable: false, note: "Read-only bounded editor view; apply approved changes through the copied coding runner or host editor." };
}

export async function proposeEditorScope(vault, agent, config, value) {
  adapterName(agent);
  if (!value || Object.keys(value).some(key => !["adapter", "files", "reason"].includes(key))) throw new Error("Scope proposals accept only adapter, files and reason.");
  const { adapter, files, reason } = value;
  const entry = codingEntry(config, adapter);
  if (!Array.isArray(files) || !files.length || files.length > 20 || new Set(files.map(path => typeof path === "string" ? path.toLowerCase() : path)).size !== files.length
      || typeof reason !== "string" || !reason.trim() || reason.length > 2000) throw new Error("Propose 1-20 unique explicit files and a reason of 1-2000 characters.");
  checkCredentials(reason);
  const root = await realpath(entry.projectRoot);
  const selected = [];
  for (const path of files) {
    relativeFile(path);
    if (entry.tests.some(test => test.toLowerCase() === path.toLowerCase())) throw new Error("Immutable validation tests cannot be proposed as editable source.");
    const file = await source(root, path);
    selected.push({ path, hash: file.hash, bytes: file.bytes, currentlyApproved: entry.files.some(file => file.toLowerCase() === path.toLowerCase()),
      codingLimitExceeded: file.bytes > 65536 });
  }
  const proposal = { version: 1, type: "editor-scope-proposal", agent, adapter, projectRoot: root,
    files: selected, tests: entry.tests, reason: reason.trim(), requiresApproval: true, executable: false };
  const id = await digest(JSON.stringify(proposal));
  const path = `Cloud Agents/Proposals/editor-${id}.json`;
  await writeOnce(await safePath(vault, path, true), JSON.stringify(proposal, null, 2));
  await writeOnce(await safePath(vault, path.replace(".json", ".md"), true),
    `---\ncloud-agent-share: false\n---\n# Editor scope proposal\n\nAgent: ${agent}; adapter: ${adapter}\n\n${proposal.reason}\n\n${selected.map(file => `- ${file.path}: SHA-256 ${file.hash}; ${file.bytes} bytes; currently approved: ${file.currentlyApproved}`).join("\n")}\n\nReview JSON: ${path}\n\nSelection only: no file was edited or permission granted. Review exact paths, trusted tests, byte limits and hashes before changing the operator config; create a new task for the new scope.\n`);
  return { id, path, ...proposal };
}
