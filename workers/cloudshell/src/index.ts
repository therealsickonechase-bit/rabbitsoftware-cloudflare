import { DurableObject } from "cloudflare:workers";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { handleShell, HttpError } from "./http.mjs";
import { runCommand, type Result } from "./command.mts";
import { endSession, expireSession, runSessionCommand, sessionStatus, startSession, type Alarm } from "./session.mts";
import { accessOperation, handleAccess, type Action, type Policy } from "./access.mts";

export { Sandbox };

export class AccessGate extends DurableObject<Env> {
  async operate(policy: Policy, action: Action, value: unknown): Promise<Result> {
    try {
      return await accessOperation(this.ctx.storage, policy, action, value);
    } catch (error) {
      // Custom error prototypes do not survive the Durable Object RPC boundary.
      if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }
}

export class CommandGate extends DurableObject<Env> {
  /** The one-command sandbox: blank every time and destroyed afterwards (unchanged). */
  private ephemeral() {
    return getSandbox(this.env.SANDBOX, "rabbitos-owner", {
      sleepAfter: "2m", keepAlive: false, containerTimeouts: { instanceGetTimeoutMS: 30000, portReadyTimeoutMS: 90000 },
    });
  }
  /** The session sandbox: a different instance, kept between commands and destroyed by the alarm (see session.mts). sleepAfter is only a backstop behind the alarm. */
  private persistent() {
    return getSandbox(this.env.SANDBOX, "rabbitos-owner-session", {
      sleepAfter: "30m", keepAlive: false, containerTimeouts: { instanceGetTimeoutMS: 30000, portReadyTimeoutMS: 90000 },
    });
  }
  private alarmApi(): Alarm {
    return { set: (at: number) => this.ctx.storage.setAlarm(at), clear: () => this.ctx.storage.deleteAlarm() };
  }

  async execute(command: string, options?: { session?: boolean; timeoutSeconds?: number }): Promise<Result> {
    if (options?.session === true) return runSessionCommand(this.ctx.storage, () => this.persistent(), command, options.timeoutSeconds, this.alarmApi());
    return runCommand(this.ctx.storage, () => this.ephemeral(), command);
  }
  sessionStatus(): Promise<Result> { return sessionStatus(this.ctx.storage); }
  sessionStart(): Promise<Result> { return startSession(this.ctx.storage, () => this.persistent(), this.alarmApi()); }
  sessionEnd(): Promise<Result> { return endSession(this.ctx.storage, () => this.persistent(), this.alarmApi()); }
  async alarm(): Promise<void> { await expireSession(this.ctx.storage, () => this.persistent(), this.alarmApi()); }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/access/")) {
      return handleAccess(request, env,
        (action, value, policy) => env.ACCESS_GATE.getByName("owner-policy").operate(policy, action, value));
    }
    const gate = () => env.COMMAND_GATE.getByName("owner");
    return handleShell(request, env.RABBIT_CLOUDSHELL_TOKEN,
      (command: string, options?: { session?: boolean; timeoutSeconds?: number }) => gate().execute(command, options),
      { status: () => gate().sessionStatus(), start: () => gate().sessionStart(), end: () => gate().sessionEnd() });
  },
} satisfies ExportedHandler<Env>;
