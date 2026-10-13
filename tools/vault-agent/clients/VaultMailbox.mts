import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const hashPattern = /^[a-f0-9]{64}$/;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface MailboxOptions {
  vault: string;
  entrypoint: string;
  sender: string;
  recipient: string;
  nodePath?: string;
}

export interface SentMessage {
  id: string;
  replay: boolean;
  status: "pending" | "acknowledged";
}

export interface MessageHeader {
  id: string;
  sender: string;
  recipient: string;
  artifact: string;
  kind: "code" | "handoff" | "task-receipt";
}

export interface RetainedMessage extends MessageHeader {
  content: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Mailbox returned a non-object response.");
  return value;
}

function named(value: string): string {
  if (!namePattern.test(value)) throw new Error("Use lowercase sender/recipient names of 1-64 characters.");
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error("Use a SHA-256 task, message or artifact ID.");
  return value;
}

function header(value: unknown): MessageHeader {
  const data = object(value);
  if (typeof data.sender !== "string" || typeof data.recipient !== "string"
      || !["code", "handoff", "task-receipt"].includes(String(data.kind))) throw new Error("Invalid retained message header.");
  const kind = data.kind;
  if (kind !== "code" && kind !== "handoff" && kind !== "task-receipt") throw new Error("Invalid retained message kind.");
  return { id: hash(data.id), artifact: hash(data.artifact), sender: named(data.sender), recipient: named(data.recipient), kind };
}

export class VaultMailbox {
  private readonly options: MailboxOptions;

  constructor(options: MailboxOptions) {
    for (const path of [options.vault, options.entrypoint, options.nodePath ?? process.execPath]) {
      if (!isAbsolute(path)) throw new Error("Use absolute vault, mailbox CLI and Node paths.");
    }
    named(options.sender); named(options.recipient);
    this.options = { ...options };
  }

  private async command(action: string, value: string): Promise<unknown> {
    const { stdout } = await runFile(this.options.nodePath ?? process.execPath,
      [this.options.entrypoint, "--vault", this.options.vault, action, value],
      { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  }

  private async submit(action: string, value: unknown): Promise<unknown> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Mailbox CLI JSON exceeds 128 KiB; split the task result without truncation.");
    const directory = await mkdtemp(join(tmpdir(), "vault-typescript-mailbox-"));
    try {
      const input = join(directory, "input.json");
      await writeFile(input, text, { flag: "wx", mode: 0o600 });
      return await this.command(action, input);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async send(key: string, kind: MessageHeader["kind"], content: string): Promise<SentMessage> {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) throw new Error("Use a stable message key of 1-128 safe characters.");
    if (!content.trim() || content.includes("\0") || Buffer.byteLength(content) > 65536) throw new Error("Retained content must contain 1-65536 UTF-8 bytes.");
    const data = object(await this.submit("--send", {
      version: 1, sender: this.options.sender, recipient: this.options.recipient,
      key, kind, route: "local", share: false, content,
    }));
    if (typeof data.replay !== "boolean" || (data.status !== "pending" && data.status !== "acknowledged")) throw new Error("Mailbox did not confirm a retained local message.");
    return { id: hash(data.id), replay: data.replay, status: data.status };
  }

  async reportTask(task: string, revision: string, status: "completed" | "failed" | "blocked", result: string): Promise<SentMessage> {
    hash(task);
    if (!/^[a-zA-Z0-9._-]{1,32}$/.test(revision)) throw new Error("Use a stable result revision of 1-32 safe characters.");
    if (!["completed", "failed", "blocked"].includes(status) || !result.trim()) throw new Error("Provide a terminal task status and nonempty result.");
    return this.send(`task:${task}:${revision}`, "task-receipt", JSON.stringify({ version: 1, task, revision, status, result }));
  }

  async completeTask(task: string, revision: string, result: string): Promise<SentMessage> {
    return this.reportTask(task, revision, "completed", result);
  }

  async receive(): Promise<{ messages: MessageHeader[]; remaining: number }> {
    const data = object(await this.command("--receive", this.options.sender));
    if (data.version !== 1 || !Array.isArray(data.messages) || data.messages.length > 16
        || typeof data.remaining !== "number" || !Number.isSafeInteger(data.remaining) || data.remaining < 0) throw new Error("Invalid bounded inbox response.");
    const messages = data.messages.map(header);
    if (messages.some(message => message.recipient !== this.options.sender)) throw new Error("Inbox recipient mismatch.");
    return { messages, remaining: data.remaining };
  }

  async read(id: string): Promise<RetainedMessage> {
    const data = object(await this.command("--read", `${this.options.sender}:${hash(id)}`));
    const message = header(data);
    if (data.version !== 1 || message.id !== id || message.recipient !== this.options.sender
        || data.route !== "local" || typeof data.content !== "string"
        || createHash("sha256").update(data.content).digest("hex") !== message.artifact) throw new Error("Retained content/recipient hash verification failed.");
    return { ...message, content: data.content };
  }

  async acknowledge(id: string, artifact: string): Promise<void> {
    const data = object(await this.submit("--ack", { recipient: this.options.sender, id: hash(id), artifact: hash(artifact) }));
    if (data.id !== id || data.acknowledged !== true) throw new Error("Mailbox did not confirm acknowledgment.");
  }
}
