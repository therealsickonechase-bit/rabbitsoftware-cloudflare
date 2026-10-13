const status = document.getElementById("document-status");
try {
  const response = await fetch("development.md");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  document.getElementById("document").textContent = await response.text();
  status.textContent = "Complete guide loaded. Displayed as plain Markdown; commands are examples, not execution approval.";
} catch (error) {
  status.textContent = `The guide could not be loaded (${error.message}). Use the Markdown download link or try again.`;
}
