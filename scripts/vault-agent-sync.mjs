import { open, lstat, readdir, readFile, mkdir, rename, unlink, writeFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ROOTS, MAX_BYTES, digest, field, shared, noteContent, normalizeJob, modelResult, readJson, validId,
} from "../workers/vault-agent/src/protocol.mjs";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = "Cloud Agents/Inbox";
const RESULTS = "Cloud Agents/Results";

export async function safePath(vault, relative, createParents = false) {
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) {
    throw new Error("Unsafe local vault path.");
  }
  let current = vault;
  if ((await lstat(current)).isSymbolicLink()) throw new Error("Vault root cannot be a link.");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing linked path: ${relative}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (createParents && index < parts.length - 1) await mkdir(current);
      else if (index < parts.length - 1) throw error;
    }
  }
  return current;
}

async function scan(vault, folder) {
  const directory = await safePath(vault, folder);
  const notes = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = `${folder}/${entry.name}`;
    const local = await safePath(vault, path);
    if (entry.isDirectory()) notes.push(...await scan(vault, path));
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const handle = await open(local, "r");
      let content;
      let oversized;
      try {
        const buffer = Buffer.alloc(16001);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        content = buffer.subarray(0, bytesRead).toString("utf8");
        oversized = (await handle.stat()).size > 16000;
      } finally {
        await handle.close();
      }
      if (!shared(content)) continue;
      if (oversized) throw new Error(`Opted-in note exceeds 16000 bytes: ${path}`);
      notes.push({ path, content: noteContent(content) });
    }
  }
  return notes;
}

export async function collect(vault) {
  const notes = [];
  for (const root of ROOTS) notes.push(...await scan(vault, root.slice(0, -1)));
  const tasks = [];
  for (const note of await scan(vault, INBOX)) {
    const mode = field(note.content, "cloud-agent-mode");
    const instruction = note.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    const job = normalizeJob({ mode, instruction, notes });
    tasks.push({ path: note.path, fingerprint: await digest(note.content), job });
  }
  return { notes, tasks };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function writeOnce(path, content) {
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error(`Refusing to overwrite edited output: ${path}`);
  }
}

export async function saveResult(vault, state, id, raw) {
  validId(id);
  const entry = state.jobs[id];
  if (!entry || raw.id !== id || raw.mode !== entry.job.mode) throw new Error("Result does not match a known local job.");
  const result = await modelResult({ response: JSON.stringify(raw) }, entry.job, id);
  for (const edit of result.edits) {
    const received = raw.edits.find(item => item.path === edit.path);
    if (received.baseHash !== edit.baseHash) throw new Error("Edit base hash does not match the submitted snapshot.");
  }
  const markdown = `# Cloud agent result\n\nJob: ${id}\nMode: ${result.mode}\n\n${result.answer}\n\n## Proposed edits\n\n${result.edits.length ? result.edits.map(edit => `- ${edit.path} (review the companion JSON before applying)`).join("\n") : "None."}\n`;
  await writeOnce(await safePath(vault, `${RESULTS}/${id}.json`, true), JSON.stringify(result, null, 2));
  await writeOnce(await safePath(vault, `${RESULTS}/${id}.md`, true), markdown);
  entry.received = true;
  return result;
}

export async function applyResult(vault, state, id) {
  validId(id);
  const entry = state.jobs[id];
  if (!entry?.received) throw new Error("Download and review this job's result before applying it.");
  const path = await safePath(vault, `${RESULTS}/${id}.json`);
  if ((await lstat(path)).size > MAX_BYTES) throw new Error("Result exceeds 64 KiB.");
  const raw = JSON.parse(await readFile(path, "utf8"));
  const result = await saveResult(vault, state, id, raw);
  const changes = [];
  for (const edit of result.edits) {
    const local = await safePath(vault, edit.path);
    const source = await readFile(local, "utf8");
    const currentHash = await digest(source);
    if (currentHash === await digest(edit.content)) continue;
    if (currentHash !== edit.baseHash) throw new Error(`Note changed after submission; refusing edit: ${edit.path}`);
    changes.push({ ...edit, local, source });
  }
  // Validate every proposal before touching originals; preserve recoverable copies.
  for (const change of changes) {
    await writeOnce(await safePath(vault, `Cloud Agents/Backups/${id}/${await digest(change.path)}.md`, true), change.source);
  }
  for (const change of changes) {
    if (await digest(await readFile(change.local, "utf8")) !== change.baseHash) {
      throw new Error(`Note changed during approval; refusing edit: ${change.path}`);
    }
    const temporary = `${change.local}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, change.content, { flag: "wx" });
    try {
      await rename(temporary, change.local);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
  entry.applied = true;
  return changes.length;
}

export function endpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an HTTPS Worker origin, or HTTP loopback for local testing.");
  }
  return url.origin;
}

function options(args) {
  const values = { action: "plan" };
  const actions = new Set(["--plan", "--sync", "--pull", "--apply"]);
  let actionCount = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (actions.has(arg)) {
      if (++actionCount > 1) throw new Error("Choose exactly one action.");
      values.action = arg.slice(2);
      if (arg === "--apply") values.id = validId(args[++index]);
    } else if (arg === "--vault") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--vault needs a path.");
      values.vault = resolve(args[++index]);
    } else if (arg === "--allow-upload") values.allowUpload = true;
    else if (arg === "--approve-edits") values.approveEdits = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!values.vault) throw new Error("Supply --vault with your vault root.");
  return values;
}

export async function main(args) {
  const config = options(args);
  if (config.action === "plan") {
    const { notes, tasks } = await collect(config.vault);
    console.log(JSON.stringify({ action: "plan", uploaded: false, notes: notes.map(note => note.path), tasks: tasks.map(task => ({ path: task.path, mode: task.job.mode })) }, null, 2));
    return;
  }
  if (config.action === "sync" && !config.allowUpload) throw new Error("--sync requires --allow-upload after reviewing --plan.");
  if (config.action === "apply" && !config.approveEdits) throw new Error("--apply requires --approve-edits after reviewing the result JSON.");
  const origin = endpoint(process.env.VAULT_AGENT_URL);
  const stateDirectory = join(REPOSITORY, ".wrangler", "vault-agent-sync", await digest(`${config.vault.toLowerCase()}|${origin}`));
  await mkdir(stateDirectory, { recursive: true });
  const lockPath = join(stateDirectory, "sync.lock");
  const lock = await open(lockPath, "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error("Another connector is running, or a stale sync.lock needs inspection.");
    throw error;
  });
  try {
    const statePath = join(stateDirectory, "state.json");
    let state;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { jobs: {}, tasks: {} };
    }
    if (config.action === "apply") {
      console.log(`Applied ${await applyResult(config.vault, state, config.id)} approved edits.`);
      await atomicJson(statePath, state);
      return;
    }
    const token = process.env.VAULT_AGENT_TOKEN;
    if (typeof token !== "string" || token.length < 32) throw new Error("Set VAULT_AGENT_TOKEN locally (at least 32 characters).");
    const request = async (path, body) => {
      const response = await fetch(`${origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(`Worker HTTP ${response.status}: ${data.error || "Operation failed."}`);
      return data;
    };
    if (config.action === "sync") {
      const { tasks } = await collect(config.vault);
      const activeIds = new Set();
      for (const task of tasks) {
        const id = await digest(JSON.stringify(task.job));
        const previous = state.tasks[task.path];
        if (previous?.fingerprint === task.fingerprint && state.jobs[previous.id]?.submitted) {
          activeIds.add(previous.id);
          continue;
        }
        activeIds.add(id);
        state.jobs[id] ??= { job: task.job, submitted: false, received: false };
        state.tasks[task.path] = { fingerprint: task.fingerprint, id };
        await atomicJson(statePath, state);
      }
      for (const [id, entry] of Object.entries(state.jobs)) {
        if (entry.submitted) continue;
        if (!activeIds.has(id)) {
          console.log(`Not uploading superseded or revoked pending job ${id}.`);
          continue;
        }
        const response = await request("/jobs", entry.job);
        if (response.id !== id) throw new Error("Worker returned an unexpected job ID.");
        entry.submitted = true;
        await atomicJson(statePath, state);
        console.log(`Submitted job ${id} (${entry.job.mode}).`);
      }
    }
    const failures = [];
    for (const [id, entry] of Object.entries(state.jobs)) {
      if (!entry.submitted || entry.received) continue;
      const status = await request(`/jobs/${id}`);
      if (status.id !== id) throw new Error("Worker returned an unexpected status ID.");
      console.log(`Job ${id}: ${status.status}`);
      if (["errored", "terminated", "unknown"].includes(status.status)) failures.push(id);
      else if (status.status === "complete") {
        await saveResult(config.vault, state, id, await request(`/jobs/${id}/result`));
        await atomicJson(statePath, state);
      }
    }
    if (failures.length) throw new Error(`Jobs did not complete: ${failures.join(", ")}. Inspect authenticated job status; change the task text to submit a new revision.`);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
