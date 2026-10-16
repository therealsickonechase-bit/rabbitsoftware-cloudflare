// Session mode for the owner shell. The default shell (command.mts) is deliberately one command per sandbox: every command starts blank, is cut off at 60 seconds, and the sandbox is destroyed
// afterwards. That is safe but makes real work impossible (no installs that survive, no files from the last command, builds killed at 60 s). Session mode keeps the same safeguards
// (Access sign-in and server token in front, an approval for each command, one command at a time through the same durable gate) and adds ONE persistent sandbox with a hard lifetime:
//   * it lives while you use it: up to 20 idle minutes, never longer than 2 hours in all, then it is destroyed (a Durable Object alarm does it, even if the page is closed);
//   * commands may run up to 150 seconds and return up to 128 KiB (the app caps a whole reply at 256 KiB); longer work runs in the background inside the session (nohup ... &) and is checked with later commands;
//   * you can end it at once (POST /session/end), and a failed teardown keeps the record so it is retried, never silently dropped.
// Nothing here relaxes the ephemeral path, which is unchanged.
import type { getSandbox } from "@cloudflare/sandbox";

export type Result = { status: number; body: Record<string, unknown> };
type Lease = { id: string };
type Storage = Pick<DurableObjectStorage, "transaction">;
type Runner = Pick<ReturnType<typeof getSandbox>, "exec" | "destroy">;
export type Alarm = { set(at: number): Promise<void>; clear(): Promise<void> };
export type SessionRecord = { startedAt: number; lastUsed: number; idleExpiresAt: number; hardExpiresAt: number };

/** Secrets handed to session commands (as environment variables of that one command only, never stored in the sandbox) and hidden if a command prints them. */
export type Secrets = Record<string, string | undefined>;
const MIN_SECRET_LENGTH = 8;
const usable = (secrets: Secrets) => Object.entries(secrets).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length >= MIN_SECRET_LENGTH);
/** Replaces every occurrence of every secret value in a text. The owner and the coding assistant read command output, so a printed key must not travel. */
export function redact(text: string, secrets: Secrets): string {
  let out = text;
  for (const [, value] of usable(secrets)) out = out.split(value).join("[redacted]");
  return out;
}
/** What the session sandbox offers, for the status line: the tools baked into the image and whether the key they need is configured (never the key). */
export function toolsStatus(secrets: Secrets) {
  return { gemini: { installed: true, keyConfigured: usable({ GEMINI_API_KEY: secrets.GEMINI_API_KEY }).length === 1 } };
}

export const SESSION = Object.freeze({ idleMs: 20 * 60_000, maxMs: 2 * 60 * 60_000, defaultTimeoutS: 90, maxTimeoutS: 150, outputBytes: 131_072, startTimeoutS: 90 });

const publicRecord = (r: SessionRecord) => ({ active: true, startedAt: r.startedAt, lastUsed: r.lastUsed, idleExpiresAt: r.idleExpiresAt, hardExpiresAt: r.hardExpiresAt });
const limits = () => ({ idleMinutes: SESSION.idleMs / 60_000, maxMinutes: SESSION.maxMs / 60_000, timeoutSeconds: { default: SESSION.defaultTimeoutS, max: SESSION.maxTimeoutS }, outputBytes: SESSION.outputBytes });
const nextExpiry = (r: Pick<SessionRecord, "hardExpiresAt">, now: number) => Math.min(now + SESSION.idleMs, r.hardExpiresAt);

async function acquire(storage: Storage): Promise<string | null> {
  const id = crypto.randomUUID();
  const ok = await storage.transaction(async tx => {
    if (await tx.get<Lease>("active")) return false;
    await tx.put("active", { id });
    return true;
  });
  return ok ? id : null;
}
async function release(storage: Storage, id: string) {
  await storage.transaction(async tx => { const active = await tx.get<Lease>("active"); if (active?.id === id) await tx.delete("active"); });
}
const busy: Result = { status: 409, body: { error: "A command is already running (or needs operator recovery). Wait for it; do not automatically retry." } };

export async function sessionStatus(storage: Storage, now: () => number = Date.now, secrets: Secrets = {}): Promise<Result> {
  const rec = await storage.transaction(tx => tx.get<SessionRecord>("session"));
  const t = now();
  const live = rec && t < rec.idleExpiresAt && t < rec.hardExpiresAt;
  return { status: 200, body: { session: live ? publicRecord(rec) : { active: false }, limits: limits(), tools: toolsStatus(secrets) } };
}

/** Runs one approved command in the persistent sandbox, starting (or restarting an expired) session if needed. */
export async function runSessionCommand(storage: Storage, createRunner: () => Runner, command: string, timeoutSeconds: number | undefined, alarm: Alarm, now: () => number = Date.now, secrets: Secrets = {}): Promise<Result> {
  const seconds = Math.min(SESSION.maxTimeoutS, Math.max(1, Math.floor(timeoutSeconds ?? SESSION.defaultTimeoutS)));
  const lease = await acquire(storage);
  if (!lease) return busy;
  try {
    const t0 = now();
    let rec = await storage.transaction(tx => tx.get<SessionRecord>("session"));
    if (rec && (t0 >= rec.idleExpiresAt || t0 >= rec.hardExpiresAt)) {
      await createRunner().destroy();                       // an expired session is torn down first; if that fails the record stays and the command is refused (thrown)
      await storage.transaction(tx => tx.delete("session"));
      rec = undefined;
    }
    if (!rec) {
      rec = { startedAt: t0, lastUsed: t0, idleExpiresAt: t0 + SESSION.idleMs, hardExpiresAt: t0 + SESSION.maxMs };
      await storage.transaction(tx => tx.put("session", rec));
    }
    await alarm.set(rec.idleExpiresAt);                      // scheduled BEFORE the command runs, so a crash can never leave a container without a scheduled teardown
    const sandbox = createRunner();
    let result: Result;
    const env = Object.fromEntries(usable(secrets));
    const process = await sandbox.exec(["/bin/bash", "-lc", command], { cwd: "/workspace", timeout: seconds * 1000, ...(Object.keys(env).length ? { env } : {}) });
    try {
      const output = await process.output({ encoding: "utf8", maxBytes: SESSION.outputBytes, timeout: seconds * 1000 + 10_000 });
      result = { status: 200, body: { stdout: redact(output.stdout, secrets), stderr: redact(output.stderr, secrets), exitCode: output.exitCode, timedOut: output.timedOut, truncated: output.truncated,
        limits: { commandTimeoutMs: seconds * 1000, outputBytes: SESSION.outputBytes } } };
    } catch (error) {
      await process.kill(9);
      throw error;
    } finally {
      const t1 = now();
      const updated: SessionRecord = { ...rec, lastUsed: t1, idleExpiresAt: nextExpiry(rec, t1) };
      await storage.transaction(tx => tx.put("session", updated));
      await alarm.set(updated.idleExpiresAt);
      rec = updated;
    }
    result.body.session = publicRecord(rec);
    return result;
  } finally {
    await release(storage, lease);
  }
}

/** Opens the session (or confirms it is open) so the first real command does not pay the cold start. */
export function startSession(storage: Storage, createRunner: () => Runner, alarm: Alarm, now: () => number = Date.now): Promise<Result> {
  return runSessionCommand(storage, createRunner, "true", SESSION.startTimeoutS, alarm, now);
}

/** Ends the session now. Refused while a command is running. A failed teardown keeps the record, so the alarm and the next call retry it. */
export async function endSession(storage: Storage, createRunner: () => Runner, alarm: Alarm): Promise<Result> {
  const lease = await acquire(storage);
  if (!lease) return { status: 409, body: { error: "A command is running; end the session when it finishes." } };
  try {
    const rec = await storage.transaction(tx => tx.get<SessionRecord>("session"));
    if (!rec) return { status: 200, body: { ended: false, session: { active: false } } };
    try { await createRunner().destroy(); }
    catch { return { status: 502, body: { error: "The session could not be torn down. It will be retried automatically; check again shortly." } }; }
    await storage.transaction(tx => tx.delete("session"));
    await alarm.clear();
    return { status: 200, body: { ended: true, session: { active: false } } };
  } finally {
    await release(storage, lease);
  }
}

/** The Durable Object alarm: destroy the session when it has expired, wait if it has not, retry if teardown fails. */
export async function expireSession(storage: Storage, createRunner: () => Runner, alarm: Alarm, now: () => number = Date.now): Promise<"none" | "waiting" | "busy" | "destroyed" | "retry"> {
  const rec = await storage.transaction(tx => tx.get<SessionRecord>("session"));
  if (!rec) return "none";
  const t = now();
  if (t < rec.idleExpiresAt && t < rec.hardExpiresAt) { await alarm.set(Math.min(rec.idleExpiresAt, rec.hardExpiresAt)); return "waiting"; }
  const lease = await acquire(storage);
  if (!lease) { await alarm.set(t + 30_000); return "busy"; }
  try {
    try { await createRunner().destroy(); }
    catch { await alarm.set(t + 60_000); return "retry"; }
    await storage.transaction(tx => tx.delete("session"));
    return "destroyed";
  } finally {
    await release(storage, lease);
  }
}
