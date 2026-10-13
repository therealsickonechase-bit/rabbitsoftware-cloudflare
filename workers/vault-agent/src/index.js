import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { InputError, digest, infer, normalizeJob, readJson, validId } from "./protocol.mjs";

export class VaultBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL)");
  }

  reserve() {
    const day = new Date().toISOString().slice(0, 10);
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM budget WHERE day <> ?", day);
      const rows = this.ctx.storage.sql.exec("SELECT attempts FROM budget WHERE day = ?", day).toArray();
      if ((rows[0]?.attempts ?? 0) >= 20) return false;
      this.ctx.storage.sql.exec("INSERT INTO budget VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET attempts = attempts + 1", day);
      return true;
    });
  }
}

export class VaultJob extends WorkflowEntrypoint {
  async run(event, step) {
    const id = validId(event.payload.id);
    const job = await step.do("read immutable snapshot", async () => {
      const object = await this.env.VAULT.get(`jobs/${id}.json`);
      if (!object) throw new Error("Job snapshot is missing.");
      const value = normalizeJob(await object.json());
      if (await digest(JSON.stringify(value)) !== id) throw new Error("Job snapshot hash mismatch.");
      return value;
    });
    const result = await step.do("generate result", { retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "5 minutes" }, async () => {
      if (!await this.env.BUDGET.getByName("vault-inference-budget").reserve()) {
        throw new Error("Vault agent reached its 20-attempt UTC daily cap.");
      }
      try {
        return await infer(this.env, job, id);
      } catch (error) {
        console.error(JSON.stringify({ event: "vault_inference_failed", id, type: error.name }));
        throw new Error("Vault inference failed; inspect Worker logs. No automatic retry or provider fallback.");
      }
    });
    await step.do("save result and edit proposals", async () => {
      await this.env.VAULT.put(`results/${id}.json`, JSON.stringify(result));
    });
    return { id };
  }
}

const reply = (status, value) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    try {
      if (typeof env.VAULT_AGENT_TOKEN !== "string" || env.VAULT_AGENT_TOKEN.length < 32) {
        console.error(JSON.stringify({ event: "vault_agent_not_configured" }));
        return reply(503, { error: "Configure a VAULT_AGENT_TOKEN of at least 32 characters." });
      }
      const encoder = new TextEncoder();
      const [provided, expected] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("Authorization") ?? "")),
        crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.VAULT_AGENT_TOKEN}`)),
      ]);
      if (!crypto.subtle.timingSafeEqual(provided, expected)) return reply(401, { error: "Unauthorized." });
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health") {
        return reply(200, { ok: true, modes: ["task", "answer", "organize"], dailyAttempts: 20 });
      }
      if (request.method === "POST" && path === "/jobs") {
        const job = normalizeJob(await readJson(request));
        const body = JSON.stringify(job);
        const id = await digest(body);
        await env.VAULT.put(`jobs/${id}.json`, body, { onlyIf: { etagDoesNotMatch: "*" } });
        try {
          await env.JOBS.create({ id, params: { id } });
        } catch (error) {
          if (!error.message?.includes("(instance.already_exists)")) throw error;
          // An identical immutable snapshot addresses the same durable job.
          await (await env.JOBS.get(id)).status();
        }
        return reply(202, { id });
      }
      const route = /^\/jobs\/([a-f0-9]{64})(\/result)?$/.exec(path);
      if (request.method === "GET" && route) {
        const id = route[1];
        if (!await env.VAULT.head(`jobs/${id}.json`)) return reply(404, { error: "Unknown job." });
        if (route[2]) {
          const result = await env.VAULT.get(`results/${id}.json`);
          if (!result) return reply(409, { error: "Result is not ready. Check job status." });
          return new Response(result.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        }
        const status = await (await env.JOBS.get(id)).status();
        return reply(200, { id, status: status.status, ...(status.error ? { error: status.error } : {}) });
      }
      return reply(404, { error: "Not found." });
    } catch (error) {
      if (error instanceof InputError) return reply(400, { error: error.message });
      console.error(JSON.stringify({ event: "vault_request_failed", type: error.name }));
      return reply(502, { error: "Vault agent operation failed. Inspect Worker logs before retrying." });
    }
  },
};
