import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCredentials, digest } from "../workers/vault-agent/src/protocol.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--vault")) {
  throw new Error("Use publish-development.mjs [--vault PATH]. Existing vault copies are never overwritten.");
}
const source = await readFile(resolve(repository, "DEVELOPMENT.md"), "utf8");
checkCredentials(source);
const publicCopy = "# Published development guide\n\n"
  + "This copy replaces personal Windows usernames and private task-thread links. "
  + "Commands are examples, not permission to deploy or access services.\n\n"
  + source.replace(/(C:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))[^\\/\r\n]+/gi, "$1developer")
    .replace(/\[Perplexity Computer task thread\]\(https:\/\/www\.perplexity\.ai\/computer\/tasks\/[^)]+\)/g,
      "[Perplexity Computer](https://www.perplexity.ai/)");
checkCredentials(publicCopy);
await writeFile(resolve(repository, "site", "development.md"), publicCopy);
let vaultCopy;
if (args.length) {
  const vault = await realpath(resolve(args[1]));
  vaultCopy = resolve(vault, "Cloud Agents", "DEVELOPMENT.md");
  await mkdir(dirname(vaultCopy), { recursive: true });
  await writeFile(vaultCopy, source, { flag: "wx" });
  if (await digest(await readFile(vaultCopy, "utf8")) !== await digest(source)) {
    throw new Error("Vault document hash verification failed.");
  }
}
console.log(JSON.stringify({
  sourceHash: await digest(source), publicHash: await digest(publicCopy),
  sourceBytes: Buffer.byteLength(source), publicBytes: Buffer.byteLength(publicCopy),
  vaultCopy, personalUsernamesReplaced: true, privateTaskLinksRemoved: true,
}, null, 2));
