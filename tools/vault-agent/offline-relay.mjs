import { envelope, Mailbox, MailboxError, MAILBOX_LIMITS } from "./mailbox.mjs";
import { digest } from "../../workers/vault-agent/src/protocol.mjs";

export const RELAY_LIMITS = Object.freeze({ messages: 16, bytes: 256 * 1024 });

async function bundle(value) {
  if (!value || value.version !== 1 || value.type !== "offline-relay"
      || Object.keys(value).some(key => !["version", "type", "messages", "id"].includes(key))
      || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > RELAY_LIMITS.messages) throw new MailboxError("Relay needs version 1 and 1-16 explicit messages.");
  if (Buffer.byteLength(JSON.stringify(value)) > RELAY_LIMITS.bytes) throw new MailboxError("Relay bundle exceeds 256 KiB; select fewer messages.");
  const messages = [];
  const ids = new Set();
  for (const item of value.messages) {
    if (!item || Object.keys(item).some(key => !["id", "message"].includes(key))) throw new MailboxError("Relay record needs exact id and message fields.");
    const normalized = await envelope(item.message);
    if (normalized.id !== item.id || ids.has(item.id) || item.message.share !== true || item.message.route !== "local") throw new MailboxError("Relay requires unique intact local messages with explicit share: true.");
    ids.add(item.id);
    messages.push({ id: item.id, message: { ...normalized.definition, content: item.message.content } });
    delete messages.at(-1).message.artifact;
  }
  const definition = { version: 1, type: "offline-relay", messages };
  const id = await digest(JSON.stringify(definition));
  if (value.id !== undefined && value.id !== id) throw new MailboxError("Relay bundle hash mismatch.");
  const result = { ...definition, id };
  if (Buffer.byteLength(JSON.stringify(result)) > RELAY_LIMITS.bytes) throw new MailboxError("Relay bundle exceeds 256 KiB including its hash; select fewer messages.");
  return result;
}

export async function exportRelay(mailbox, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > RELAY_LIMITS.messages || new Set(ids).size !== ids.length) throw new MailboxError("Select 1-16 unique message IDs for offline relay.");
  const messages = ids.map(id => {
    const stored = Object.hasOwn(mailbox.state.messages, id) && mailbox.state.messages[id];
    if (!stored) throw new MailboxError("Unknown message selected for relay.");
    const { artifact, ...fields } = stored.definition;
    return { id, message: { ...fields, content: mailbox.state.artifacts[artifact] } };
  });
  return bundle({ version: 1, type: "offline-relay", messages });
}

export async function importRelay(mailbox, value) {
  if (typeof value?.id !== "string") throw new MailboxError("Import requires the exported relay bundle hash.");
  const verified = await bundle(value);
  const candidate = structuredClone(mailbox.state);
  const staged = new Mailbox(candidate, async () => {});
  const imported = [];
  for (const item of verified.messages) imported.push(await staged.send(item.message));
  if (Buffer.byteLength(JSON.stringify(candidate)) > MAILBOX_LIMITS.stateBytes) throw new MailboxError("Relay import exceeds mailbox capacity; original state is unchanged.");
  Object.assign(mailbox.state, candidate);
  await mailbox.save();
  return { version: 1, bundle: verified.id, imported, executed: false, acknowledgedAtSource: false,
    warning: "Bundle hashes detect changes, not sender authenticity or encryption. Imported requests require normal operator approval." };
}
