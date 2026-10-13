// Agent tasks page: submit to the rabbitsoftware-tasks Worker and poll for results. Task IDs stay in this browser.
const endpoint = document.querySelector('meta[name="tasks-endpoint"]').content;
const STORAGE_KEY = "rabbitsoftware.tasks.v1";
const KIND_LABELS = { answer: "Answer", summarize: "Summary", explain: "Explanation" };
const POLL_MS = 4000;

const form = document.getElementById("task-form");
const kind = document.getElementById("task-kind");
const input = document.getElementById("task-input");
const consent = document.getElementById("task-consent");
const submit = document.getElementById("task-submit");
const clear = document.getElementById("task-clear");
const status = document.getElementById("task-status");
const list = document.getElementById("task-list");
const empty = document.getElementById("task-empty");

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(t => /^[a-f0-9]{32}$/.test(t?.id)).slice(0, 20) : [];
  } catch { return []; }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.map(({ id, kind, preview, created }) => ({ id, kind, preview, created })))); }
  catch { /* storage blocked: tasks still show until the page closes */ }
}
let tasks = load();

function render() {
  list.replaceChildren(...tasks.map(task => {
    const item = document.createElement("li");
    const heading = document.createElement("p");
    const label = document.createElement("strong");
    label.textContent = `${KIND_LABELS[task.kind] || "Task"}: `;
    heading.append(label, document.createTextNode(task.preview));
    const state = document.createElement("p");
    state.className = "task-state";
    const text = { queued: `Waiting in line${task.position ? ` (position ${task.position})` : ""}…`, running: "The agent is working on it…",
      done: "Done.", failed: task.error || "Failed.", missing: "No longer available (results are kept for 7 days).",
      unreachable: "Could not reach the task service. Will check again." }[task.status] || "Sending…";
    state.textContent = text;
    item.append(heading, state);
    if (task.status === "done" && task.result) {
      const result = document.createElement("pre");
      result.className = "task-result";
      result.textContent = task.result;   // plain text only: never inject model output as HTML
      item.append(result);
    }
    return item;
  }));
  empty.hidden = tasks.length > 0;
}

let timer;
async function refresh() {
  clearTimeout(timer);
  const pending = tasks.filter(t => !["done", "failed", "missing"].includes(t.status));
  for (const task of pending) {
    try {
      const response = await fetch(`${endpoint}/v1/tasks/${task.id}`, { cache: "no-store", credentials: "omit" });
      if (response.status === 404) Object.assign(task, { status: "missing" });
      else if (response.ok) {
        const data = await response.json();
        Object.assign(task, { status: data.status, position: data.position, result: data.result, error: data.error });
      } else task.status = "unreachable";
    } catch { task.status = "unreachable"; }
  }
  render();
  if (tasks.some(t => !["done", "failed", "missing"].includes(t.status))) timer = setTimeout(refresh, POLL_MS);
}

function ready() { submit.disabled = !consent.checked || !input.value.trim(); }
consent.addEventListener("change", ready);
input.addEventListener("input", ready);

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  status.textContent = "Sending your task…";
  try {
    const response = await fetch(`${endpoint}/v1/tasks`, {
      method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: kind.value, input: input.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `The task service answered HTTP ${response.status}.`);
    const text = input.value.trim();
    tasks.unshift({ id: data.id, kind: kind.value, preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      created: Date.now(), status: "queued", position: data.position });
    tasks = tasks.slice(0, 20);
    save();
    input.value = "";
    consent.checked = false;
    status.textContent = "Task accepted. The result will appear below.";
    refresh();
  } catch (error) {
    status.textContent = error instanceof TypeError ? "Could not reach the task service. Nothing was queued; try again later." : error.message;
  } finally { ready(); }
});

clear.addEventListener("click", () => {
  tasks = [];
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  render();
  status.textContent = "Task IDs were removed from this browser. Results on the server expire after 7 days.";
});

status.textContent = "Ready. Nothing is sent until you tick the approval box and submit.";
render();
refresh();
