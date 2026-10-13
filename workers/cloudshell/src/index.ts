import { DurableObject } from "cloudflare:workers";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { handleShell, HttpError } from "./http.mjs";
import { runCommand, type Result } from "./command.mts";
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
  async execute(command: string): Promise<Result> {
    return runCommand(this.ctx.storage, () => getSandbox(this.env.SANDBOX, "rabbitos-owner", {
      sleepAfter: "2m", keepAlive: false, containerTimeouts: { instanceGetTimeoutMS: 30000, portReadyTimeoutMS: 90000 },
    }), command);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/access/")) {
      return handleAccess(request, env,
        (action, value, policy) => env.ACCESS_GATE.getByName("owner-policy").operate(policy, action, value));
    }
    return handleShell(request, env.RABBIT_CLOUDSHELL_TOKEN,
      (command: string) => env.COMMAND_GATE.getByName("owner").execute(command));
  },
} satisfies ExportedHandler<Env>;
