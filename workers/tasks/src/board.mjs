// Public visitor task queue kept in one SQLite Durable Object ("public-tasks").
// Pure over a DO-style `sql.exec(query, ...params)` so tests can back it with node:sqlite.

export const KINDS = {
  answer: "Answer the visitor's question clearly and briefly. Say when you are unsure. Do not invent sources.",
  summarize: "Summarise the visitor's text in short plain-language bullet points. Do not add facts that are not in the text.",
  explain: "Explain the visitor's code or technical text step by step for a beginner. Do not run or modify anything.",
};
export const MAX_INPUT_CHARS = 8000;
const HOUR = 3600000;
const DAY = 86400000;
const STALE_RUNNING = 5 * 60000;

export function limits(env = {}) {
  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    daily: positive(env.TASK_DAILY_LIMIT, 100),
    perHour: positive(env.TASKS_PER_CLIENT_PER_HOUR, 5),
    maxQueued: positive(env.TASK_MAX_QUEUED, 25),
    retentionDays: positive(env.TASK_RETENTION_DAYS, 7),
  };
}

export class Board {
  constructor(sql, config) {
    this.sql = sql;
    this.config = config;
  }

  init() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, input TEXT NOT NULL, client TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, created)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS attempts (client TEXT NOT NULL, at INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS attempts_time ON attempts(at)");
  }

  count(query, ...params) {
    return this.sql.exec(query, ...params).one().count;
  }

  /** Reserve quota and queue a task. Every accepted submission counts, even if inference later fails. */
  submit({ id, kind, input, client }, now) {
    const midnight = Math.floor(now / DAY) * DAY;
    this.sql.exec("DELETE FROM attempts WHERE at < ?", Math.min(midnight, now - HOUR));
    if (this.count("SELECT COUNT(*) AS count FROM attempts WHERE at >= ?", midnight) >= this.config.daily) {
      return { ok: false, status: 429, error: "Visitor tasks reached today's limit. Try again tomorrow (UTC)." };
    }
    if (this.count("SELECT COUNT(*) AS count FROM attempts WHERE client = ? AND at > ?", client, now - HOUR) >= this.config.perHour) {
      return { ok: false, status: 429, error: `You can submit ${this.config.perHour} tasks per hour. Try again later.` };
    }
    const queued = this.count("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('queued', 'running')");
    if (queued >= this.config.maxQueued) {
      return { ok: false, status: 503, error: "The task queue is full. Try again in a few minutes." };
    }
    this.sql.exec("INSERT INTO attempts (client, at) VALUES (?, ?)", client, now);
    this.sql.exec("INSERT INTO tasks (id, kind, input, client, status, created, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
      id, kind, input, client, now, now);
    return { ok: true, id, status: "queued", position: queued + 1 };
  }

  get(id) {
    const row = this.sql.exec("SELECT id, kind, status, result, error, created, updated FROM tasks WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const position = row.status === "queued"
      ? this.count("SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued' AND created <= ?", row.created) : 0;
    return { ...row, position };
  }

  /** Oldest queued task, marked running. Tasks left running by a crash fail instead of silently rerunning. */
  next(now) {
    this.sql.exec("UPDATE tasks SET status = 'failed', error = 'Interrupted; it was not retried. Submit it again.', updated = ? WHERE status = 'running' AND updated < ?",
      now, now - STALE_RUNNING);
    const row = this.sql.exec("SELECT id, kind, input FROM tasks WHERE status = 'queued' ORDER BY created LIMIT 1").toArray()[0];
    if (!row) return null;
    this.sql.exec("UPDATE tasks SET status = 'running', updated = ? WHERE id = ?", now, row.id);
    return row;
  }

  finish(id, outcome, now) {
    this.sql.exec("UPDATE tasks SET status = ?, result = ?, error = ?, input = '', updated = ? WHERE id = ? AND status = 'running'",
      outcome.error ? "failed" : "done", outcome.result ?? null, outcome.error ?? null, now, id);
  }

  hasQueued() {
    return this.count("SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'") > 0;
  }

  prune(now) {
    this.sql.exec("DELETE FROM tasks WHERE status IN ('done', 'failed') AND updated < ?", now - this.config.retentionDays * DAY);
  }
}
