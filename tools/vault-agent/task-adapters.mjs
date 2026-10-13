import { createTools, generator, loadConfig } from "./runtime.mjs";
import { runAgent } from "./engine.mjs";
import { digest, normalizeJob, readJson, validId } from "../../workers/vault-agent/src/protocol.mjs";
import { adapterName, artifactContent, capabilities } from "./task-protocol.mjs";
import { codingAdapter } from "./coding-adapter.mjs";
import { networkFetch, proxySettings } from "./network-transport.mjs";

class TransportError extends Error {
  constructor(message) { super(message); this.retryable = true; }
}

function remoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Adapters need a credential-free HTTPS base URL.");
  return url.href.replace(/\/$/, "");
}

async function request(transport, url, token, method = "GET", body) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text && new TextEncoder().encode(text).length > 65536) throw new Error("Adapter request exceeds 64 KiB; narrow the task inputs.");
  let response;
  try {
    response = await transport(url, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(text ? { body: text } : {}),
    });
  } catch (error) {
    if (["TypeError", "TimeoutError", "AbortError"].includes(error.name)) throw new TransportError("Adapter transport unavailable or timed out; prepared input retained.");
    throw error;
  }
  if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
    await response.body?.cancel();
    throw new TransportError(`Adapter HTTP ${response.status}; prepared input retained.`);
  }
  if (!response.ok && response.status !== 409) {
    await response.body?.cancel();
    throw new Error(`Adapter HTTP ${response.status}; inspect authorization and configuration.`);
  }
  try { return { status: response.status, value: await readJson(response) }; } catch (error) {
    if (["TypeError", "TimeoutError", "AbortError"].includes(error.name)) throw new TransportError("Adapter response stream interrupted; prepared input retained.");
    throw error;
  }
}

async function snapshot(vault, definition, artifacts) {
  const { tools } = createTools(vault, definition.share, crypto.randomUUID());
  const notes = [];
  for (const path of definition.notes) notes.push(await tools.read.execute({ path }));
  return {
    version: 1, definition, notes,
    inputs: artifacts.map(({ task, artifact, content }) => ({ task, artifact, content })),
  };
}

function cloudJob(data) {
  const notes = data.notes.map(note => ({ path: note.path, content: note.content }));
  for (const input of new Map(data.inputs.map(input => [input.artifact, input])).values()) {
    notes.push({ path: `Cloud Agents/Knowledge/Dependency-${input.artifact}.md`, content: `---\ncloud-agent-share: true\n---\n${input.content}` });
  }
  return normalizeJob({ mode: "task", instruction: data.definition.instruction, notes });
}

export async function buildAdapters(vault, config = { adapters: [{ id: "local", type: "local" }] }, transport = networkFetch) {
  if (!Array.isArray(config.adapters) || !config.adapters.length || config.adapters.length > 16) throw new Error("Configure 1-16 adapters.");
  const adapters = Object.create(null);
  for (const entry of config.adapters) {
    const id = adapterName(entry.id);
    if (Object.hasOwn(adapters, id)) throw new Error("Duplicate configured adapter ID.");
    const proxy = proxySettings(entry.proxy);
    if (proxy && ["local", "coding-local"].includes(entry.type)) throw new Error("Local/Copilot adapters do not accept proxy control here; configure their runtime's supported network settings separately.");
    if (entry.type === "coding-local") {
      adapters[id] = await codingAdapter(entry);
      continue;
    }
    if (entry.type === "local" || entry.type === "model") {
      const provider = await loadConfig(entry.providerConfig);
      if (proxy && provider.proxy && JSON.stringify(proxySettings(provider.proxy)) !== JSON.stringify(proxy)) throw new Error("Conflicting model proxy configuration.");
      if (proxy) provider.proxy = proxy;
      const remote = entry.type === "model";
      if (!remote && provider.type !== "ollama") throw new Error("Local adapter requires Ollama; hosted models need a separately authorized model adapter.");
      if (remote && (entry.allowRemote !== true || provider.type !== "openai-compatible")) throw new Error("Model adapter needs allowRemote: true and an OpenAI-compatible providerConfig.");
      await generator(provider, transport, []);
      const available = remote ? ["notes.answer", "text.transform"] : ["notes.search", "notes.read", "notes.answer", "text.transform"];
      adapters[id] = {
        remote, identity: await digest(JSON.stringify({ type: entry.type, model: provider.model, baseUrl: provider.baseUrl, url: provider.url,
          ...(provider.proxy ? { proxy: proxySettings(provider.proxy) } : {}) })),
        async discover() { return { versions: [1], capabilities: available, idempotentTasks: true, peers: [] }; },
        async prepare({ id: task, definition, artifacts }) {
          if (definition.capability === "notes.read" && !definition.notes.length) throw new Error("notes.read needs explicit note paths.");
          if (definition.capability === "notes.search" && definition.instruction.length > 200) throw new Error("notes.search query must be at most 200 characters.");
          const data = await snapshot(vault, definition, artifacts);
          if (definition.capability === "notes.search") {
            data.search = await createTools(vault, definition.share, task).tools.search.execute({ query: definition.instruction });
          } else if (definition.capability === "notes.answer" && !data.notes.length) {
            const context = createTools(vault, definition.share, task);
            const found = await context.tools.search.execute({ query: definition.instruction.slice(0, 200) });
            for (const match of found.matches.slice(0, 2)) data.notes.push(await context.tools.read.execute({ path: match.path }));
          }
          return { id: task, ...data };
        },
        async advance(data) {
          if (data.definition.capability === "notes.search") return { content: JSON.stringify(data.search) };
          if (data.definition.capability === "notes.read") return { content: JSON.stringify(data.notes) };
          // A frozen snapshot prevents queued work from silently consuming changed vault files.
          const evidence = JSON.stringify({ notes: data.notes, inputs: data.inputs });
          const selectedTransport = async (url, options, route) => {
            const response = await transport(url, options, route);
            if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
              await response.body?.cancel();
              throw new TransportError(`Selected model HTTP ${response.status}; frozen input retained.`);
            }
            return response;
          };
          const ask = await generator(provider, selectedTransport, []);
          const result = await runAgent(data.definition.instruction, {}, async messages => {
            try { return await ask(messages); } catch (error) {
              if (["TypeError", "TimeoutError", "AbortError"].includes(error.name)) throw new TransportError("Selected model connection or response stream interrupted; frozen input retained.");
              throw error;
            }
          }, {
            initialCalls: [{ name: "snapshot", arguments: {}, output: evidence }],
          });
          return { content: artifactContent(result.answer) };
        },
      };
      continue;
    }
    if (!["cloudflare-jobs", "agent-http", "cloud-shell-http"].includes(entry.type)) throw new Error("Unsupported adapter type.");
    if (entry.allowRemote !== true) throw new Error("Remote adapter requires explicit allowRemote: true.");
    const url = remoteUrl(entry.url);
    if (typeof entry.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(entry.tokenEnv)) throw new Error("Configure a tokenEnv name; never store tokens in manifests.");
    const call = (path, method, body) => {
      const token = process.env[entry.tokenEnv];
      if (typeof token !== "string" || token.length < 32 || /[\r\n]/.test(token)) throw new Error("Adapter credential environment variable needs at least 32 characters.");
      return request((url, options) => transport(url, options, proxy), `${url}${path}`, token, method, body);
    };
    const identity = await digest(JSON.stringify({ type: entry.type, url, ...(proxy ? { proxy } : {}) }));
    if (entry.type === "cloudflare-jobs") {
      adapters[id] = {
        remote: true, identity,
        async discover() {
          const { value } = await call("/health");
          if (value.ok !== true || !value.modes?.includes("task")) throw new Error("Cloudflare service is not compatible with note tasks.");
          return { versions: [1], capabilities: ["notes.answer", "text.transform"], idempotentTasks: true, peers: [] };
        },
        async prepare({ id: task, definition, artifacts }) {
          const data = await snapshot(vault, definition, artifacts);
          return { id: task, ...data, remoteId: await digest(JSON.stringify(cloudJob(data))) };
        },
        async advance(data) {
          const job = cloudJob(data);
          if (await digest(JSON.stringify(job)) !== data.remoteId) throw new Error("Frozen cloud snapshot hash mismatch.");
          const submitted = await call("/jobs", "POST", job);
          if (submitted.value.id !== data.remoteId) throw new Error("Cloud job acknowledgment does not match its snapshot.");
          const result = await call(`/jobs/${validId(data.remoteId)}/result`);
          if (result.status === 409) {
            const status = await call(`/jobs/${data.remoteId}`);
            if (status.value.id !== data.remoteId || typeof status.value.status !== "string") throw new Error("Cloud job status mismatch.");
            if (["errored", "terminated"].includes(status.value.status)) throw new Error("Cloud job failed; inspect Worker logs before an explicit retry.");
            return { pending: true };
          }
          if (result.value.id !== data.remoteId || result.value.mode !== "task"
              || !Array.isArray(result.value.edits) || result.value.edits.length) throw new Error("Cloud result does not match a read-only task.");
          return { content: artifactContent(result.value.answer) };
        },
      };
    } else {
      adapters[id] = {
        remote: true, identity,
        async discover() { return capabilities((await call("/capabilities")).value); },
        async prepare({ id: task, definition, artifacts }) { return { id: task, ...await snapshot(vault, definition, artifacts) }; },
        async advance(data) {
          const accepted = await call("/tasks", "POST", data);
          if (accepted.status === 409) throw new Error("Peer rejected the immutable task ID; inspect its idempotency implementation.");
          if (accepted.value.id !== data.id || accepted.value.version !== 1) throw new Error("Peer task acknowledgment mismatch.");
          const result = await call(`/tasks/${data.id}`);
          const value = result.value;
          if (value.version !== 1 || value.id !== data.id) throw new Error("Peer result version or task ID mismatch.");
          if (["queued", "running", "waiting"].includes(value.status)) return { pending: true };
          if (value.status !== "done") throw new Error("Peer task failed or returned an unsupported status.");
          return { content: artifactContent(value.content) };
        },
      };
    }
  }
  return adapters;
}
