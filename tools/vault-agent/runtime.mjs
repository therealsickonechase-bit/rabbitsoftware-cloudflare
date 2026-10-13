import { readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { safePath } from "../../scripts/vault-agent-sync.mjs";
import { digest, shared, checkCredentials, readJson } from "../../workers/vault-agent/src/protocol.mjs";
import { runAgent, actionSchema, validatePrompt } from "./engine.mjs";
import { withMailbox } from "./mailbox.mjs";
import { requestAgent } from "./dispatcher.mjs";
import { networkFetch, proxySettings } from "./network-transport.mjs";
import { persistRunReport } from "./run-report.mjs";
import { cloudAccessTool } from "./cloud-access.mjs";
import { corpusTool, tokenFromFile } from "./corpus.mjs";
import { Agent } from "undici";

export const LOCAL_ROOTS = ["Agents", "Workers", "Platform", "Pathways", "Tools", "Cloud Agents/Knowledge", "Cloud Agents/Learned"];
const LOCAL_DOCS = ["Cloud Agents/Cloud Agents.md", "Cloud Agents/Vault Agent Service.md",
  "Cloud Agents/Agent Dispatcher.md", "Cloud Agents/TypeScript and Java Task Mailbox.md",
  "Cloud Agents/Portable Network Transports.md", "Cloud Agents/Automatic Reports and Repair Challenges.md"];

function allowedPath(path) {
  if (typeof path !== "string" || !path.endsWith(".md") || !(LOCAL_DOCS.includes(path) || LOCAL_ROOTS.some(root => path.startsWith(`${root}/`)))
      || path.split("/").some(part => !part || part.startsWith(".") || /[\\:\x00-\x1f]/.test(part))) {
    throw new Error("Read a Markdown note under a registered local knowledge root.");
  }
  return path;
}

async function boundedNote(vault, path, remote) {
  const local = await safePath(vault, allowedPath(path));
  if ((await lstat(local)).size > 16000) throw new Error(`Note exceeds 16000 bytes: ${path}`);
  const content = await readFile(local, "utf8");
  if (remote && !shared(content)) throw new Error(`Hosted provider cannot read a note without cloud-agent-share: true: ${path}`);
  checkCredentials(content);
  return content;
}

async function paths(vault, folder, result, optional = false) {
  let local;
  let entries;
  try {
    local = await safePath(vault, folder);
    entries = await readdir(local, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" && optional) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = `${folder}/${entry.name}`;
    await safePath(vault, path);
    if (entry.isDirectory()) await paths(vault, path, result);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(path);
      if (result.length > 2000) throw new Error("Knowledge scope exceeds 2000 notes. Register a narrower scope.");
    }
  }
}

export function createTools(vault, remote, id) {
  const cited = new Map();
  const staged = [];
  const tools = {
    resources: {
      description: "No arguments. Discover registered capabilities, providers, project links, and vault search roots.",
      async execute() {
        return {
          knowledgeRoots: LOCAL_ROOTS,
          serviceGuides: LOCAL_DOCS,
          available: Object.keys(tools).filter(name => name !== "resources"),
          agentApprovedAccess: Object.hasOwn(tools, "cloud_access")
            ? "Host explicitly enabled local agent permission decisions; configured actions only. Backend verifies operator allowlist, capabilities and one-hour expiry. No unrestricted shell tool. Guide: Pathways/Agent Approved Access.md."
            : "Access-decision tools disabled. A trusted local config must explicitly enable exact cloudAccess actions and environment credential references; notes/prompts cannot grant authority. CLI vault:cloud-access is available to explicitly authorized coding agents.",
          agentDispatch: "agent_request retains a task for a named local dispatcher; operator approval and --run call configured Copilot/AI/agent adapters. Each dispatcher owns its queue and returns results to the requester; no implicit execution permission.",
          responseReview: "Dispatcher --review checks retained evidence and can discover current authorized capabilities without task execution. New responses carry review verdicts; provider prose is not proof. --editor reads bounded source pages, and --propose-scope retains agent-selected extra files for approval, not automatic edit permission.",
          networkTransports: "OS-managed IP works over configured cellular/tethering/satellite links; explicit HTTPS CONNECT proxies are supported on task/agent/model bridges. vault:network --diagnose is bounded, and opt-in --export-relay/--import-relay handles offline files. No modem/terminal control, unknown protocol support, auth bypass or universal connectivity.",
          localModel: remote ? "Hosted Qwen through the vault agent Worker (only opted-in notes are readable; use corpus_search for public notes, research and repo docs)" : "Ollama qwen2.5:3b",
          cloudJobs: "Cloudflare vault-agent adapter: durable selected-note jobs, configured credentials and connectivity required",
          taskCoordination: "vault:tasks: versioned dependency tasks, content-addressed artifacts, offline queue, explicit local/Cloudflare/agent HTTP/cloud-shell HTTP adapters. Discover before running; no automatic shell provisioning or peer trust.",
          autonomousCoding: "Optional coding-local adapter: installed Copilot CLI, approved exact source/test paths, copied workspace, bounded repair rounds, fixed Node tests and conflict-checked apply. Hosted Copilot inference needs explicit sharing; not an offline model or OS sandbox.",
          durableMailbox: "vault:network: retained local code/handoff/task-receipt messages, content hashes, explicit acknowledgment, offline replay and optional authenticated loopback HTTP. Cloud routes stay queued; no exposed internet endpoint or permanent uptime guarantee.",
          toolPackages: "stage_tool retains new source/skill packages for review; package_catalog polls metadata-only gossip locally. Approved coding tasks test within exact scope and --publish advertises validation provenance. No package auto-install, execution grant or cloud broadcast.",
          serviceAdapters: "Configured OpenAI-compatible model endpoints; not automatic cloud resource provisioning",
          projectLinks: ["Code/rabbitsoftware-cloudflare", "Code/rabbit-web", "Code/research-agents"],
          extendedExecution: "Open the Vault Orchestrator workspace agent in VS Code/Copilot for actual available MCP, web, code, terminal and skill tools. This local runtime has no shell or deployment capability.",
          learning: "Cited, approved knowledge notes; no model retraining",
        };
      },
    },
    search: {
      description: 'Arguments {"query":"terms"}. Search local knowledge notes; return up to 8 cited snippets. Hosted providers only see opted-in notes.',
      async execute({ query }) {
        if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("Search needs 1-200 characters.");
        const files = [];
        const missingRoots = [];
        for (const root of LOCAL_ROOTS) {
          const before = files.length;
          await paths(vault, root, files, true);
          if (files.length === before) missingRoots.push(root);
        }
        const missingGuides = [];
        for (const path of LOCAL_DOCS) {
          try {
            await lstat(await safePath(vault, path));
            files.push(path);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            missingGuides.push(path);
          }
        }
        if (files.length > 2000) throw new Error("Knowledge scope exceeds 2000 notes. Register a narrower scope.");
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = [];
        let oversized = 0;
        for (const path of files) {
          const local = await safePath(vault, path);
          if ((await lstat(local)).size > 16000) { oversized++; continue; }
          const content = await readFile(local, "utf8");
          if (remote && !shared(content)) continue;
          const lower = `${path}\n${content}`.toLowerCase();
          const score = terms.filter(term => lower.includes(term)).length;
          if (!score) continue;
          await boundedNote(vault, path, remote);
          const at = Math.max(0, content.toLowerCase().indexOf(terms.find(term => content.toLowerCase().includes(term)) ?? ""));
          matches.push({ path, score, excerpt: content.slice(Math.max(0, at - 100), at + 500) });
        }
        matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        const selected = matches.slice(0, 8);
        for (const match of selected) cited.set(match.path, { path: match.path, hash: await digest(await boundedNote(vault, match.path, remote)) });
        return { matches: selected, oversizedNotesExcluded: oversized, emptyOrMissingRoots: missingRoots, missingGuides, totalMatches: matches.length };
      },
    },
    read: {
      description: 'Arguments {"path":"vault-relative Markdown path"}. Read one registered note and record its source hash.',
      async execute({ path }) {
        const content = await boundedNote(vault, path, remote);
        cited.set(path, { path, hash: await digest(content) });
        return { path, content };
      },
    },
    stage_proposal: {
      description: 'Arguments {"title":"title","content":"Markdown or fenced code proposal"}. Stage a proposed build, edit, code, art, service design, or other output. Does not execute it or overwrite originals.',
      async execute(args) {
        return stage("proposal", args);
      },
    },
    stage_learning: {
      description: 'Arguments {"title":"title","content":"knowledge with source citations"}. Stage reusable knowledge based on notes already read. Human approval is required to make it searchable memory.',
      async execute(args) {
        if (!cited.size) throw new Error("Read source evidence before staging learning.");
        return stage("learning", args);
      },
    },
    stage_tool: {
      description: 'Arguments {"version":1,"name":"lowercase-name","description":"one-line purpose","capabilities":["code.tool"],"files":[{"path":"tool.mjs","content":"source text"},{"path":"SKILL.md","content":"usage and limits"}]}. Retain a tool/skill package in its own mailbox catalog and vault guide. Does not execute, test or install it; scoped coding tasks validate approved sources separately.',
      async execute(args) {
        const result = await withMailbox(vault, mailbox => mailbox.retainPackage(args, "note-agent"));
        const path = `Cloud Agents/Network/Packages/${result.id}.md`;
        if (!staged.includes(path)) staged.push(path);
        return { package: result.id, guide: path, review: result.review, executable: false };
      },
    },
    package_catalog: {
      description: 'Arguments {"cursor":0}. Poll at most 16 local tool-package metadata advertisements; fetch content using approved host tools only. Cursor-based pull, no automatic broadcasts.',
      async execute({ cursor }) {
        if (remote) throw new Error("Hosted note providers cannot enumerate private local package metadata.");
        return withMailbox(vault, mailbox => mailbox.gossip(cursor));
      },
    },
    agent_request: {
      description: 'Arguments {"dispatcher":"vault-dispatcher","task":{"version":1,"capability":"code.repair","instruction":"scoped work","adapters":["coding"],"dependsOn":[],"notes":[],"share":true}}. Retain a request for a named dispatcher as sender note-agent. Does not approve or execute it. Operator approval and configured adapter permissions are required.',
      async execute({ dispatcher, task }) {
        if (remote) throw new Error("Hosted note providers cannot submit private local agent requests.");
        const sent = await requestAgent(vault, "note-agent", dispatcher, task);
        return { request: sent.id, status: sent.status, requiresApproval: true, executable: false };
      },
    },
  };
  async function stage(kind, { title, content }) {
    if (typeof title !== "string" || !title.trim() || title.length > 200
        || typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > 12000) {
      throw new Error("Stage a title (1-200 characters) and content (1-12000 UTF-8 bytes).");
    }
    const proposal = { id, kind, title: title.trim(), content, sources: [...cited.values()] };
    checkCredentials(content);
    const relative = `Cloud Agents/Proposals/${id}-${staged.length}.json`;
    const local = await safePath(vault, relative, true);
    await writeFile(local, JSON.stringify(proposal, null, 2), { flag: "wx" });
    const markdown = `---\ncloud-agent-share: false\n---\n# ${proposal.title.replace(/[\r\n]/g, " ")}\n\nKind: ${kind}; staged only, not applied.\n\n${content}\n\n## Sources\n\n${proposal.sources.map(source => `- [[${source.path.replace(/\.md$/, "")}]] (SHA-256 ${source.hash})`).join("\n") || "No vault source was read."}\n\nCompanion review data: ${relative}\n`;
    await writeFile(await safePath(vault, relative.replace(/\.json$/, ".md"), true), markdown, { flag: "wx" });
    staged.push(relative);
    return { staged: relative, applied: false, requiresApproval: true };
  }
  return { tools, staged, cited };
}

export async function generator(config, transport = networkFetch, names = ["resources", "search", "read", "stage_proposal", "stage_learning", "stage_tool", "package_catalog", "agent_request"]) {
  if (!config || !["ollama", "openai-compatible"].includes(config.type)) {
    throw new Error("Choose an explicit ollama or openai-compatible provider.");
  }
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("Configure a model.");
  if (config.type === "openai-compatible" && config.allowRemote !== true) throw new Error("Hosted inference needs explicit allowRemote approval.");
  const proxy = proxySettings(config.proxy);
  if (proxy && config.type === "ollama") throw new Error("Local Ollama must not be routed through a proxy.");
  let url;
  if (config.type === "ollama") {
    if (config.baseUrl && config.baseUrl !== "http://127.0.0.1:11434") throw new Error("Ollama must remain on its fixed loopback endpoint.");
    url = "http://127.0.0.1:11434/api/chat";
  } else {
    url = new URL(config.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("Configure a credential-free HTTPS chat-completions URL.");
    if (typeof config.token !== "string" || !config.token) throw new Error("Set the hosted provider token locally.");
  }
  return async messages => {
    const localDispatcher = config.type === "ollama" && transport === networkFetch
      ? new Agent({ headersTimeout: 600000, bodyTimeout: 600000, connections: 1 })
      : undefined;
    try {
    const response = await transport(String(url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(config.type === "ollama" ? 600000 : 180000),
      ...(localDispatcher ? { dispatcher: localDispatcher } : {}),
      headers: { "Content-Type": "application/json", ...(config.type === "openai-compatible" ? { Authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify(config.type === "ollama"
        ? { model: config.model, messages, stream: false, format: actionSchema(names), options: { temperature: 0.2, num_predict: 1500, num_ctx: 8192 } }
        : { model: config.model, messages, stream: false, temperature: 0.2, max_tokens: 2000, response_format: { type: "json_object" } }),
    }, proxy);
    const value = await readJson(response);
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}; inspect the selected provider. No fallback was attempted.`);
    const answer = config.type === "ollama" ? value.message?.content : value.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("Provider returned no answer.");
    return answer;
    } finally {
      if (localDispatcher) await localDispatcher.destroy();
    }
  };
}

export async function execute(vault, prompt, config, transport) {
  validatePrompt(prompt);
  checkCredentials(prompt);
  const id = crypto.randomUUID();
  const context = createTools(vault, config.type !== "ollama", id);
  const reportRelative = `Cloud Agents/Results/run-${id}.json`;
  const reportPath = await safePath(vault, reportRelative, true);
  const report = { version: 1, id, started: new Date().toISOString(), status: "running",
    provider: config.type, model: config.model, promptHash: await digest(prompt), calls: [],
    correctness: "unverified", independentAudit: false, staged: [] };
  await persistRunReport(reportPath, report, true);
  const persist = () => persistRunReport(reportPath, report);
  const record = async entry => {
    const key = await digest(JSON.stringify(entry.arguments));
    const last = report.calls.at(-1);
    if (entry.origin === "model" && last?.status === "running" && last.name === entry.name && last.argumentsHash === key) last.status = entry.status;
    else report.calls.push({ name: entry.name, origin: entry.origin, status: entry.status, argumentsHash: key });
    await persist();
  };
  const initialCalls = [];
  const call = async (name, args) => {
    const entry = { name, arguments: args, origin: "host", status: "running" };
    await record(entry);
    let output;
    try { output = await context.tools[name].execute(args); }
    catch (error) { report.calls.at(-1).status = "failed"; await persist(); throw error; }
    report.calls.at(-1).status = "succeeded";
    await persist();
    initialCalls.push({ name, arguments: args, output });
    return output;
  };
  try {
  if (config.cloudStatusOnly === true && (config.type !== "ollama"
      || config.cloudAccess?.allowRemote !== true || !config.cloudAccess.actions?.includes("status"))) {
    throw new Error("A status-only task requires explicitly enabled local caller tools.");
  }
  if (config.cloudAccess !== undefined) {
    context.tools.cloud_access = cloudAccessTool(config.cloudStatusOnly === true
      ? { ...config.cloudAccess, actions: ["status"] } : config.cloudAccess, config.type !== "ollama", transport);
  }
  const corpusSources = new Map();
  if (config.corpus !== undefined && config.cloudStatusOnly !== true) {
    const tool = corpusTool(config.corpus, transport);
    context.tools.corpus_search = { ...tool, async execute(args) {
      const found = await tool.execute(args);
      for (const match of found.matches) corpusSources.set(`${match.source}:${match.path}`, match);
      return found;
    } };
  }
  if (config.cloudStatusOnly === true) {
    for (const name of Object.keys(context.tools)) if (name !== "cloud_access") delete context.tools[name];
  }
  const generate = await generator(config, transport, Object.keys(context.tools));
  if (config.cloudStatusOnly !== true) {
  await call("resources", {});
  const inventory = initialCalls.at(-1).output;
  initialCalls.at(-1).output = { knowledgeRoots: inventory.knowledgeRoots, serviceGuides: inventory.serviceGuides, available: inventory.available, learning: inventory.learning, initialResourceSummary: true };
  const search = await call("search", { query: prompt.slice(0, 200) });
  initialCalls.at(-1).output = { ...search, matches: search.matches.slice(0, 2), initialExcerptLimit: 2 };
  const visibleSources = new Set(search.matches.slice(0, 2).map(match => match.path));
  for (const path of context.cited.keys()) {
    if (!visibleSources.has(path)) context.cited.delete(path);
  }
  const explicit = [...LOCAL_DOCS.filter(path => prompt.includes(path)),
    ...[...prompt.matchAll(/(?:Agents|Workers|Platform|Pathways|Tools|Cloud Agents\/(?:Knowledge|Learned))\/[^\r\n"<>]+?\.md\b/g)].map(match => match[0])];
  const selected = [...new Set(explicit.length ? explicit : search.matches.map(match => match.path))].slice(0, 2);
  for (const path of selected) await call("read", { path });
  // Hosted runs can read only opted-in notes, so ground every task in the corpus; the model may search again.
  if (context.tools.corpus_search) await call("corpus_search", { query: prompt.slice(0, 500) });
  }
  const result = await runAgent(prompt, context.tools, generate, {
    initialCalls, requiredCalls: config.cloudStatusOnly === true
      ? [{ name: "cloud_access", arguments: { action: "status", input: {} } }] : config.requiredCalls ?? [], onCall: record,
  });
  const relative = `Cloud Agents/Results/local-${id}.md`;
  const path = await safePath(vault, relative, true);
  const sources = [...context.cited.values()];
  const content = `---\ncloud-agent-share: false\n---\n# Vault agent result\n\nProvider: ${config.type}; model: ${config.model}\n\n${result.answer}\n\n## Evidence\n\n${sources.map(source => `- [[${source.path.replace(/\.md$/, "")}]] (SHA-256 ${source.hash})`).join("\n") || "No vault source was read."}${corpusSources.size ? `\n\n## Corpus passages retrieved\n\n${[...corpusSources.values()].map(match => `- ${match.source}: ${match.source === "vault" ? `[[${match.path.replace(/\.md$/, "")}]]` : match.url ? `[${match.title || match.path}](${match.url})` : `\`${match.path}\``} (score ${match.score})`).join("\n")}` : ""}\n\n## Staged outputs\n\n${context.staged.map(path => `- [[${path.replace(/\.json$/, "")}]] (review data: ${path})`).join("\n") || "None."}\n`;
  await writeFile(path, content, { flag: "wx" });
  report.status = "completed";
  report.result = relative;
  report.answerHash = await digest(result.answer);
  return { ...result, path: relative, report: reportRelative, staged: context.staged };
  } catch (error) {
    report.status = "failed";
    report.errorType = ["Error", "TypeError", "SyntaxError", "TimeoutError", "AbortError"].includes(error.name) ? error.name : "Error";
    throw error;
  } finally {
    report.finished = new Date().toISOString();
    report.staged = [...context.staged];
    report.sources = [...context.cited.values()];
    await persist();
  }
}

export async function approveLearning(vault, relative) {
  if (!/^Cloud Agents\/Proposals\/[a-f0-9-]+-\d+\.json$/.test(relative)) throw new Error("Approve a generated proposal path.");
  const sourcePath = await safePath(vault, relative);
  if ((await lstat(sourcePath)).size > 32768) throw new Error("Proposal exceeds its size limit.");
  const proposal = JSON.parse(await readFile(sourcePath, "utf8"));
  if (proposal.kind !== "learning" || typeof proposal.content !== "string" || !Array.isArray(proposal.sources) || !proposal.sources.length) {
    throw new Error("Only cited learning proposals can be promoted automatically. Apply code or other proposals through the reviewed workspace agent.");
  }
  for (const source of proposal.sources) {
    if (await digest(await boundedNote(vault, source.path, false)) !== source.hash) throw new Error(`Learning source changed: ${source.path}`);
  }
  const destination = `Cloud Agents/Learned/${relative.split("/").at(-1).replace(".json", ".md")}`;
  const path = await safePath(vault, destination, true);
  const markdown = `---\ncloud-agent-share: false\n---\n# ${proposal.title.replace(/[\r\n]/g, " ")}\n\n${proposal.content}\n\n## Sources\n\n${proposal.sources.map(source => `- [[${source.path.replace(/\.md$/, "")}]] (SHA-256 ${source.hash})`).join("\n")}\n`;
  await writeFile(path, markdown, { flag: "wx" });
  return destination;
}

export async function loadConfig(path) {
  if (!path) return { type: "ollama", model: "qwen2.5:3b" };
  const data = JSON.parse(await readFile(path, "utf8"));
  const config = data.provider ?? data;
  // Hosted credentials come from a file outside the vault, never from this (published) config file.
  if (config.type === "openai-compatible" && config.tokenFile && !config.token) {
    config.token = await tokenFromFile(config.tokenFile, config.tokenName);
  }
  if (config.corpus && !config.corpus.token) {
    config.corpus = { ...config.corpus, token: config.corpus.tokenFile
      ? await tokenFromFile(config.corpus.tokenFile, config.corpus.tokenName) : config.token };
  }
  return config;
}
