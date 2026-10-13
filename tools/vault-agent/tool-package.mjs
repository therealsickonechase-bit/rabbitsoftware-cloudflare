import { adapterName, taskId, artifactContent } from "./task-protocol.mjs";
import { digest } from "../../workers/vault-agent/src/protocol.mjs";

export const PACKAGE_LIMITS = Object.freeze({ packages: 64, files: 8, bytes: 32768, gossipBatch: 16, gossipBytes: 8192 });

export async function toolPackage(value) {
  if (!value || value.version !== 1 || Object.keys(value).some(key => !["version", "name", "description", "capabilities", "files", "task"].includes(key))) throw new Error("Use exact version 1 tool-package fields.");
  adapterName(value.name);
  if (typeof value.description !== "string" || !value.description.trim() || value.description.length > 240
      || /[\r\n\0]/.test(value.description)) throw new Error("Package description needs 1-240 characters on one line.");
  if (!Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.length > 8
      || value.capabilities.some(item => typeof item !== "string" || item.length > 100 || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(item))
      || new Set(value.capabilities).size !== value.capabilities.length) throw new Error("Declare 1-8 unique namespaced capabilities.");
  if (value.task !== undefined) taskId(value.task);
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > PACKAGE_LIMITS.files) throw new Error("Package 1-8 explicit text files.");
  const paths = new Set();
  const files = [];
  for (const file of value.files) {
    if (!file || Object.keys(file).some(key => !["path", "content"].includes(key))
        || typeof file.path !== "string" || file.path.length > 180
        || !/\.(?:mjs|cjs|js|mts|ts|java|py|json|md|css|html)$/.test(file.path)
        || file.path.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(" ")
          || /[\\<>:"|?*\x00-\x1f]/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
        || paths.has(file.path.toLowerCase())) throw new Error("Use unique safe relative source/skill file paths, not links or executable commands.");
    artifactContent(file.content);
    paths.add(file.path.toLowerCase());
    files.push({ path: file.path, content: file.content });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const definition = { version: 1, name: value.name, description: value.description.trim(),
    capabilities: [...value.capabilities].sort(), files, ...(value.task ? { task: value.task } : {}) };
  const content = JSON.stringify(definition);
  artifactContent(content);
  if (Buffer.byteLength(content) > PACKAGE_LIMITS.bytes) throw new Error("Tool package exceeds 32 KiB; split into dependency packages.");
  return { id: await digest(content), definition, content };
}

export function packageNote(id, definition) {
  return `---\ncloud-agent-share: false\n---\n# Tool package: ${definition.name}\n\nPackage SHA-256: ${id}\n\n${definition.description}\n\nCapabilities: ${definition.capabilities.join(", ")}\n\nRetained for review, not installed or authorized for execution. Consult mailbox package status for validation and review records. Full files are fetched by package hash; no paths are executed automatically.\n`;
}
