import { DurableObject } from "cloudflare:workers";
import { Board, limits } from "./board.mjs";
import handler, { runTask } from "./handler.mjs";

const PER_ALARM = 3;

export class TaskBoard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.board = new Board(ctx.storage.sql, limits(env));
    this.board.init();
  }

  async submit(task) {
    const verdict = this.ctx.storage.transactionSync(() => this.board.submit(task, Date.now()));
    if (verdict.ok && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return verdict;
  }

  get(id) {
    return this.board.get(id);
  }

  // Tasks run one at a time, a few per alarm, so a burst cannot fan out into parallel inference.
  async alarm() {
    for (let i = 0; i < PER_ALARM; i += 1) {
      const task = this.ctx.storage.transactionSync(() => this.board.next(Date.now()));
      if (!task) break;
      let outcome;
      try { outcome = { result: await runTask(this.env, task) }; }
      catch (error) {
        console.error(JSON.stringify({ event: "visitor_task_failed", type: error?.name || "Error" }));
        outcome = { error: "Hosted Qwen could not complete this task. It was not retried; submit it again later." };
      }
      this.ctx.storage.transactionSync(() => this.board.finish(task.id, outcome, Date.now()));
    }
    this.board.prune(Date.now());
    if (this.board.hasQueued()) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}

export default handler;
