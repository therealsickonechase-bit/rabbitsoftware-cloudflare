const { Plugin, Modal, Notice } = require("obsidian");
const { spawn } = require("node:child_process");
const { join } = require("node:path");

class TaskModal extends Modal {
  constructor(app, run) { super(app); this.run = run; }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Vault Agent" });
    this.contentEl.createEl("p", { text: "Local Ollama: read notes and stage proposals. Explicit host-configured access request/status tools may use the network. No cloud fallback, automatic edits or model shell execution." });
    const provider = this.contentEl.createEl("select");
    provider.createEl("option", { text: "Local Ollama (offline)", attr: { value: "local" } });
    provider.createEl("option", { text: "Configured provider (explicit network/upload)", attr: { value: "configured" } });
    const input = this.contentEl.createEl("textarea", { attr: { rows: "8", placeholder: "Describe your research, build, code, art, or other task..." } });
    input.style.width = "100%";
    const button = this.contentEl.createEl("button", { text: "Run with selected provider" });
    button.onclick = async () => {
      if (!input.value.trim()) return new Notice("Describe a task first.");
      button.disabled = true;
      try { await this.run(input.value, provider.value); this.close(); }
      catch (error) { new Notice(error.message, 12000); }
      finally { button.disabled = false; }
    };
  }
}

module.exports = class VaultAgentPlugin extends Plugin {
  async onload() {
    this.children = new Set();
    this.addCommand({ id: "run-local-task", name: "Run general-purpose local vault task", callback: () => {
      new TaskModal(this.app, (task, provider) => this.run(["--task", task], false, provider === "configured")).open();
    } });
    this.addCommand({ id: "open-workspace", name: "Open vault-agent workspace", callback: () => {
      this.app.workspace.openLinkText("Cloud Agents/Cloud Agents", "", true);
    } });
    this.addCommand({ id: "pull-cloud-results", name: "Pull previously submitted cloud results", callback: async () => {
      try { await this.run([], true); } catch (error) { new Notice(error.message, 12000); }
    } });
    this.addCommand({ id: "report-cloud-access", name: "Report connected cloud-access status with the local agent", callback: async () => {
      try {
        await this.run(["--task", 'First call cloud_access with {"action":"status","input":{}} exactly once, then report the actual returned approval state and expiry. Do not request access, approve, execute commands, upload notes, or stage changes.'], false, false, true);
      } catch (error) { new Notice(error.message, 12000); }
    } });
  }
  async run(args, pullCloud = false, configured = false, requireCloudStatus = false) {
    const vault = this.app.vault.adapter.getBasePath?.();
    if (!vault) throw new Error("This plugin needs Obsidian Desktop's filesystem vault.");
    // The existing Code junction locates owned source; no vault text becomes a shell command.
    const repository = join(vault, "Code", "rabbitsoftware-cloudflare");
    const settings = await this.loadData();
    const env = { ...process.env };
    let localConfig;
    if (!pullCloud && !configured && settings?.localProviderConfig) {
      if (typeof settings.localProviderConfig !== "string" || typeof settings.localCallerCredentials !== "string") {
        throw new Error("Local access tools require explicit host configuration and caller credential paths.");
      }
      const { open } = require("node:fs/promises");
      const { parseEnv } = require("node:util");
      const file = await open(settings.localCallerCredentials, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 16384) throw new Error("Local caller credentials must be a regular file up to 16384 bytes.");
        const bytes = Buffer.alloc(16385);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > 16384) throw new Error("Local caller credentials exceed 16384 bytes.");
        const token = parseEnv(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))).CLOUD_TOOLS_AGENT_TOKEN;
        if (typeof token !== "string" || token.length < 32 || token.length > 4096 || /[^\x20-\x7e]/.test(token)) {
          throw new Error("A valid dedicated caller credential is required.");
        }
        delete env.RABBIT_CLOUDSHELL_TOKEN;
        delete env.RABBIT_AGENT_APPROVAL_TOKEN;
        delete env.VAULT_AGENT_TOKEN;
        env.CLOUD_TOOLS_AGENT_TOKEN = token;
        localConfig = settings.localProviderConfig;
      } finally { await file.close(); }
    }
    if (requireCloudStatus && (pullCloud || configured || !localConfig)) {
      throw new Error("The cloud status report needs explicitly configured local caller tools.");
    }
    if (pullCloud && settings?.provider?.type === "cloudflare-jobs") {
      env.VAULT_AGENT_URL = settings.provider.url;
      env.VAULT_AGENT_TOKEN = settings.provider.token;
    }
    const script = join(repository, "scripts", pullCloud ? "vault-agent-sync.mjs" : "vault-agent.mjs");
    const prompt = args[0] === "--task" ? args[1] : undefined;
    const command = ["--vault", vault, ...(prompt !== undefined ? ["--task", "@stdin"] : args), ...(pullCloud ? ["--pull"] : []),
      ...(requireCloudStatus ? ["--require-cloud-status", "true"] : []),
      ...(configured ? ["--config", join(vault, ".obsidian", "plugins", "rabbit-vault-agent", "data.json")]
        : localConfig ? ["--config", localConfig] : [])];
    new Notice(pullCloud ? "Downloading cloud results..." : "Local vault agent is working...");
    const output = await new Promise((resolve, reject) => {
      const child = spawn("node", [script, ...command], { cwd: repository, windowsHide: true, shell: false, env });
      child.stdin.on("error", reject);
      this.children.add(child);
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 65536) child.kill(); });
      child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) child.kill(); });
      child.on("error", error => { this.children.delete(child); reject(error); });
      child.on("close", code => {
        this.children.delete(child);
        if (code !== 0) reject(new Error(stderr.trim() || `Vault agent exited with code ${code}.`));
        else resolve(stdout);
      });
      child.stdin.end(prompt ?? "");
    });
    if (pullCloud) { new Notice("Cloud result check completed."); return; }
    const result = JSON.parse(output.trim().split(/\r?\n/).filter(line => line.startsWith('{"submitted":')).at(-1) ?? output);
    if (result.submitted === true) {
      new Notice("Cloud job submitted; use Pull cloud results when it finishes.");
      return;
    }
    if (typeof result.result !== "string" || !result.result.startsWith("Cloud Agents/Results/local-")) throw new Error("Agent returned an unexpected result path.");
    await this.app.workspace.openLinkText(result.result, "", true);
    new Notice("Result saved. Proposals require separate review.");
  }
  onunload() {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
};
