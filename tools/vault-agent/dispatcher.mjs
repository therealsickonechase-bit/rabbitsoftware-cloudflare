import { withCoordinator } from "./coordinator.mjs";
import { withMailbox } from "./mailbox.mjs";
import { adapterName, taskId, taskDefinition, artifactContent } from "./task-protocol.mjs";
import { digest } from "../../workers/vault-agent/src/protocol.mjs";
import { reviewTask } from "./result-review.mjs";

const terminal = new Set(["done", "failed", "blocked"]);

function statePath(agent) {
  return `Cloud Agents/Dispatchers/${adapterName(agent)}/state.json`;
}

export async function requestAgent(vault, sender, dispatcher, task) {
  adapterName(sender); adapterName(dispatcher);
  if (sender === dispatcher) throw new Error("Send requests to a different named dispatcher; self-dispatch loops are refused.");
  const normalized = await taskDefinition(task);
  return withMailbox(vault, mailbox => mailbox.send({
    version: 1, sender, recipient: dispatcher, key: `request:${normalized.id}`,
    kind: "handoff", route: "local", share: false,
    content: JSON.stringify({ version: 1, type: "agent-request", task: normalized.definition }),
  }));
}

export async function inspectRequest(vault, dispatcher, id) {
  adapterName(dispatcher); taskId(id);
  const message = await withMailbox(vault, mailbox => mailbox.read(dispatcher, id));
  if (message.kind !== "handoff" || message.sender === dispatcher) throw new Error("Not a supported agent request.");
  const value = JSON.parse(message.content);
  if (!value || value.version !== 1 || value.type !== "agent-request"
      || Object.keys(value).some(key => !["version", "type", "task"].includes(key))) throw new Error("Unsupported agent-request envelope.");
  const normalized = await taskDefinition(value.task);
  return { request: id, artifact: message.artifact, sender: message.sender,
    dispatcher, task: normalized.id, definition: normalized.definition };
}

async function dispatcherQueue(vault, agent, action) {
  return withCoordinator(vault, async queue => {
    const records = queue.state.dispatchRequests ?? {};
    if (!records || typeof records !== "object" || Array.isArray(records) || Object.keys(records).length > 128) throw new Error("Invalid dispatcher request ledger; preserve it for recovery.");
    for (const [id, record] of Object.entries(records)) {
      taskId(id); taskId(record.artifact); taskId(record.task); adapterName(record.sender);
      if (record.sender === agent || !queue.state.tasks[record.task]
          || typeof record.delivered !== "boolean") throw new Error("Dispatcher approval integrity check failed.");
      if (record.receipt !== undefined) taskId(record.receipt);
    }
    queue.state.dispatchRequests = records;
    return action(queue, records);
  }, statePath(agent));
}

export async function approveRequest(vault, dispatcher, id) {
  const request = await inspectRequest(vault, dispatcher, id);
  return dispatcherQueue(vault, dispatcher, async (queue, records) => {
    if (Object.hasOwn(records, id)) return { ...request, approved: true, replay: true };
    if (Object.keys(records).length >= 128) throw new Error("Dispatcher approval ledger is full; no request was dropped.");
    // Enqueue persists first; an interrupted approval can safely complete on retry.
    await queue.enqueue(request.definition);
    records[id] = { artifact: request.artifact, sender: request.sender, task: request.task, delivered: false };
    await queue.save();
    return { ...request, approved: true, replay: false };
  });
}

export async function listDispatcher(vault, dispatcher) {
  const inbox = await withMailbox(vault, mailbox => mailbox.receive(adapterName(dispatcher)));
  return dispatcherQueue(vault, dispatcher, (queue, records) => ({
    version: 1, dispatcher, inbox, queue: queue.list(),
    requests: Object.entries(records).map(([id, record]) => ({ id, ...record })),
  }));
}

export async function reviewDispatcher(vault, dispatcher, id, adapters = {}) {
  taskId(id);
  return dispatcherQueue(vault, dispatcher, async queue => {
    const review = await reviewTask(queue, id, adapters);
    const artifact = await queue.put(JSON.stringify(review), false);
    queue.state.tasks[id].review = artifact;
    await queue.save();
    return { ...review, artifact };
  });
}

export async function runDispatcher(vault, dispatcher, adapters) {
  adapterName(dispatcher);
  return dispatcherQueue(vault, dispatcher, async (queue, records) => {
    const reports = await queue.run(adapters);
    const returned = [];
    let pendingReturns = 0;
    for (const [id, record] of Object.entries(records)) {
      const task = queue.list().tasks.find(task => task.id === record.task);
      if (record.delivered || !terminal.has(task.status)) continue;
      if (returned.length >= 8) { pendingReturns++; continue; }
      const request = await inspectRequest(vault, dispatcher, id);
      if (request.artifact !== record.artifact || request.task !== record.task || request.sender !== record.sender) throw new Error("Approved request no longer matches its immutable mailbox content.");
      const review = await reviewTask(queue, task.id);
      const reviewArtifact = await queue.put(JSON.stringify(review), false);
      queue.state.tasks[task.id].review = reviewArtifact;
      await queue.save();
      const status = task.status === "done" && (review.verdict === "contradicted"
        || task.capability === "code.repair" && review.verdict !== "scoped-evidence-consistent")
        ? "review-required" : task.status;
      const content = JSON.stringify({
        version: 1, type: "agent-response", dispatcher, request: id,
        task: task.id, status, executionStatus: task.status, adapter: task.adapter,
        output: task.output, error: task.error,
        result: task.output ? queue.artifact(task.output).content : undefined,
        review: { artifact: reviewArtifact, verdict: review.verdict, executed: false },
      });
      artifactContent(content);
      const receipt = await withMailbox(vault, async mailbox => {
        const sent = await mailbox.send({
          version: 1, sender: dispatcher, recipient: record.sender, key: await digest(content),
          kind: "task-receipt", route: "local", share: false, content,
        });
        await mailbox.acknowledge({ recipient: dispatcher, id, artifact: record.artifact });
        return sent;
      });
      record.receipt = receipt.id; record.delivered = true;
      await queue.save();
      returned.push({ request: id, task: task.id, recipient: record.sender, receipt: receipt.id, status });
    }
    return { version: 1, dispatcher, reports, returned, pendingReturns };
  });
}
