import { open, writeFile, rename, unlink } from "node:fs/promises";
import { safePath, writeOnce } from "../../scripts/vault-agent-sync.mjs";
import { digest } from "../../workers/vault-agent/src/protocol.mjs";
import { adapterName, taskId, artifactContent } from "./task-protocol.mjs";
import { toolPackage, packageNote, PACKAGE_LIMITS } from "./tool-package.mjs";

export const MAILBOX_LIMITS = Object.freeze({ messages: 128, artifacts: 128, contentBytes: 65536, stateBytes: 8 * 1024 * 1024, receive: 16 });
const STATE = "Cloud Agents/Network/mailbox.json";
const owns = (object, key) => Object.hasOwn(object, key);

export class MailboxError extends Error {}

async function normalizedPackage(value) {
  try { return await toolPackage(value); } catch (error) { throw new MailboxError(error.message); }
}

function name(value) {
  try { return adapterName(value); } catch (error) { throw new MailboxError(error.message); }
}

function hash(value) {
  try { return taskId(value); } catch (error) { throw new MailboxError(error.message); }
}

function content(value) {
  try { return artifactContent(value); } catch (error) { throw new MailboxError(error.message); }
}

function scopedValidation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["runner", "identity", "tests", "maxLines"].includes(key))
      || value.runner !== "coding-local" || !Array.isArray(value.tests) || !value.tests.length || value.tests.length > 8
      || !Number.isInteger(value.maxLines) || value.maxLines < 1 || value.maxLines > 2000) throw new MailboxError("Invalid scoped coding validation provenance.");
  hash(value.identity);
  const paths = new Set();
  for (const test of value.tests) {
    if (!test || Object.keys(test).some(key => !["path", "hash"].includes(key))
        || typeof test.path !== "string" || !test.path || test.path.length > 180 || paths.has(test.path)
        || test.path.split("/").some(part => !part || part.startsWith(".") || /[\\:\x00-\x1f]/.test(part))) throw new MailboxError("Invalid immutable test provenance.");
    hash(test.hash); paths.add(test.path);
  }
  content(JSON.stringify(value));
}

export async function envelope(value) {
  if (!value || value.version !== 1) throw new MailboxError("Unsupported mailbox version; this host supports version 1.");
  if (Object.keys(value).some(key => !["version", "sender", "recipient", "key", "kind", "route", "share", "content"].includes(key))) throw new MailboxError("Unknown message field.");
  name(value.sender); name(value.recipient);
  if (typeof value.key !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.key)) throw new MailboxError("Use a stable message key of 1-128 safe characters.");
  if (!["code", "handoff", "task-receipt"].includes(value.kind) || !["local", "cloud"].includes(value.route)) throw new MailboxError("Choose a code, handoff or task-receipt message and an explicit local/cloud route.");
  if (typeof value.share !== "boolean" || (value.route === "cloud" && !value.share)) throw new MailboxError("Cloud routing requires explicit share: true. Local messages also need a boolean sharing flag.");
  content(value.content);
  const artifact = await digest(value.content);
  const definition = { version: 1, sender: value.sender, recipient: value.recipient, key: value.key, kind: value.kind, route: value.route, share: value.share, artifact };
  return { definition, id: await digest(JSON.stringify(definition)) };
}

async function validate(state) {
  if (state?.version !== 1 || !state.messages || !state.artifacts || Array.isArray(state.messages) || Array.isArray(state.artifacts)
      || Object.keys(state.messages).length > MAILBOX_LIMITS.messages || Object.keys(state.artifacts).length > MAILBOX_LIMITS.artifacts) {
    throw new MailboxError("Invalid or unsupported mailbox state; preserve it for recovery.");
  }
  for (const [id, content] of Object.entries(state.artifacts)) {
    hash(id);
    if (await digest(artifactContent(content)) !== id) throw new MailboxError("Mailbox content integrity check failed.");
  }
  const keys = new Set();
  for (const [id, message] of Object.entries(state.messages)) {
    const definition = message.definition;
    if (!definition || !owns(state.artifacts, definition.artifact)) throw new MailboxError("Mailbox artifact is missing.");
    const { artifact, ...fields } = definition;
    const normalized = await envelope({ ...fields, content: state.artifacts[artifact] });
    const key = `${definition.sender}:${definition.recipient}:${definition.key}`;
    if (normalized.id !== id || keys.has(key) || !["pending", "acknowledged", "cloud-pending"].includes(message.status)
        || typeof message.created !== "string"
        || (definition.route === "cloud" && message.status !== "cloud-pending")
        || (definition.route === "local" && message.status === "cloud-pending")) throw new MailboxError("Mailbox message integrity check failed.");
    keys.add(key);
  }
  if (state.packages !== undefined) {
    if (!state.packages || Array.isArray(state.packages) || Object.keys(state.packages).length > PACKAGE_LIMITS.packages
        || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new MailboxError("Invalid tool-package catalog.");
    const revisions = new Set();
    for (const [id, entry] of Object.entries(state.packages)) {
      if (!owns(state.artifacts, entry.artifact) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || entry.revision > state.revision
          || revisions.has(entry.revision) || !["pending", "approved"].includes(entry.review)) throw new MailboxError("Invalid tool-package record.");
      revisions.add(entry.revision); name(entry.publisher);
      if (entry.review === "approved") name(entry.reviewer);
      if (entry.validation !== undefined) scopedValidation(entry.validation);
      if ((await normalizedPackage(JSON.parse(state.artifacts[entry.artifact]))).id !== id || id !== entry.artifact) throw new MailboxError("Tool-package integrity check failed.");
    }
  }
}

export async function withMailbox(vault, action) {
  const path = await safePath(vault, STATE, true);
  const lockPath = await safePath(vault, `${STATE}.lock`);
  let lock;
  try { lock = await open(lockPath, "wx"); } catch (error) {
    if (error.code === "EEXIST") throw new MailboxError("Mailbox is busy or has a stale lock. Retry; after a crash verify the recorded PID stopped before removing mailbox.json.lock.");
    throw error;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    let state;
    try {
      const file = await open(path, "r");
      try {
        if ((await file.stat()).size > MAILBOX_LIMITS.stateBytes) throw new MailboxError("Mailbox exceeds 8 MiB; preserve it for recovery.");
        state = JSON.parse(await file.readFile("utf8"));
      } finally { await file.close(); }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { version: 1, messages: {}, artifacts: {} };
    }
    await validate(state);
    const save = async () => {
      await validate(state);
      const text = JSON.stringify(state);
      if (Buffer.byteLength(text) > MAILBOX_LIMITS.stateBytes) throw new MailboxError("Mailbox storage is full; explicitly prune acknowledged messages.");
      const file = await open(temporary, "wx");
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    };
    return await action(new Mailbox(state, save, vault));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    await lock.close(); await unlink(lockPath);
  }
}

export class Mailbox {
  constructor(state, save, vault) { this.state = state; this.save = save; this.vault = vault; }

  async retainPackage(value, publisher, validation = undefined) {
    name(publisher);
    const pack = await normalizedPackage(value);
    if (validation !== undefined) scopedValidation(validation);
    this.state.packages ??= {};
    this.state.revision ??= 0;
    if (!owns(this.state.packages, pack.id)) {
      if (Object.keys(this.state.packages).length >= PACKAGE_LIMITS.packages) throw new MailboxError("Tool-package catalog is full (64 packages); no retained package was deleted.");
      if (!owns(this.state.artifacts, pack.id) && Object.keys(this.state.artifacts).length >= MAILBOX_LIMITS.artifacts) throw new MailboxError("Mailbox artifacts are full; package was not retained.");
      this.state.artifacts[pack.id] = pack.content;
      this.state.packages[pack.id] = {
        artifact: pack.id, publisher, review: "pending", revision: ++this.state.revision,
        ...(validation ? { validation } : {}),
      };
      await this.save();
    } else if (validation && !this.state.packages[pack.id].validation) {
      this.state.packages[pack.id].validation = validation;
      this.state.packages[pack.id].revision = ++this.state.revision;
      await this.save();
    }
    if (this.vault) {
      await writeOnce(await safePath(this.vault, `Cloud Agents/Network/Packages/${pack.id}.md`, true), packageNote(pack.id, pack.definition));
    }
    return this.readPackage(pack.id);
  }

  readPackage(id) {
    hash(id);
    if (!owns(this.state.packages ?? {}, id)) throw new MailboxError("Unknown retained tool package.");
    const entry = this.state.packages[id];
    return { id, ...entry, package: JSON.parse(this.state.artifacts[entry.artifact]), executable: false };
  }

  gossip(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0 || after > (this.state.revision ?? 0)) throw new MailboxError("Use a catalog cursor from 0 through its current revision.");
    const entries = Object.entries(this.state.packages ?? {}).filter(([, entry]) => entry.revision > after)
      .sort((a, b) => a[1].revision - b[1].revision);
    const page = [];
    const output = () => ({ version: 1, packages: page, cursor: page.at(-1)?.revision ?? after, remaining: entries.length - page.length, cloudDelivery: false });
    for (const [id, entry] of entries.slice(0, PACKAGE_LIMITS.gossipBatch)) {
      const pack = JSON.parse(this.state.artifacts[entry.artifact]);
      page.push({ id, name: pack.name, capabilities: pack.capabilities, revision: entry.revision,
        review: entry.review, validation: entry.validation ? "scoped-tests-passed" : "unvalidated",
        bytes: Buffer.byteLength(this.state.artifacts[entry.artifact]), executable: false });
      if (Buffer.byteLength(JSON.stringify(output())) > PACKAGE_LIMITS.gossipBytes) { page.pop(); break; }
    }
    return output();
  }

  async approvePackage(value) {
    if (!value || Object.keys(value).some(key => !["id", "reviewer"].includes(key))) throw new MailboxError("Review needs exact package id and reviewer.");
    name(value.reviewer);
    const entry = this.readPackage(value.id);
    if (entry.review !== "approved") {
      this.state.packages[value.id].review = "approved";
      this.state.packages[value.id].reviewer = value.reviewer;
      this.state.packages[value.id].revision = ++this.state.revision;
      await this.save();
    }
    return this.readPackage(value.id);
  }

  async send(value) {
    const { definition, id } = await envelope(value);
    const prior = Object.entries(this.state.messages).find(([, message]) =>
      message.definition.sender === definition.sender && message.definition.recipient === definition.recipient && message.definition.key === definition.key);
    if (prior) {
      if (prior[0] !== id) throw new MailboxError("Message key already identifies different immutable content; use a new revision key.");
      return { id, replay: true, status: prior[1].status };
    }
    if (Object.keys(this.state.messages).length >= MAILBOX_LIMITS.messages) throw new MailboxError("Mailbox is full (128 messages); no pending content was deleted.");
    if (!owns(this.state.artifacts, definition.artifact) && Object.keys(this.state.artifacts).length >= MAILBOX_LIMITS.artifacts) throw new MailboxError("Mailbox artifacts are full; no retained package/message was deleted.");
    this.state.artifacts[definition.artifact] = value.content;
    this.state.messages[id] = { definition, status: definition.route === "cloud" ? "cloud-pending" : "pending", created: new Date().toISOString() };
    await this.save();
    return { id, replay: false, status: this.state.messages[id].status };
  }

  list() {
    return { version: 1, storage: { messages: Object.keys(this.state.messages).length, packages: Object.keys(this.state.packages ?? {}).length, catalogRevision: this.state.revision ?? 0, artifacts: Object.keys(this.state.artifacts).length, bytes: Buffer.byteLength(JSON.stringify(this.state)), limits: { ...MAILBOX_LIMITS, packages: PACKAGE_LIMITS.packages } },
      messages: Object.entries(this.state.messages).map(([id, message]) => ({ id, ...message.definition, status: message.status, created: message.created })) };
  }

  receive(recipient) {
    name(recipient);
    const available = this.list().messages.filter(message => message.recipient === recipient && message.status === "pending");
    return { version: 1, messages: available.slice(0, MAILBOX_LIMITS.receive), remaining: Math.max(0, available.length - MAILBOX_LIMITS.receive) };
  }

  read(recipient, id) {
    name(recipient); hash(id);
    const message = owns(this.state.messages, id) && this.state.messages[id];
    if (!message || message.definition.recipient !== recipient || message.definition.route !== "local") throw new MailboxError("Unknown local message for this recipient.");
    return { version: 1, id, ...message.definition, status: message.status, content: this.state.artifacts[message.definition.artifact] };
  }

  async acknowledge(value) {
    if (!value || Object.keys(value).some(key => !["recipient", "id", "artifact"].includes(key))) throw new MailboxError("Acknowledgment needs recipient, id and artifact.");
    const message = this.read(value.recipient, value.id);
    if (message.artifact !== value.artifact) throw new MailboxError("Acknowledgment content hash does not match.");
    this.state.messages[value.id].status = "acknowledged";
    await this.save();
    return { id: value.id, acknowledged: true };
  }

  async prune(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new MailboxError("Explicitly select acknowledged message IDs to prune.");
    for (const id of ids) {
      hash(id);
      if (!owns(this.state.messages, id) || this.state.messages[id].status !== "acknowledged") throw new MailboxError("Only acknowledged local messages may be pruned; pending/cloud messages are retained.");
    }
    for (const id of ids) delete this.state.messages[id];
    const retained = new Set([...Object.values(this.state.messages), ...Object.values(this.state.packages ?? {})].map(message => message.definition?.artifact ?? message.artifact));
    for (const id of Object.keys(this.state.artifacts)) if (!retained.has(id)) delete this.state.artifacts[id];
    await this.save();
    return this.list();
  }
}
