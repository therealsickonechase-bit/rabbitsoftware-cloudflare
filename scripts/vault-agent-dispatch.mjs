import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requestAgent, inspectRequest, approveRequest, listDispatcher, runDispatcher, reviewDispatcher } from "../tools/vault-agent/dispatcher.mjs";
import { inspectEditor, proposeEditorScope } from "../tools/vault-agent/editor-scope.mjs";
import { buildAdapters } from "../tools/vault-agent/task-adapters.mjs";
import { adapterName, capabilities } from "../tools/vault-agent/task-protocol.mjs";

async function jsonFile(path) {
  const file = await open(resolve(path), "r");
  try {
    if ((await file.stat()).size > 65536) throw new Error("Dispatcher task/config exceeds 64 KiB.");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--vault", "--agent", "--sender", "--request", "--inspect", "--approve", "--list", "--run", "--config", "--discover", "--review", "--editor", "--propose-scope"].includes(key)
        || Object.hasOwn(options, key)) throw new Error("Use --vault PATH --agent NAME and one action: --request FILE --sender NAME, --inspect ID, --approve ID, --list, --discover, --run, --review TASK_ID, --editor FILE or --propose-scope FILE. --config FILE selects operator-owned adapters.");
    if (["--list", "--run", "--discover"].includes(key)) options[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${key} needs a value.`);
      options[key] = args[++index];
    }
  }
  const actions = ["--request", "--inspect", "--approve", "--list", "--run", "--discover", "--review", "--editor", "--propose-scope"].filter(key => options[key]);
  if (!options["--vault"] || !options["--agent"] || actions.length !== 1) throw new Error("Supply a vault, named agent dispatcher and exactly one action.");
  const action = actions[0];
  if ((action === "--request") !== Boolean(options["--sender"])) throw new Error("--sender is required only for --request.");
  if (options["--config"] && !["--run", "--discover", "--review", "--editor", "--propose-scope"].includes(action)) throw new Error("Adapter configuration is used only for execution, discovery, review or editor proposals.");
  const vault = await realpath(resolve(options["--vault"]));
  const agent = adapterName(options["--agent"]);
  let output;
  if (action === "--request") output = await requestAgent(vault, options["--sender"], agent, await jsonFile(options[action]));
  else if (action === "--inspect") output = await inspectRequest(vault, agent, options[action]);
  else if (action === "--approve") output = await approveRequest(vault, agent, options[action]);
  else if (action === "--list") output = await listDispatcher(vault, agent);
  else if (["--editor", "--propose-scope"].includes(action)) {
    if (!options["--config"]) throw new Error("Editor inspection/proposals need an operator-selected --config.");
    const config = await jsonFile(options["--config"]);
    const value = await jsonFile(options[action]);
    output = action === "--editor" ? await inspectEditor(config, value) : await proposeEditorScope(vault, agent, config, value);
  }
  else {
    const adapters = action === "--review" && !options["--config"] ? {}
      : await buildAdapters(vault, options["--config"] ? await jsonFile(options["--config"]) : undefined);
    if (action === "--review") output = await reviewDispatcher(vault, agent, options[action], adapters);
    else if (action === "--discover") {
      output = [];
      for (const [id, adapter] of Object.entries(adapters)) {
        try { output.push({ id, ...capabilities(await adapter.discover()) }); }
        catch (error) { output.push({ id, unavailable: true, error: error.message }); }
      }
    } else output = await runDispatcher(vault, agent, adapters);
  }
  console.log(JSON.stringify(output, null, 2));
  if (action === "--run" && (output.reports.some(task => ["blocked", "failed"].includes(task.status))
      || output.returned.some(result => result.status === "review-required"))) process.exitCode = 1;
  if (action === "--review" && output.verdict === "contradicted") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
