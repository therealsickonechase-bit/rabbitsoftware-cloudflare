import { personalInformation } from "./public-input.mjs";
import { normalizeSources, researchMessages, validateQuery } from "./research-core.mjs";
import { modelUnavailableMessage } from "./model-status.mjs";

const endpoint = document.querySelector('meta[name="research-endpoint"]').content;
const gateway = "https://rabbitsoftware-gateway.rabbitsoftware-gateway.workers.dev/v1/chat/completions";
const form = document.querySelector("#agent-form");
const query = document.querySelector("#agent-query");
const consent = document.querySelector("#agent-consent");
const search = document.querySelector("#agent-search");
const clear = document.querySelector("#agent-clear");
const status = document.querySelector("#agent-status");
const results = document.querySelector("#agent-results");
const sourcesList = document.querySelector("#agent-sources");
const info = document.querySelector("#agent-search-info");
const answer = document.querySelector("#agent-answer");
const retrySummary = document.querySelector("#agent-retry-summary") || document.createElement("button");
if (!retrySummary.id) {
  retrySummary.id = "agent-retry-summary";
  retrySummary.type = "button";
  retrySummary.textContent = "Retry AI summary only";
  retrySummary.hidden = true;
  retrySummary.disabled = true;
  search.after(retrySummary);
}
let pending = false;
let summaryRequest = null;

function updateControls() {
  search.disabled = pending || !endpoint || !consent.checked || !query.value.trim();
  clear.disabled = pending || results.hidden;
  query.disabled = pending;
  consent.disabled = pending;
  retrySummary.hidden = !summaryRequest;
  retrySummary.disabled = pending || !summaryRequest || !consent.checked;
}

function resetConsent() {
  consent.checked = false;
  updateControls();
}

query.addEventListener("input", () => {
  summaryRequest = null;
  resetConsent();
});
consent.addEventListener("change", updateControls);
window.addEventListener("pagehide", resetConsent);
clear.addEventListener("click", () => {
  summaryRequest = null;
  sourcesList.replaceChildren();
  answer.textContent = "";
  info.textContent = "";
  results.hidden = true;
  resetConsent();
  status.textContent = "Results cleared from this tab. Already sent provider requests are not erased.";
});

async function post(url, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST", signal: controller.signal, credentials: "omit",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (url === gateway) {
      const unavailable = modelUnavailableMessage(response.status);
      if (unavailable) throw new Error(unavailable);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`The service returned invalid JSON (HTTP ${response.status}).`);
      throw error;
    }
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}.`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestSummary(messages) {
  const model = await post(gateway, { messages, max_tokens: 380, temperature: 0.2 }, 120000);
  const content = model?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("The model returned an empty answer.");
  answer.textContent = content.trim();
  summaryRequest = null;
  status.textContent = "Summary received. Verify its citations against the numbered sources; AI claims are unverified.";
}

function failureMessage(error) {
  return error.name === "AbortError" ? "The request timed out."
    : error instanceof TypeError ? "The service could not be reached. Check your connection and use an approved RabbitSoftware website address."
      : error.message;
}

retrySummary.addEventListener("click", async () => {
  if (pending || !consent.checked || !summaryRequest) return;
  pending = true;
  consent.checked = false;
  updateControls();
  status.textContent = "Retrying the AI summary with the existing sources. No new Tavily search.";
  try {
    await requestSummary(summaryRequest);
  } catch (error) {
    const message = failureMessage(error);
    answer.textContent = `No AI summary received. ${message}`;
    status.textContent = `AI summary failed: ${message} Existing sources remain available. Fresh approval is required to retry.`;
  } finally {
    pending = false;
    resetConsent();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending) return;
  if (!endpoint || !consent.checked) {
    status.textContent = endpoint ? "Approve this question before sending." : "Live search is not configured yet.";
    return;
  }
  let text;
  try {
    text = validateQuery(query.value);
    const privateFields = personalInformation(text);
    if (privateFields.length) throw new Error(`Remove ${privateFields.join(", ")}. Public topics only.`);
  } catch (error) {
    status.textContent = error.message;
    resetConsent();
    return;
  }
  pending = true;
  summaryRequest = null;
  consent.checked = false;
  updateControls();
  results.hidden = true;
  sourcesList.replaceChildren();
  answer.textContent = "";
  info.textContent = "";
  status.textContent = "Searching public snippets through Tavily...";
  let stage = "Search";
  try {
    const payload = await post(endpoint, { query: text, consent: true }, 30000);
    const sources = normalizeSources(payload?.sources);
    if (typeof payload?.searched_at !== "string" || !Number.isFinite(Date.parse(payload.searched_at))) {
      throw new Error("The search service returned an invalid search time.");
    }
    for (const source of sources) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `[${source.id}] ${source.title}`;
      const snippet = document.createElement("p");
      snippet.textContent = source.content;
      item.append(link, snippet);
      sourcesList.append(item);
    }
    results.hidden = false;
    info.textContent = `Tavily basic search at ${new Date(payload.searched_at).toLocaleString()}. Snippets only, not full pages.`;
    if (!sources.length) {
      answer.textContent = "No sources were returned. The model was not called.";
      status.textContent = "Search completed without sources. Try a different question with fresh approval.";
      return;
    }
    stage = "AI summary";
    const messages = researchMessages(text, sources);
    if (messages.some(message => personalInformation(message.content).length)) {
      throw new Error("A source snippet triggered the private-data pattern check. Sources are shown, but nothing was sent to the model.");
    }
    status.textContent = "Sources received. Asking the model to summarize only these snippets...";
    summaryRequest = messages;
    await requestSummary(messages);
  } catch (error) {
    const message = failureMessage(error);
    status.textContent = `${stage} failed: ${message} Fresh approval is required to retry.${summaryRequest ? " Use Retry AI summary only to keep these sources and avoid another search." : ""}`;
    if (!results.hidden) answer.textContent = `No AI summary received. ${message}`;
  } finally {
    pending = false;
    resetConsent();
  }
});

if (endpoint) {
  document.querySelector("#agent-availability").textContent = "One basic search and one AI summary per approval. No unattended tool calls.";
}
status.textContent = endpoint ? "Ready. Typing does not send requests." : "Live search is not connected yet. Existing Research AI remains available from Website tools.";
updateControls();
