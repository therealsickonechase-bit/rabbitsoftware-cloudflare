export function parseLocal(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a documented JSON object.");
  let records;
  let kind;
  if (data.schema === "rabbitsoftware.local-public-lookup.v1" && data.classification === "public") {
    records = data.entries;
    kind = "lookup";
  } else if (data.schema_version === 1 && data.classification === "public" && Array.isArray(data.events)) {
    records = data.events;
    kind = "research";
  } else if (data.schema_version === 1 && data.classification === "public" && Array.isArray(data.chain)) {
    records = data.chain;
    kind = "maxwell";
  } else if (typeof data.name === "string" && typeof data.account === "string" && Array.isArray(data.entries)) {
    records = data.entries;
    kind = "dna";
  } else {
    throw new Error("Unsupported format. Use a local lookup, public v1 archive, or account-scoped DNA JSON file.");
  }
  if (!Array.isArray(records) || records.length < 1 || records.length > 1000) throw new Error("A file needs 1-1000 entries.");
  return records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid entry object.");
    const payload = kind === "dna" ? record.record : kind === "maxwell" ? record.data : record;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid entry payload.");
    const classification = kind === "dna" ? "private" : "declared public";
    const topic = payload.topic || payload.event_type || record.block_type || payload.type || "Record";
    if (typeof topic !== "string" || topic.length > 2000) throw new Error("Invalid entry topic.");
    // Account scope belongs to the envelope and is never displayed.
    const message = JSON.stringify(payload, (key, value) =>
      ["account", "device", "private_key"].includes(key) ? undefined : value);
    if (message.length > 32000) throw new Error("An entry exceeds the display limit.");
    return { topic, classification, message };
  });
}

export function findEntries(entries, command) {
  const ordinal = /^show entry (\d+)$/i.exec(command.trim());
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= entries.length) throw new Error("Entry number is outside this file.");
    return [{ entry: entries[index], index }];
  }
  const query = command.trim().replace(/^(find|search)\s+/i, "").toLowerCase();
  return entries.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !query || `${entry.topic} ${entry.message}`.toLowerCase().includes(query));
}
