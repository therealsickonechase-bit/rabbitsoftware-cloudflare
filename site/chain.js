import { findEntries, parseLocal } from "./chain-core.mjs";

const byId = (id) => document.getElementById(id);
let entries = [];
let generation = 0;
let corpus = [];

function render(list, matches) {
  list.replaceChildren();
  for (const { entry, index } of matches) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `Entry ${index + 1}: ${entry.topic}`;
    const body = document.createElement("p");
    body.textContent = entry.message;
    const label = document.createElement("small");
    label.textContent = entry.classification;
    item.append(title, body, label);
    if (entry.sourceUrl) {
      const link = document.createElement("a");
      link.href = entry.sourceUrl;
      link.textContent = "Open source (requires internet)";
      link.rel = "noreferrer";
      item.append(link);
    }
    list.append(item);
  }
}

function closeLocal() {
  generation += 1;
  entries = [];
  byId("local-file").value = "";
  byId("local-command").value = "";
  byId("local-controls").hidden = true;
  byId("local-results").hidden = true;
  byId("local-submit").disabled = true;
  byId("local-list").replaceChildren();
  byId("local-status").textContent = "No file is open.";
}

byId("local-clear").addEventListener("click", closeLocal);
byId("local-file").addEventListener("change", async () => {
  const file = byId("local-file").files[0];
  const current = ++generation;
  entries = [];
  byId("local-results").hidden = true;
  byId("local-controls").hidden = true;
  byId("local-list").replaceChildren();
  if (!file) {
    closeLocal();
    return;
  }
  try {
    if (file.size > 1024 * 1024) throw new Error("File exceeds the 1 MiB limit.");
    const text = await file.text();
    if (current !== generation) return;
    entries = parseLocal(JSON.parse(text.replace(/^\uFEFF/, "")));
    byId("local-controls").hidden = false;
    byId("local-submit").disabled = false;
    byId("local-status").textContent = `${entries.length} entries opened locally. Declared labels only; no hash, signature, or consensus verification.`;
  } catch (error) {
    if (current !== generation) return;
    console.error("Local file could not be opened", error);
    byId("local-status").textContent = `Cannot open file: ${error.message}`;
  }
});
byId("local-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const matches = findEntries(entries, byId("local-command").value);
    render(byId("local-list"), matches);
    byId("local-results").hidden = false;
    byId("local-status").textContent = `${matches.length} matching entries. No file contents were sent.`;
  } catch (error) {
    byId("local-list").replaceChildren();
    byId("local-results").hidden = true;
    byId("local-status").textContent = error.message;
  }
});

byId("corpus-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = byId("corpus-query").value.trim().toLowerCase();
  const matches = corpus.map((record, index) => ({
    index, entry: {
      topic: record.title, classification: "Public metadata snapshot",
      message: `${record.source}: ${record.external_id} (${record.published_at})`,
      sourceUrl: /^https?:\/\//i.test(record.source_url) ? record.source_url : null,
    },
  })).filter(({ entry }) => `${entry.topic} ${entry.message}`.toLowerCase().includes(query));
  render(byId("corpus-list"), matches);
  byId("corpus-results").hidden = false;
  byId("corpus-status").textContent = `${matches.length} matches. Query stayed in this tab.`;
});
try {
  const response = await fetch("assets/public-corpus.json", { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.schema !== "rabbitsoftware.public-corpus-metadata.v1" || !Array.isArray(data.records)) throw new Error("Unsupported metadata snapshot.");
  corpus = data.records;
  byId("corpus-stats").textContent = `${corpus.length} public metadata records. Snapshot: ${data.fetched_at}`;
  byId("corpus-status").textContent = "Ready. Search text stays in this tab.";
  byId("corpus-submit").disabled = false;
} catch (error) {
  console.error("Corpus snapshot failed", error);
  byId("corpus-stats").textContent = "Snapshot unavailable.";
  byId("corpus-status").textContent = `Cannot load metadata: ${error.message}. Local files remain available.`;
}
