const status = document.getElementById("code-status");
const panel = document.getElementById("code-panel");
const content = document.getElementById("code-content");

async function displaySource() {
  try {
    const response = await fetch("downloads/dna_node_simulation.py", {
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.headers.get("content-type")?.startsWith("text/plain")) {
      throw new Error("The server did not return a plain-text source file.");
    }
    const source = await response.text();
    if (!source.trim()) throw new Error("The source file is empty.");
    content.textContent = source;
    panel.hidden = false;
    status.textContent = "Complete source loaded. This is a read-only display; no Python is executed.";
  } catch (error) {
    console.error("RabbitSoftware source display failed", error);
    const reason = error instanceof Error ? error.message : String(error);
    status.textContent = `Source display failed: ${reason} Refresh to retry or use the download link above.`;
  }
}

displaySource();
