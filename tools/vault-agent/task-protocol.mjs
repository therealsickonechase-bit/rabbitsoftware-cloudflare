import { checkCredentials, digest } from "../../workers/vault-agent/src/protocol.mjs";
import { validatePrompt } from "./engine.mjs";

export const TASK_VERSION = 1;
export const LIMITS = Object.freeze({ tasks: 128, tasksPerRun: 8, artifacts: 256, artifactBytes: 65536, stateBytes: 8 * 1024 * 1024 });
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function adapterName(value) {
  if (typeof value !== "string" || !NAME.test(value)) throw new Error("Adapter IDs must be lowercase names, up to 64 characters.");
  return value;
}

export function taskId(value) {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error("Use a SHA-256 task or artifact ID.");
  return value;
}

function capabilityName(value) {
  return typeof value === "string" && value.length <= 100 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value);
}

export async function taskDefinition(value) {
  if (!value || value.version !== TASK_VERSION) throw new Error("Unsupported task version; this host supports version 1. No lossy conversion.");
  if (Object.keys(value).some(key => !["version", "capability", "instruction", "adapters", "dependsOn", "notes", "share"].includes(key))) {
    throw new Error("Unknown task field; no task instructions were silently discarded.");
  }
  validatePrompt(value.instruction);
  checkCredentials(value.instruction);
  if (!capabilityName(value.capability)) throw new Error("Use a namespaced capability such as notes.answer or shell.job (up to 100 characters).");
  if (!Array.isArray(value.adapters) || !value.adapters.length || value.adapters.length > 8) throw new Error("Choose 1-8 explicitly authorized adapters.");
  const adapters = value.adapters.map(adapterName);
  if (new Set(adapters).size !== adapters.length) throw new Error("Duplicate adapters.");
  const dependsOn = value.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.length > 8 || new Set(dependsOn).size !== dependsOn.length) throw new Error("Choose at most 8 unique dependency IDs.");
  dependsOn.forEach(taskId);
  const notes = value.notes ?? [];
  if (!Array.isArray(notes) || notes.length > 8 || new Set(notes).size !== notes.length
      || notes.some(path => typeof path !== "string" || path.length > 240 || !path.endsWith(".md"))) {
    throw new Error("Choose at most 8 unique Markdown note paths.");
  }
  if (value.share !== undefined && typeof value.share !== "boolean") throw new Error("Task share approval must be boolean.");
  const definition = {
    version: TASK_VERSION, capability: value.capability, instruction: value.instruction.trim(),
    adapters, dependsOn: [...dependsOn].sort(), notes: [...notes].sort(), share: value.share === true,
  };
  return { id: await digest(JSON.stringify(definition)), definition };
}

export function capabilities(value) {
  if (!value || !Array.isArray(value.versions) || !value.versions.includes(TASK_VERSION)
      || !Array.isArray(value.capabilities) || value.capabilities.length > 32
      || value.capabilities.some(item => !capabilityName(item))
      || value.idempotentTasks !== true) {
    throw new Error("Adapter must advertise task version 1, capabilities, and idempotentTasks: true.");
  }
  const peers = value.peers ?? [];
  if (!Array.isArray(peers) || peers.length > 16 || peers.some(peer => typeof peer !== "string" || peer.length > 240)) {
    throw new Error("Peer discovery exceeds its limit.");
  }
  for (const peer of peers) {
    const url = new URL(peer);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Peer hints must be credential-free HTTPS URLs.");
  }
  return { versions: [TASK_VERSION], capabilities: value.capabilities, idempotentTasks: true, peers };
}

export function artifactContent(content) {
  if (typeof content !== "string" || !content.trim() || content.includes("\0")
      || new TextEncoder().encode(content).length > LIMITS.artifactBytes) {
    throw new Error("Artifact must contain 1-65536 UTF-8 bytes.");
  }
  checkCredentials(content);
  return content;
}
