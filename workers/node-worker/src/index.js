import { WorkflowEntrypoint } from "cloudflare:workers";
import { handleAgentRequest, runArchiveWorkflow } from "./agent.js";

export class MyWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		return runArchiveWorkflow(event, step, this.env);
	}
}

export default { fetch: handleAgentRequest };
