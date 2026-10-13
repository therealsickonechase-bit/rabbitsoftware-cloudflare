import { resolve } from "node:path";
import { realpath, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { withCoordinator } from "../tools/vault-agent/coordinator.mjs";
import { buildAdapters } from "../tools/vault-agent/task-adapters.mjs";
import { withMailbox } from "../tools/vault-agent/mailbox.mjs";
import { digest } from "../workers/vault-agent/src/protocol.mjs";

async function jsonFile(path) {
  const file = await open(resolve(path), "r");
  try {
    if ((await file.stat()).size > 65536) throw new Error("Task/config file exceeds 64 KiB.");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--vault", "--config", "--enqueue", "--run", "--discover", "--list", "--artifact", "--retry", "--prune", "--publish"].includes(key)
        || Object.hasOwn(options, key)) throw new Error("Use --vault PATH and exactly one of --enqueue FILE, --run, --discover, --list, --artifact ID, --retry ID, --prune ID[,ID] or --publish AGENT. Optional --config FILE.");
    if (["--run", "--discover", "--list"].includes(key)) options[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${key} needs a value.`);
      options[key] = args[++index];
    }
  }
  const actions = ["--enqueue", "--run", "--discover", "--list", "--artifact", "--retry", "--prune", "--publish"].filter(key => options[key]);
  if (!options["--vault"] || actions.length !== 1) throw new Error("Supply --vault PATH and exactly one task action.");
  const vault = resolve(options["--vault"]);
  const action = actions[0];
  const definition = action === "--enqueue" ? await jsonFile(options[action]) : undefined;
  const adapters = ["--run", "--discover"].includes(action)
    ? await buildAdapters(vault, options["--config"] ? await jsonFile(options["--config"]) : undefined) : undefined;
  const output = await withCoordinator(vault, async coordinator => {
    if (action === "--enqueue") return coordinator.enqueue(definition);
    if (action === "--run") return coordinator.run(adapters);
    if (action === "--discover") return coordinator.discover(adapters);
    if (action === "--list") return coordinator.list();
    if (action === "--publish") {
      const receipts = [];
      for (const task of coordinator.list().tasks.filter(task => ["done", "failed", "blocked"].includes(task.status))) {
        const content = JSON.stringify({ ...task, result: task.output ? coordinator.artifact(task.output).content : undefined });
        const record = coordinator.state.tasks[task.id];
        let pack;
        if (task.status === "done" && record.definition.capability === "code.repair" && record.request) {
          const request = coordinator.hydrate(record);
          const result = JSON.parse(coordinator.artifact(task.output).content);
          if (request.codingIdentity && result.validation?.runner === "coding-local") {
            const tests = request.sources.filter(source => !source.editable).map(({ path, hash }) => ({ path, hash }));
            if (result.task !== task.id || result.validated !== true || result.validation.identity !== request.codingIdentity
                || JSON.stringify(result.validation.tests) !== JSON.stringify(tests)
                || !Array.isArray(result.changes)) throw new Error("Coding package lacks matching scoped validation evidence.");
            for (const change of result.changes) {
              if (!request.sources.some(source => source.path === change.path && source.editable)
                  || await digest(change.content) !== change.hash) throw new Error("Coding package source does not match validated scope/hash.");
            }
            if (result.changes.length) pack = { value: { version: 1, name: `task-${task.id.slice(0, 16)}`, description: "Tool developed and tested in the approved coding task scope; review before reuse.",
              capabilities: ["code.tool"], task: task.id, files: result.changes.map(({ path, content }) => ({ path, content })) },
              validation: result.validation };
          }
        }
        receipts.push({
          version: 1, sender: "task-coordinator", recipient: options[action], key: await digest(content),
          kind: "task-receipt", route: "local", share: false, content, pack,
        });
      }
      return withMailbox(vault, async mailbox => {
        const published = [];
        for (const { pack, ...receipt } of receipts) {
          published.push(await mailbox.send(receipt));
          if (pack) await mailbox.retainPackage(pack.value, "task-coordinator", pack.validation);
        }
        return published;
      });
    }
    if (action === "--artifact") return coordinator.artifact(options[action]);
    if (action === "--retry") { await coordinator.retry(options[action]); return coordinator.list(); }
    return coordinator.prune(options[action].split(","));
  });
  console.log(JSON.stringify(output, null, 2));
  if (action === "--run" && output.some(task => ["blocked", "failed"].includes(task.status))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
