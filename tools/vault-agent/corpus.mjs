// corpus_search tool: semantic search over the Vectorize corpus kept by the vault agent Worker.
// The corpus holds public vault notes, the public research corpus and repository docs (see scripts/vault-corpus-index.mjs).
import { readFile, lstat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { readJson } from "../../workers/vault-agent/src/protocol.mjs";
import { networkFetch } from "./network-transport.mjs";

const SOURCES = ["vault", "corpus", "repo"];

export function serviceOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Configure the corpus service origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use a credential-free HTTPS origin for the corpus service.");
  }
  return url.origin;
}

/** Read one named credential from an env-format file kept outside the vault (the vault is published to GitHub). */
export async function tokenFromFile(path, name = "VAULT_AGENT_TOKEN") {
  if (typeof path !== "string" || !path) throw new Error("Configure tokenFile.");
  if ((await lstat(path)).size > 16384) throw new Error("Credential file exceeds 16384 bytes.");
  const token = parseEnv(await readFile(path, "utf8"))[name];
  if (typeof token !== "string" || token.length < 32 || token.length > 4096 || /[^\x20-\x7e]/.test(token)) {
    throw new Error(`${name} is missing or invalid in the credential file.`);
  }
  return token;
}

export async function postJson(origin, path, token, body, transport = networkFetch) {
  const response = await transport(new URL(path, origin).href, {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Corpus service HTTP ${response.status}. No automatic retry.`);
  }
  return readJson(response, 262144);
}

export function corpusTool(config, transport = networkFetch) {
  const origin = serviceOrigin(config.url);
  if (config.allowRemote !== true) throw new Error("Corpus search sends queries to Cloudflare; set allowRemote: true.");
  return {
    description: 'Arguments {"query":"what to look up","source":"vault|corpus|repo (optional)"}. Semantic search over public vault notes, the public research corpus and project repository docs. Returns up to 6 cited passages with paths/URLs. Use it when the task needs project or research facts you have not read yet.',
    async execute({ query, source }) {
      if (typeof query !== "string" || !query.trim() || query.length > 500) throw new Error("Corpus search needs a 1-500 character query.");
      if (source !== undefined && !SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(", ")}.`);
      const result = await postJson(origin, "/v1/corpus/search", config.token, { query, topK: 6, ...(source ? { source } : {}) }, transport);
      if (!Array.isArray(result.matches)) throw new Error("Corpus service returned no matches list.");
      return { matches: result.matches.slice(0, 6).map(match => ({
        source: match.source, path: match.path, title: match.title, url: match.url, score: match.score,
        text: typeof match.text === "string" ? match.text.slice(0, 1500) : "",
      })) };
    },
  };
}
