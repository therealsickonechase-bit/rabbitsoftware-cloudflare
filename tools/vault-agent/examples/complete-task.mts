import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { VaultMailbox } from "../clients/VaultMailbox.mts";

const [entrypoint, vault, sender, recipient, task, revision, resultFile, extra] = process.argv.slice(2);
if (!entrypoint || !vault || !sender || !recipient || !task || !revision || !resultFile || extra !== undefined) {
  throw new Error("Usage: node complete-task.mts CLI VAULT SENDER RECIPIENT TASK_SHA256 REVISION RESULT_FILE");
}
if ((await stat(resultFile)).size > 65536) throw new Error("Result file exceeds 64 KiB; split the output without truncation.");
const mailbox = new VaultMailbox({ entrypoint: resolve(entrypoint), vault: resolve(vault), sender, recipient });
console.log(JSON.stringify(await mailbox.completeTask(task, revision, await readFile(resultFile, "utf8"))));
