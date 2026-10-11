import { DurableObject } from "cloudflare:workers";
import handler, { positiveLimit } from "./handler.mjs";

export class QwenLimits extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS attempts (client TEXT NOT NULL, at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS attempts_time ON attempts(at)");
  }

  reserve(client) {
    const now = Date.now();
    const midnight = Math.floor(now / 86400000) * 86400000;
    // One coordination atom enforces the shared low-volume daily spending cap.
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM attempts WHERE at < ?", Math.min(midnight, now - 3600000));
      const daily = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM attempts WHERE at >= ?", midnight).one().count;
      const hourly = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM attempts WHERE client = ? AND at > ?", client, now - 3600000).one().count;
      if (daily >= positiveLimit(this.env.DAILY_LIMIT, 500)) {
        return { ok: false, error: "Hosted Qwen reached its daily request cap. Try again tomorrow (UTC)." };
      }
      if (hourly >= positiveLimit(this.env.PER_CLIENT_PER_HOUR, 20)) {
        return { ok: false, error: "Hosted Qwen hourly limit reached. Try again later." };
      }
      this.ctx.storage.sql.exec("INSERT INTO attempts (client, at) VALUES (?, ?)", client, now);
      return { ok: true };
    });
  }
}

export default handler;
