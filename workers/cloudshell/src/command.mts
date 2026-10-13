import type { getSandbox } from "@cloudflare/sandbox";

export type Result = { status: number; body: Record<string, unknown> };
type Lease = { id: string };
type Storage = Pick<DurableObjectStorage, "transaction">;
type Runner = Pick<ReturnType<typeof getSandbox>, "exec" | "destroy">;

export async function runCommand(storage: Storage, createRunner: () => Runner, command: string): Promise<Result> {
  const id = crypto.randomUUID();
  const acquired = await storage.transaction(async transaction => {
    const active = await transaction.get<Lease>("active");
    if (active) return false;
    await transaction.put("active", { id });
    return true;
  });
  if (!acquired) return { status: 409, body: { error: "An owner command is already running or needs operator recovery. Do not automatically retry." } };
  const sandbox = createRunner();
  try {
    const process = await sandbox.exec(["/bin/bash", "-lc", command], { cwd: "/workspace", timeout: 60000 });
    try {
      const output = await process.output({ encoding: "utf8", maxBytes: 65536, timeout: 70000 });
      return { status: 200, body: {
        stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode,
        timedOut: output.timedOut, truncated: output.truncated,
        limits: { commandTimeoutMs: 60000, outputBytes: 65536 },
      } };
    } catch (error) {
      await process.kill(9);
      throw error;
    }
  } finally {
    // Teardown must succeed before another command can acquire the durable gate.
    await sandbox.destroy();
    await storage.transaction(async transaction => {
      const active = await transaction.get<Lease>("active");
      if (active?.id === id) await transaction.delete("active");
    });
  }
}
