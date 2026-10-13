import { open, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withMailbox } from "../tools/vault-agent/mailbox.mjs";
import { mailboxServer } from "../tools/vault-agent/mailbox-server.mjs";
import { exportRelay, importRelay, RELAY_LIMITS } from "../tools/vault-agent/offline-relay.mjs";
import { diagnoseNetworks } from "../tools/vault-agent/network-transport.mjs";

async function jsonFile(path, maxBytes = 128 * 1024) {
  const file = await open(resolve(path), "r");
  try {
    if ((await file.stat()).size > maxBytes) throw new Error(`Input file exceeds ${maxBytes} bytes.`);
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--vault", "--send", "--receive", "--read", "--ack", "--prune", "--list", "--serve", "--package", "--fetch-package", "--approve-package", "--gossip", "--export-relay", "--import-relay", "--output", "--diagnose", "--config", "--resolve-dns"].includes(key) || Object.hasOwn(options, key)) throw new Error("Use one mailbox action with --vault, or --diagnose [--config FILE] [--resolve-dns]. Relay: --export-relay IDS --output FILE, or --import-relay FILE.");
    if (["--list", "--diagnose", "--resolve-dns"].includes(key)) options[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${key} needs a value.`);
      options[key] = args[++index];
    }
  }
  const actions = Object.keys(options).filter(key => !["--vault", "--output", "--config", "--resolve-dns"].includes(key));
  if (actions.length !== 1) throw new Error("Supply exactly one network action.");
  const action = actions[0];
  if ((action === "--export-relay") !== Boolean(options["--output"])) throw new Error("--output is required only for --export-relay.");
  if (action !== "--diagnose" && (options["--config"] || options["--resolve-dns"])) throw new Error("--config/--resolve-dns are used only for diagnostics.");
  if (action === "--diagnose") {
    console.log(JSON.stringify(await diagnoseNetworks(options["--config"] ? await jsonFile(options["--config"]) : {}, Boolean(options["--resolve-dns"])), null, 2));
    return;
  }
  if (!options["--vault"]) throw new Error("Mailbox actions require --vault PATH.");
  const vault = await realpath(resolve(options["--vault"]));
  if (action === "--serve") {
    const port = Number(options[action]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a loopback port from 1024 to 65535.");
    const server = mailboxServer(vault, process.env.VAULT_MAILBOX_TOKEN);
    await withMailbox(vault, mailbox => mailbox.list());
    await new Promise((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
    console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, version: 1, cloudDelivery: false }));
    const close = () => server.close(() => { process.exitCode = 0; });
    process.once("SIGINT", close); process.once("SIGTERM", close);
    server.on("error", error => { console.error(`Mailbox server error: ${error.code ?? error.name}`); process.exitCode = 1; server.close(); });
    return server;
  }
  const value = ["--send", "--ack", "--package", "--approve-package", "--import-relay"].includes(action)
    ? await jsonFile(options[action], action === "--import-relay" ? RELAY_LIMITS.bytes : undefined) : undefined;
  const result = await withMailbox(vault, mailbox => {
    if (action === "--send") return mailbox.send(value);
    if (action === "--export-relay") return exportRelay(mailbox, options[action].split(","));
    if (action === "--import-relay") return importRelay(mailbox, value);
    if (action === "--ack") return mailbox.acknowledge(value);
    if (action === "--package") return mailbox.retainPackage(value, "local-cli");
    if (action === "--fetch-package") return mailbox.readPackage(options[action]);
    if (action === "--approve-package") return mailbox.approvePackage(value);
    if (action === "--gossip") return mailbox.gossip(Number(options[action]));
    if (action === "--receive") return mailbox.receive(options[action]);
    if (action === "--read") {
      const [recipient, id, extra] = options[action].split(":");
      if (extra !== undefined) throw new Error("Read with AGENT:ID.");
      return mailbox.read(recipient, id);
    }
    if (action === "--prune") return mailbox.prune(options[action].split(","));
    return mailbox.list();
  });
  if (action === "--export-relay") {
    await writeFile(resolve(options["--output"]), JSON.stringify(result), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ bundle: result.id, messages: result.messages.length, output: resolve(options["--output"]), acknowledged: false }));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
