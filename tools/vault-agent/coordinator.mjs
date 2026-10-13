import { open, rename, unlink } from "node:fs/promises";
import { safePath } from "../../scripts/vault-agent-sync.mjs";
import { digest } from "../../workers/vault-agent/src/protocol.mjs";
import { LIMITS, taskDefinition, taskId, artifactContent, capabilities } from "./task-protocol.mjs";

const STATE = "Cloud Agents/Coordination/state.json";
const TERMINAL = new Set(["done", "failed", "blocked"]);

async function boundedFile(path) {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > LIMITS.stateBytes) throw new Error("Coordinator state exceeds 8 MiB.");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

export async function withCoordinator(vault, action, statePath = STATE) {
  const path = await safePath(vault, statePath, true);
  const lockPath = await safePath(vault, `${statePath}.lock`);
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Coordinator is locked. If its process crashed, verify it stopped before removing state.json.lock.");
    throw error;
  }
  const temporary = await safePath(vault, `${statePath}.${crypto.randomUUID()}.tmp`);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    let state;
    try { state = await boundedFile(path); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { version: 1, tasks: {}, artifacts: {} };
    }
    await validateState(state);
    const save = async () => {
      await validateState(state);
      const text = JSON.stringify(state);
      if (Buffer.byteLength(text) > LIMITS.stateBytes) throw new Error("Coordinator storage is full; prune completed tasks explicitly.");
      const file = await open(temporary, "wx");
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    };
    return await action(new Coordinator(state, save));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}

async function validateState(state) {
  if (state?.version !== 1 || !state.tasks || !state.artifacts
      || Array.isArray(state.tasks) || Array.isArray(state.artifacts)
      || Object.keys(state.tasks).length > LIMITS.tasks || Object.keys(state.artifacts).length > LIMITS.artifacts) {
    throw new Error("Invalid or unsupported coordinator state; preserve it for recovery.");
  }
  for (const [id, artifact] of Object.entries(state.artifacts)) {
    taskId(id);
    if (await digest(artifactContent(artifact.content)) !== id || typeof artifact.share !== "boolean") throw new Error("Artifact integrity check failed.");
  }
  for (const [id, task] of Object.entries(state.tasks)) {
    if ((await taskDefinition(task.definition)).id !== id
        || !["queued", "running", "waiting", "blocked", "failed", "done"].includes(task.status)
        || !Number.isInteger(task.attempts) || task.attempts < 0 || task.attempts > 5
        || !Number.isFinite(task.nextAttempt)
        || task.definition.dependsOn.some(dep => !state.tasks[dep])
        || (task.output && !state.artifacts[task.output])
        || (task.request && !state.artifacts[task.request])
        || (task.review && !state.artifacts[task.review])
        || (task.snapshotArtifacts && (!Array.isArray(task.snapshotArtifacts) || task.snapshotArtifacts.length > 44
          || task.snapshotArtifacts.some(id => !state.artifacts[id])))
        || (task.status === "done" && !task.output)) throw new Error("Task integrity check failed.");
  }
}

export class Coordinator {
  constructor(state, save) { this.state = state; this.save = save; }

  async enqueue(value) {
    const { id, definition } = await taskDefinition(value);
    if (this.state.tasks[id]) return { id, replay: true };
    if (Object.keys(this.state.tasks).length >= LIMITS.tasks) throw new Error("Task storage is full (128 tasks); prune completed tasks explicitly.");
    if (definition.dependsOn.some(dep => !this.state.tasks[dep])) throw new Error("Every dependency must already be queued; forward references and cycles are not allowed.");
    this.state.tasks[id] = { definition, status: "queued", attempts: 0, nextAttempt: 0 };
    await this.save();
    return { id, replay: false };
  }

  list() {
    return {
      version: 1, storage: { tasks: Object.keys(this.state.tasks).length, artifacts: Object.keys(this.state.artifacts).length, bytes: Buffer.byteLength(JSON.stringify(this.state)), limits: LIMITS },
      tasks: Object.entries(this.state.tasks).map(([id, task]) => ({
        id, capability: task.definition.capability, dependsOn: task.definition.dependsOn, status: task.status,
        adapter: task.adapter, attempts: task.attempts, nextAttempt: task.nextAttempt, output: task.output, error: task.error,
      })),
    };
  }

  artifact(id) {
    taskId(id);
    if (!this.state.artifacts[id]) throw new Error("Unknown artifact.");
    return this.state.artifacts[id];
  }

  async put(content, share) {
    artifactContent(content);
    const id = await digest(content);
    const prior = this.state.artifacts[id];
    if (!prior && Object.keys(this.state.artifacts).length >= LIMITS.artifacts) throw new Error("Artifact storage is full (256 artifacts); prune completed tasks explicitly.");
    // A private copy never becomes exportable because another task shares identical text.
    this.state.artifacts[id] = { content, share: prior ? prior.share && share : share };
    return id;
  }

  async freeze(task, request) {
    const stored = structuredClone(request);
    const referenced = new Set();
    for (const note of stored.notes ?? []) {
      note.artifact = await this.put(note.content, task.definition.share);
      delete note.content;
      referenced.add(note.artifact);
    }
    for (const source of stored.sources ?? []) {
      source.artifact = await this.put(source.content, task.definition.share);
      delete source.content;
      referenced.add(source.artifact);
    }
    for (const input of stored.inputs ?? []) {
      if (!this.state.artifacts[input.artifact]) throw new Error("Prepared dependency artifact is missing.");
      if (input.content !== undefined && await digest(input.content) !== input.artifact) throw new Error("Prepared dependency content hash mismatch.");
      delete input.content;
      referenced.add(input.artifact);
    }
    task.snapshotArtifacts = [...referenced];
    return this.put(JSON.stringify(stored), task.definition.share);
  }

  hydrate(task) {
    const request = JSON.parse(this.artifact(task.request).content);
    for (const note of request.notes ?? []) {
      note.content = this.artifact(note.artifact).content;
      delete note.artifact;
    }
    for (const source of request.sources ?? []) {
      source.content = this.artifact(source.artifact).content;
      delete source.artifact;
    }
    for (const input of request.inputs ?? []) input.content = this.artifact(input.artifact).content;
    return request;
  }

  async retry(id) {
    taskId(id);
    const task = this.state.tasks[id];
    if (!task || !["blocked", "failed", "waiting"].includes(task.status)) throw new Error("Retry a blocked, failed or waiting task.");
    task.status = "queued";
    task.attempts = 0;
    task.nextAttempt = 0;
    delete task.error;
    await this.save();
  }

  async prune(ids) {
    ids.forEach(taskId);
    const selected = new Set(ids);
    for (const id of ids) {
      if (!this.state.tasks[id] || !TERMINAL.has(this.state.tasks[id].status)) throw new Error("Only terminal tasks may be pruned.");
      if (Object.entries(this.state.tasks).some(([other, task]) => !selected.has(other) && task.definition.dependsOn.includes(id))) {
        throw new Error("An unpruned task still depends on this task.");
      }
    }
    for (const id of ids) delete this.state.tasks[id];
    const referenced = new Set(Object.values(this.state.tasks).flatMap(task => [task.output, task.request, task.review, ...(task.snapshotArtifacts ?? [])]).filter(Boolean));
    for (const id of Object.keys(this.state.artifacts)) if (!referenced.has(id)) delete this.state.artifacts[id];
    await this.save();
    return this.list();
  }

  async discover(adapters) {
    const results = [];
    for (const [id, adapter] of Object.entries(adapters)) {
      try { results.push({ id, ...capabilities(await adapter.discover()) }); } catch (error) {
        results.push({ id, unavailable: true, error: error.message });
      }
    }
    return results;
  }

  async run(adapters, now = Date.now()) {
    const reports = [];
    const discovered = new Map();
    const discover = adapter => {
      if (!discovered.has(adapter)) discovered.set(adapter, Promise.resolve().then(() => adapter.discover()).then(capabilities));
      return discovered.get(adapter);
    };
    // One bounded pass, serial execution: no resident watcher, fan-out, or unbounded gossip.
    for (const [id, task] of Object.entries(this.state.tasks)) {
      if (reports.length >= LIMITS.tasksPerRun) break;
      if (TERMINAL.has(task.status) || task.nextAttempt > now) continue;
      const dependencies = task.definition.dependsOn.map(dep => this.state.tasks[dep]);
      if (dependencies.some(dep => ["failed", "blocked"].includes(dep.status))) {
        task.status = "blocked"; task.error = "A dependency needs repair or explicit retry.";
        await this.save(); reports.push({ id, status: task.status, error: task.error }); continue;
      }
      if (dependencies.some(dep => dep.status !== "done")) continue;
      try {
        const inputs = task.definition.dependsOn.map(dep => ({ task: dep, artifact: this.state.tasks[dep].output }));
        if (task.definition.share && inputs.some(input => !this.artifact(input.artifact).share)) throw new Error("A private dependency cannot be exported by a downstream task.");
        let adapter = task.adapter && Object.hasOwn(adapters, task.adapter) && adapters[task.adapter];
        if (task.adapter && !adapter) throw new Error("The pinned adapter is unavailable in this configuration.");
        if (!adapter) {
          const unavailable = [];
          for (const name of task.definition.adapters) {
            const candidate = Object.hasOwn(adapters, name) && adapters[name];
            if (!candidate) { unavailable.push(`${name}: not configured`); continue; }
            if (candidate.remote && !task.definition.share) { unavailable.push(`${name}: task sharing not approved`); continue; }
            try {
              const info = await discover(candidate);
              if (info.capabilities.includes(task.definition.capability)) {
                adapter = candidate; task.adapter = name; task.adapterIdentity = candidate.identity; break;
              }
              unavailable.push(`${name}: capability unavailable`);
            } catch (error) { unavailable.push(`${name}: ${error.message}`); }
          }
          if (!adapter) {
            task.status = "waiting"; task.error = unavailable.join("; ").slice(0, 1000);
            task.nextAttempt = now + 60000; await this.save();
            reports.push({ id, status: task.status, error: task.error }); continue;
          }
        }
        if (adapter.remote && !task.definition.share) throw new Error("Remote task sharing is not approved.");
        if (!adapter.identity || task.adapterIdentity !== adapter.identity) throw new Error("Pinned adapter identity changed; restore the approved endpoint/model. No provider switch was attempted.");
        const info = await discover(adapter);
        if (!info.capabilities.includes(task.definition.capability)) throw new Error("Pinned adapter capability changed; repair its compatibility before retrying.");
        if (!task.request) {
          const request = await adapter.prepare({ id, definition: task.definition, inputs, artifacts: inputs.map(input => ({ ...input, ...this.artifact(input.artifact) })) });
          task.request = await this.freeze(task, request);
        }
        if (task.definition.share && (task.snapshotArtifacts ?? []).some(id => !this.artifact(id).share)) {
          throw new Error("A frozen input is private; exporting it is not approved.");
        }
        task.status = "running";
        await this.save(); // Immutable prepared input survives ambiguous transport failure or process exit.
        const result = await adapter.advance(this.hydrate(task));
        if (result.pending === true) {
          task.status = "waiting"; task.nextAttempt = now + 60000;
          delete task.error;
        } else {
          task.output = await this.put(result.content, task.definition.share);
          task.status = "done"; task.nextAttempt = 0;
          delete task.error;
        }
      } catch (error) {
        task.error = error.message.slice(0, 1000);
        if (error.retryable === true && task.attempts < 5) {
          task.attempts++;
          task.status = task.attempts >= 5 ? "failed" : "waiting";
          task.nextAttempt = now + Math.min(300000, 1000 * 2 ** task.attempts);
        } else task.status = "blocked";
      }
      await this.save();
      reports.push({ id, status: task.status, error: task.error, output: task.output });
    }
    return reports;
  }
}
