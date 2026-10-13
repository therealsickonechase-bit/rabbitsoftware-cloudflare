import { digest } from "../../workers/vault-agent/src/protocol.mjs";
import { capabilities } from "./task-protocol.mjs";

export async function reviewTask(queue, id, adapters = {}) {
  const task = queue.state.tasks[id];
  if (!task) throw new Error("Unknown task for evidence review.");
  const findings = [];
  const evidence = { task: id, request: task.request, output: task.output };
  let verdict = "unverified";
  if (task.output) {
    const content = queue.artifact(task.output).content;
    if (await digest(content) !== task.output) {
      findings.push({ type: "integrity", message: "Output does not match its recorded hash." });
      verdict = "contradicted";
    } else if (task.definition.capability === "code.repair" && task.request) {
      const request = queue.hydrate(task);
      let result;
      try { result = JSON.parse(content); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        findings.push({ type: "evidence", message: "Coding response is not a validation receipt." });
      }
      if (result && request.codingIdentity) {
        const tests = (request.sources ?? []).filter(source => !source.editable).map(({ path, hash }) => ({ path, hash }));
        let valid = result.task === id && result.validated === true
          && result.validation?.runner === "coding-local" && result.validation.identity === request.codingIdentity
          && tests.length > 0 && JSON.stringify(result.validation.tests) === JSON.stringify(tests)
          && Number.isInteger(result.validation.maxLines) && result.validation.maxLines >= 1 && result.validation.maxLines <= 2000
          && Array.isArray(result.changes) && Array.isArray(result.changed)
          && JSON.stringify(result.changed) === JSON.stringify(result.changes.map(change => change?.path))
          && Number.isInteger(result.rounds) && result.rounds >= 1 && result.rounds <= 3;
        evidence.limitsBoundToRequest = request.codingLimits !== undefined;
        if (request.codingLimits && (result.validation?.maxLines !== request.codingLimits.maxLines
            || result.rounds > request.codingLimits.maxRounds)) valid = false;
        const seen = new Set();
        for (const change of Array.isArray(result.changes) ? result.changes : []) {
          if (!change || typeof change.path !== "string" || typeof change.content !== "string"
              || seen.has(change.path) || !request.sources.some(source => source.path === change.path && source.editable)
              || await digest(change.content) !== change.hash
              || change.content.split(/\r?\n/).length > result.validation?.maxLines) valid = false;
          seen.add(change?.path);
        }
        for (const source of request.sources ?? []) if (await digest(source.content) !== source.hash) valid = false;
        verdict = valid ? "scoped-evidence-consistent" : "contradicted";
        findings.push({ type: "evidence", message: valid
          ? "Coding receipt matches frozen source scope, immutable tests, identity and changed-content hashes. Tests were not rerun by review."
          : "Coding validation claim contradicts or omits frozen evidence; do not trust this success claim." });
      } else if (verdict !== "contradicted") {
        findings.push({ type: "evidence", message: "No local coding-runner provenance is available; provider text is not proof of validation." });
      }
    } else {
      findings.push({ type: "evidence", message: "Hash verifies retained bytes, not factual correctness or execution success. AI/worker output needs task-specific independent validation." });
    }
    if (/ignore (?:all |previous |prior )*(?:instructions|tests)|disable (?:validation|safety)|skip (?:tests|approval)|(?:tests? passed|cannot|blocked|impossible)/i.test(content)) {
      findings.push({ type: "claim-review", message: "Output includes success/blocker or instruction-like language. Inspect in context; this heuristic does not establish manipulation or a false blocker." });
    }
  }
  if (["blocked", "failed", "waiting"].includes(task.status)) {
    const candidates = task.adapter ? [task.adapter] : task.definition.adapters;
    const checks = [];
    for (const name of candidates) {
      const adapter = Object.hasOwn(adapters, name) && adapters[name];
      if (!adapter) { checks.push({ adapter: name, available: false, reason: "Not configured for this review." }); continue; }
      if (adapter.remote && !task.definition.share) { checks.push({ adapter: name, available: false, reason: "Sharing is not approved; do not override." }); continue; }
      if (task.adapter && adapter.identity !== task.adapterIdentity) { checks.push({ adapter: name, available: false, reason: "Pinned identity changed; do not switch." }); continue; }
      try {
        const info = capabilities(await adapter.discover());
        checks.push({ adapter: name, available: info.capabilities.includes(task.definition.capability), reason: "Fresh capability discovery only; task was not executed." });
      } catch (error) { checks.push({ adapter: name, available: false, reason: error.message.slice(0, 1000) }); }
    }
    evidence.blockerChecks = checks;
    findings.push({ type: "blocker-review", message: checks.some(check => check.available)
      ? "An adapter now advertises this capability. The old blocker may be stale, but execution/input/test failures remain unproven. Review before any retry."
      : "No currently usable adapter was demonstrated. Preserve the blocker; missing discovery evidence is not proof of a false block." });
    evidence.reportedError = task.error;
  }
  return { version: 1, task: id, status: task.status, verdict, evidence, findings,
    executed: false, permissionsChanged: false, limitation: "Deterministic evidence checks and claim hints cannot detect every deceptive or incorrect output." };
}
