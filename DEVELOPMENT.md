# Development

Local-first workflow. Nothing here touches production unless you run a deploy
command explicitly.

## Publishing this guide

The full document can be recorded locally at `Cloud Agents/DEVELOPMENT.md` in
the Obsidian vault. That copy is private, outside automatic cloud-sharing roots,
and verified against the source hash. The public website copy replaces personal
Windows usernames and removes private task-thread links; it does not publish
vault reports, credentials, mailbox state or note snapshots.

```powershell
node scripts\publish-development.mjs --vault "<vault-root>"
```

This writes `site/development.md` and creates a new exact vault copy, refusing
to overwrite an existing vault document. Omit `--vault` to refresh only the public
copy after source edits. `site/development.html` provides a plain-Markdown reader
and download link, with no external renderer or automatic command execution.
Deploying Pages remains a separate explicitly approved production operation.

## Hosted Qwen chat

`workers/qwen/` is an isolated Workers AI gateway using
`@cf/qwen/qwen3-30b-a3b-fp8`. It does not redeploy or modify the existing bundled
Hugging Face gateway. The website and authenticated RabbitOS chat routes use
its fixed `/v1/chat/completions` endpoint with explicit provider choice.
Local Ollama is unchanged. No automatic provider fallback is permitted.

The SQLite-backed Durable Object coordinates a shared 500-attempt UTC daily
cap and 20 attempts per connecting-client IP per rolling hour. Reservations
count even if inference fails, preventing retries from bypassing spend guards.
RabbitOS server-side calls share their outbound IP quota; its own research
daily and avatar hourly controls also apply. This is a request/token cap,
not a guaranteed dollar budget. Workers AI usage may incur account charges.
Application logs contain error types, never prompts or answers.

```powershell
node --test scripts\test-qwen-gateway.mjs scripts\test-qwen-quota.mjs
npx wrangler deploy --config workers\qwen\wrangler.jsonc --dry-run
```

The quota test runs actual workerd SQL/RPC and checks persistence after restart;
it makes no AI inference calls. Deploy the Qwen Worker only with approval,
verify real non-private inference, then publish the website and RabbitOS.
No provider API credential belongs in browser code. Origins are browser
controls, not authentication; global quotas also cover direct API abuse.

## Public visitor tasks

`site/tasks.html` lets any visitor queue a small task (`answer`, `summarize` or
`explain`) for `workers/tasks/` (`rabbitsoftware-tasks`). The Worker validates
the request (allowed site origin, JSON, 8000 characters, the gateway's
personal-information patterns and the vault agent's credential check), then
stores it in one SQLite Durable Object (`TaskBoard`, instance `public-tasks`).
A Durable Object alarm runs queued tasks one at a time, at most three per alarm,
with fixed Workers AI Qwen (`@cf/qwen/qwen3-30b-a3b-fp8`, 1200 output tokens).
There are no retries or other providers, and a task left running by a crash
fails rather than rerunning.

- `POST /v1/tasks` `{kind, input}` returns `202 {id, status, position}`; it
  needs an allowed `Origin`, so plain scripts cannot submit.
- `GET /v1/tasks/<32 hex id>` returns status and, when done, the result. The
  random ID is the only access control: anyone with it can read the result.
- `GET /health` lists the task kinds.

Caps (`wrangler.jsonc` vars): 5 tasks per hashed network address per hour, 100
per UTC day for everyone, 25 waiting at once. Accepted tasks count even if they
fail. These are separate from the Qwen chat Worker's 500/day, so Workers AI
usage from both can add up. The task text is cleared when the task finishes;
results are deleted after 7 days. The page keeps task IDs only in the visitor's
`localStorage` and renders results as plain text.

```powershell
npm run test:tasks
npx wrangler deploy --config workers\tasks\wrangler.jsonc --dry-run
```

Tests back the board with `node:sqlite` and use a fake AI binding; no inference
is called. Deploying the Worker (and then the site, whose CSP allows the task
origin) is a separate approved step. Verify `/health`, one real non-private
task, and a refused origin before linking the page more widely.

## Dev site (static, no tooling)

```powershell
python -m http.server 8788 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:8788/ and refresh after each edit. This does not apply the
`_headers` file or Cloudflare's email/analytics injection, so it differs slightly
from production.

## Dev site with Wrangler (matches Pages behaviour)

```powershell
npm install
npm run dev:site
```

Wrangler's local runtime (`workerd`, `esbuild`) needs npm install scripts to run.
npm blocks them by default; approve them once with `npm install-scripts approve`.

## Workers, locally

`npm run dev:sync`, `dev:node-worker`, `dev:gateway` run each Worker with its
`wrangler.dev.toml` configuration and `--local`,
which uses simulated D1/KV/R2/Durable Objects and never touches live data. Secrets
go in an untracked `.dev.vars` file next to each `wrangler.toml` (gitignored).

## Preview deployment (public URL, production untouched)

```powershell
npm run preview:site
```

Deploys `site/` to the Pages `preview` branch environment of `rabbitsoftware-site`.
Promote to production only after review, from the Cloudflare dashboard or with
`--branch master`.

## Checking the live site

```powershell
npm run probe     # website, RabbitOS console, API and agent Worker health, from your computer
```

The same checks run in the browser at https://rabbitsoftware.io/status. `scripts/dev-smoke.mjs` is a dev-only signed smoke test against the `-dev` resources
(`wrangler.dev.toml` in each Worker); never point it at production.

## Rules

- Do not redeploy the Worker bundles blindly; keep existing bindings and secrets.
- Never commit `.dev.vars`, `backup/`, or anything under `private-cloud-data`.

## Public application setup

`site/installers/setup.py` replaces the retired Helloworld installer links.
It pins separate backend, monitor and research source revisions, creates
component-specific virtual environments and never starts persistent services
or tunnels. The backend sparse checkout uses a per-command NTFS override to
index legacy upstream filenames without materializing them on Windows.
Keep `site/setup.html` and the home-page component descriptions aligned.
Do not imply that installing the backend installs the hosted RabbitOS console.

Run `python -B scripts\test-site-installers.py` for offline regression checks
and `npm run check:csp` for changed HTML. Actual setup validation requires
network downloads; use a fresh isolated `--directory` for each platform.
The smoke checks cover backend health, monitor help and research dependency
imports, not the full multi-service research stack.

`site/local.html` describes offline versus hosted capabilities. The static site
can run over loopback with no internet for bundled research/corpus/local-file
lookup. Hosted email/account sync and live search are separate services, not
offline implementations. Optional local Ollama chat uses
`python scripts\local-site.py --model qwen2.5:3b`; the model must already be
installed. Only same-origin loopback chat requests are accepted; the upstream
is fixed to loopback, proxies and redirects are disabled, and there is no
hosted fallback. Run `python -B scripts\test-local-site.py` for request guards
and failure/output-shape regressions. The status page checks hosted health only
on button activation. Historical full reports and the browser-agent ZIP remain
unavailable; do not fabricate replacement downloads.

`python -B scripts\test-site-installers.py` checks all local HTML file targets.
`node --test scripts\test-chain-viewer.mjs` checks the restored viewer's bounded
format adapters and account-scope omission. Published CLI ZIPs and simulation
source were recovered from the existing public website, not private backups.

## CRISPR and bio research tools

These live in the sibling repository `rabbitsoftware-io/research-agents`
(`C:\Users\odaat\Projects\research-agents`, reachable from the vault as
`Code/research-agents`). Everything works on text and public read-only data: no
lab protocol, no delivery method, no pathogen or toxin work, and nothing for use
on a person. Guide scores are a GC + seed-region heuristic, **not** a validated
efficiency or off-target model; real work needs CRISPOR or Cas-OFFinder and lab
testing.

| Need | Call |
|---|---|
| Transcripts, guides, CRISPR literature, audit-chain digest | `python crispr_data.py` (`--gene BRCA1`, `--no-literature`) |
| Guide finder (20-mer + NGG, both strands) | `crispr_guide_design.find_guide_candidates(seq, top_n)` |
| Spacer checks (GC, poly-T, self-folding) and protein effect of an edit | `bio_tools.guide_quality(guide)`, `bio_tools.edit_effect(cds, index, edit)` |
| All four pieces together | `python crispr_research_suite.py` |
| Literature only (trials, papers, preprints) | `python crispr_cancer_research.py`, continuous: `crispr_research_agent.py` |

Records are written to `crispr_records.json` and reach RabbitOS only through
`rabbit_sync.py`'s signed ingest, the same path the other agents use.

```powershell
cd C:\Users\odaat\Projects\research-agents
python -m unittest test_crispr_data test_bio_tools
```

The repo's interpreter is `.venv-eeg` (VS Code `.vscode/settings.json` selects it
and loads `.env` into new terminals). It started as the EEG environment, so the
bio packages were added separately: `python -m pip install biopython ViennaRNA
primer3-py`. Without biopython every `bio_tools` test errors with
`No module named 'Bio'`.

On `main`, `test_crispr_data.test_real_transcripts` fails with
`AttributeError: 'list' object has no attribute 'upper'`: `crispr_data.py` caches
coding-region ranges under `cds:<accession>` keys in `crispr_cache.json`, and the
test treats every cache entry as a sequence. PR #6 carries the two-line fix
(skip keys starting `cds:`), so merging it repairs the suite.

`.claude/skills/crispr-guide-design/SKILL.md` is the Claude Code skill that
routes CRISPR questions to these tools; keep its table in step with the one above.

### crispr_tool.py (one-stop CLI, PR #6, not yet merged)

Branch `crispr-tool` adds a single command-line entry point: guides on a built-in
gene (BRCA1, BRCA2, PARP1 real RefSeq transcripts, downloaded once and cached),
on a pasted sequence or on a FASTA file, with quality flags and an optional edit
preview that reports the protein change.

```powershell
python crispr_tool.py --gene BRCA1                       # top guides
python crispr_tool.py --gene BRCA1 --guide 1 --delete 1  # preview a 1-base deletion at the cut
python crispr_tool.py --seq ACGT... --cds 1 300 --json   # your own sequence, machine-readable
python -m unittest test_crispr_tool
```

It reuses `crispr_data.guide_records` and a new `bio_tools.protein_change`, so
the CLI and the RabbitOS path agree on guides and on edit effects. Reverse-strand
edits are applied in the guide's own orientation and reported in forward
coordinates. Review and merge PR #6 before documenting it as available.

## Obsidian, Copilot, and GitHub

The local `RabbitOS Vault` at `C:\Users\odaat\Documents\RabbitOS Vault` is
connected to the **public** GitHub repository
`rabbitsoftware-io/obsidian-rabbitos-vault`. Its `git-obsi-sync` plugin
syncs **automatically every 3 seconds** through the GitHub API, so vault changes
are published within seconds. The plugin does not read the vault `.gitignore`:
only its own exclude patterns (Obsidian Settings → Git Sync) keep folders off
GitHub. `Local/` and the linked library folders are excluded; generated notes and
agent state elsewhere in the vault are published. Add a folder to those patterns
before writing private files there. This does not merge the vault into this
Cloudflare repository or change either repository's deployment workflow.

The vault uses the **Local REST API with MCP** community plugin, installed from
`coddingtonbear/obsidian-local-rest-api` release `5.4.0`. It requires Obsidian
`1.13.1` or newer. Keep Obsidian running with RabbitOS Vault open and the plugin
enabled. The authenticated MCP endpoint is `http://127.0.0.1:27123/mcp/`.
HTTP is enabled only on loopback to avoid self-signed TLS client issues; do not
expose this port through a tunnel or change its binding to a network interface.

Copilot's user configuration at `%USERPROFILE%\.copilot\mcp-config.json` contains
the `obsidian-rabbitos` HTTP server. The API key is stored locally in that file
and the plugin's `data.json`, not in this repository. The plugin directory is
ignored in the vault's Git repository to keep its key and TLS private key out
of GitHub. Do not copy either credential file into notes or source control.

Open a new Copilot session after setup, approve the server if prompted, and
check its status with `/mcp` (or `copilot mcp list` in a terminal). VS Code's
**MCP: Add Server** command with the **Copilot Global** destination can configure
the same connection if using another profile or machine.

Example request: "Use obsidian-rabbitos to find my Rabbitsoftware project notes,
then compare them with this repository and its GitHub issues." GitHub access
continues through Copilot's existing GitHub integration; no extra GitHub token
is needed for the Obsidian connection.

The Rabbit Vault Agent community plugin is enabled for local-first tasks.
Its default provider is loopback Ollama `qwen2.5:3b`; no remote fallback or
automatic original-note edits are enabled. CPU-only inference has a bounded
ten-minute wait per model turn; hosted inference retains its three-minute
limit. Timeouts remain explicit failed runs with private retained reports.

The plugin exposes note read/write and command tools. Review approvals before
allowing edits or commands. Vault notes used in a Copilot request can become
model context; do not request secrets or private linked-folder contents.
Git ignore rules are not MCP access controls. Setup verification initializes
MCP and lists tools without reading, editing, or uploading note contents.

## Owner cloud command shell and connection map

The separate [cloudshell Worker](workers/cloudshell/README.md) and owner-only
RabbitOS cloud bridge are activated as separate pilot services, not a change
to the main production console.
Use `npm run test:cloudshell` and `npm run typecheck:cloudshell`; Worker-only
dry-run packaging and the full Docker image build/run succeeded. Native Windows
container development needs WSL, whose Node/Docker integration is still pending.
The pinned image includes Bash/Node, not Python. See the component guide for the exact contract,
ephemeral workspace, durable concurrency gate, explicit recovery and cost gates.
No secret enters the browser or command environment. A 60-second command
timeout is distinct from container startup and teardown.

The current RabbitOS console keeps legacy account/login routes disabled.
New tool access supports three explicit modes: locked `local-only` by default,
restricted verified Supabase identities, and signed Cloudflare Access JWTs.
The user selected additional people from an operator-controlled allowlist,
with agent-side scoped approval lasting one hour. A separate persistent
approval broker verifies configured subject/capability policy; it never trusts
an AI's approval prose, a browser identity, or a client approval flag.
Caller-agent, backend-service and approving-agent credentials are distinct.
Missing tokens/URLs are configuration failures, not successful jobs.
Submit/status/result viewing does not automatically return cloud output to
local notes; use the existing approved vault connector. Same-grant job links
prevent guessing another person's or agent's job IDs.

`npm run vault:cloud-access -- --vault <path> <action>` supplies explicitly
authenticated local/connected agent requests and decisions, with automatic
private retained success/failure reports. See the component guide for exact
actions, environment references and scope/expiry constraints. The approved
pilot has one allowlisted email and the fixed `local-vault-agent` identity,
distinct protected credentials and a verified one-hour agent grant.
An explicitly configured local Ollama runtime also exposes `cloud_access`
request/status/decision actions, with environment-only credentials and
model-origin report evidence. Hosted note providers and arbitrary shell actions
are refused by this native tool; coding agents use the separately authenticated
CLI for consented command/snapshot actions.

The vault hub `Pathways/Agent Worker Frontend Backend Network.md` now links
the real frontend, BFF, Workers, local dispatchers, cloud-note jobs, retained
mailbox, network transports and reports. Companion notes separate integration
gaps, owner-shell operation and proposed business responsibilities. They are
private (`cloud-agent-share: false`), not cloud-upload permission or a scheduler.

The user approved Docker, paid Containers activation and isolated deployment.
Live shell health/consent boundaries and exact synthetic command output were
verified, including both remote console machine routes. Additional paid
resources or wider identities still require separate approval.
The previously published public development guide and private exact snapshot
remain the last approved publication; this local documentation update was not
republished or redeployed.

The live isolated entry points are
`https://rabbit-web-cloud-supabase.rabbitsoftware-gateway.workers.dev` and
`https://rabbit-web-cloud-access.rabbitsoftware-gateway.workers.dev`; the broker
is `https://rabbitsoftware-cloudshell.rabbitsoftware-gateway.workers.dev`.
The Access application has reusable exact-email and exact-service-token
policies. Anonymous requests redirect to authentication; signed service JWT
verification uses the actual empty `sub` and exact signed `common_name`.
The pilot Access service token expires 2026-10-13T18:44:42Z and grants expire
after one hour; neither is silently renewed.

The native plugin is enabled and uses a host-owned local provider configuration
for Ollama, with only `cloud_access` request/status actions. Its bounded caller
credential loader passes only the caller token and strips backend/approval/note
tokens. Existing hosted note-provider settings are preserved. **Report connected
cloud-access status with the local agent** is a native Obsidian command;
Obsidian's separate desktop CLI remains disabled and is not required.
The native status-report command passes `--require-cloud-status true`: the
existing exact-call guard rejects an answer without a successful model-selected
status call. It does not silently execute a tool or expand host permissions.
Live CLI receipts and local model runs retain private reports automatically.
A consented public-synthetic note job completed with its exact marker/path and
empty edits. Same-grant reads through both consoles passed; guessed-job and
machine browser-Origin reads were denied. Human browser sign-in remains
unverified; these activation tests uploaded no private notes.

## Hugging Face account in the vault

```powershell
python scripts\sync-huggingface-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault"
python -B scripts\test-sync-huggingface-vault.py
```

Writes one note per model, dataset and Space (metadata, file list, card and
README) plus an index at `Hugging Face/Hugging Face.md`. It only reads from
Hugging Face, never downloads weights or data files, and uses the existing local
sign-in (`HF_TOKEN` or `~/.cache/huggingface/token`). Private repo cards land in
the vault, so `/Hugging Face/` must stay in the vault `.gitignore`; the script
refuses to run otherwise. Unchanged notes are not rewritten, and notes for repos
removed from Hugging Face are reported, not deleted. Run it manually; no schedule.

## Obsidian cloud agents

The isolated cloud service was activated with approval on 2026-10-12:
`https://rabbitsoftware-vault-agent.rabbitsoftware-gateway.workers.dev`.
Its private R2 bucket, Workflow, and SQLite budget are separate from all
existing resources. Authenticated health, anonymous rejection, actual inference,
durable output shape/content, and identical-job replay were verified using only
synthetic public data. No existing vault notes were uploaded.

`workers/vault-agent/` and `scripts/vault-agent-sync.mjs` provide a separate,
single-vault, bearer-authenticated note assistant. It uses R2 for immutable job
snapshots and results, Workflows for processing after your computer goes offline,
and a SQLite Durable Object for a fixed shared 20-inference-attempt UTC daily
cap. Failed inference attempts count. Generation has zero automatic retries and
a 4000-output-token limit; it uses only Workers AI Qwen3, with no fallback.
This is an attempt/token cap, not a guaranteed dollar budget.

The vault-side layout is:

- `Cloud Agents/Knowledge/`: notes you explicitly opt in.
- `Agents/` and `Workers/`: existing notes, included only if individually opted in.
- `Cloud Agents/Inbox/`: task notes (task, answer, or organize mode).
- `Cloud Agents/Results/`: generated Markdown and companion edit-proposal JSON.
- `Cloud Agents/Backups/`: originals preserved before approved replacement.

Only Markdown notes with the exact, unquoted top-level YAML line
`cloud-agent-share: true` are shared. Default starter notes have `false`.
Knowledge snapshots contain 1-40 notes, each at most 16000 UTF-8 bytes, and
must fit a 64 KiB JSON request including the instruction. The connector reports
excess size instead of silently dropping or truncating notes. Links are not
followed, attachments are not uploaded, linked filesystem directories are
refused, and other vault folders are outside the allowlist.

These copies are sent to Cloudflare R2, Workflow storage, and Workers AI.
Never opt in secrets, personal/EEG/medical information, private source code,
credential files, or private repository snapshots. The credential detector
blocks only several recognizable token/private-key forms; it is not a privacy
scanner. Revoking the marker stops future uploads but does not remove snapshots
already stored in the cloud. There is no automatic remote retention/deletion
policy. Request an explicit bucket/workflow cleanup when retiring the service.

Inbox note example:

```markdown
---
cloud-agent-share: false
cloud-agent-mode: answer
---
Explain how the selected Workers and Agents fit together, citing vault paths.
```

Use `task` for note-based writing/analysis, `answer` for questions, and `organize`
for summaries plus optional full-note edit proposals. These assistants have no
shell, browser, deployment, or external-action tools. They cannot execute arbitrary
code, edit running Workers, or act on private information outside the snapshot.
The organize mode can propose replacements of supplied notes, not rename/delete
files or change unrelated folders.

### Local checks and connector use

```powershell
npm run test:vault-agent
npx wrangler deploy --config workers\vault-agent\wrangler.jsonc --dry-run
npm run vault:agents -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --plan
```

The tests run real local Workflows/R2/SQLite with a clearly test-only AI service,
including all three modes, the actual connector submit/download/approval flow,
idempotency, revocation before upload, byte limits, conflict rejection, backups,
and persistence after restart. No notes or inference calls reach Cloudflare.
`npm run dev:vault-agent` uses only `-dev` simulated storage and intentionally
has no AI binding: jobs fail explicitly if inference is attempted. Set a local
token in the ignored `workers/vault-agent/.dev.vars` for authenticated API testing.
Do not add a remote AI binding merely to make local testing succeed.

Activation requires **explicit approval** to create the dedicated
`rabbitsoftware-vault-agent` R2 bucket, deploy the new Worker/Workflow/DO, and
set its `VAULT_AGENT_TOKEN` secret (32+ random characters). Do not reuse the
sync bucket, existing Worker bundles, or the Obsidian API key. Keep the R2
bucket private. After approval, provision the named bucket first, deploy only
this Worker's production config, and set its secret interactively using
Wrangler. Verify an authenticated `/health` and a synthetic non-private job
before allowing any note upload.

Set `VAULT_AGENT_URL` to the resulting HTTPS Worker origin (no path or trailing
API route) and `VAULT_AGENT_TOKEN` in the local process environment; never put
the token in notes, commands saved in the vault, or tracked files.

```powershell
# Review the opted-in file list first. No network request is made.
npm run vault:agents -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --plan
# Only after reviewing each selected note and enabling desired inbox entries:
npm run vault:agents -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --sync --allow-upload
# Run again when the computer is on to fetch finished jobs without any upload.
npm run vault:agents -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --pull
# Review the result JSON and compare replacements with current notes first.
npm run vault:agents -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --apply <job-id> --approve-edits
```

Submitting records a durable immutable snapshot and starts the Workflow. Cloud
processing can continue with the computer off; **new local tasks and results
cannot sync while the computer is off**. Running the connector is manual; no
OS scheduled task or recurring automation is installed.

Connector state, including retryable snapshots, stays in the Git-ignored
repository `.wrangler/vault-agent-sync/` directory, keyed by vault and Worker
origin. Preserve it across runs. A connector lock prevents overlapping runs.
If it crashes, confirm no connector is running before removing its specific
stale `sync.lock`. Unchanged inbox notes do not rerun when knowledge changes:
edit the task text to request a new revision. Identical mode/instruction/snapshot
combinations share one content-addressed job and do not spend on repeat submissions.
Failed jobs are reported; edit the task text to retry, rather than silently
restarting an errored Workflow.

Downloads never overwrite edited results. Approval checks every proposal
against the submitted snapshot and current file hash before changing any note;
originals are backed up, and changed notes are refused. Close other editors while
applying: filesystem edits are not cross-application transactions, and a write
failure can leave a partially applied batch recoverable from the backups.
Applying again skips replacements already applied. Local JSON proposals can be
reviewed but should not be hand-edited; submit a new task revision instead.

## Portable vault task coordination

`npm run vault:tasks` is a separate persistent coordinator; existing one-shot
agent/plugin behavior is unchanged. It defines work as versioned JSON rather
than binding work to a programming language, OS or provider. Namespaced
capabilities are extensible: a peer can advertise `code.check`,
`network.discover`, or another capability without a new local task format.
Only capabilities actually implemented by an authorized adapter can execute.
The protocol uses JSON, SHA-256 and HTTPS; this implementation needs Node.
A bare-metal/older host still needs its own compatible transport/runtime adapter.
No universal compatibility or uninterrupted execution is promised.

Create a task JSON file (not a credential file):

```json
{
  "version": 1,
  "capability": "notes.search",
  "instruction": "syntax",
  "adapters": ["local"],
  "dependsOn": [],
  "notes": [],
  "share": false
}
```

```powershell
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --discover
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --enqueue task.json
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --list
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --run
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --artifact <output-hash>
```

Enqueue prints a SHA-256 task ID. A later task puts that ID in `dependsOn`;
dependencies must already exist, preventing forward-reference cycles.
Completed output is stored once by content hash, and tasks store references.
Request snapshots remain frozen after first preparation; changed notes need a
new task definition/instruction. Do not edit coordinator state by hand.
`notes.read` requires explicit note paths. `notes.answer` reads selected notes
or the top two search matches; `text.transform` consumes explicit notes and
dependency outputs. Those two capabilities use local Ollama. Search/read need
neither a model nor internet. This coordinator does not execute proposed code
or edit originals.

State is atomically replaced under `Cloud Agents/Coordination/state.json`.
It may contain private snapshots and is Git-ignored in the configured vault.
Other vaults must ignore this directory too. Integrity checks reject corrupted
artifacts/definitions; unsupported state versions are preserved, never reset.
A process lock prevents concurrent runs. A crash can leave `state.json.lock`;
verify its recorded PID has stopped before removing that specific lock.
Atomic rename is not a distributed-filesystem transaction or a substitute for
backups. Do not share this state between concurrent machines via file sync.

Budgets: 128 tasks, 256 unique artifacts, 65536 UTF-8 bytes per artifact,
8 MiB serialized state, 8 dependencies and 8 explicit notes per task.
Each manual `--run` processes at most 8 tasks serially and caches discovery
per adapter. Model context/turn budgets and cloud job snapshot limits still
apply. Storage exhaustion is an explicit error, not an automatic deletion.
`--prune <id>,<id>` removes reviewed terminal tasks and unreferenced artifacts;
it refuses to remove a dependency still referenced by a retained task.
Pruning local state does **not** delete remote jobs or R2 snapshots. Remote
retention, quotas and costs remain the provider/operator's responsibility.
Existing one-shot Results/Proposals are outside this coordinator's budget.

Connection/time-out/overload failures retain prepared input and wait with
bounded backoff, failing after 5 such execution failures. Discovery failures
remain visible waiting states with a 60-second retry interval. Run again when
connectivity returns; nothing runs while this computer is off. Accepted durable
remote jobs may continue independently. `--retry <id>` explicitly resets retry
attempts for waiting/blocked/failed work, without changing its immutable request.
An errored Cloudflare Workflow needs a **new task revision**, not replay of its
already-errored immutable job. Dependent work waits or reports its failed
prerequisite; retry it explicitly after repair.

Adapters are attempted in the task's explicitly approved order only until one
compatible adapter is selected. Its endpoint/type or local model is then pinned;
ambiguous failures never silently move work to another provider. To intentionally
change providers, create a new task definition. Unknown versions/capabilities
produce visible errors/waiting states: add and test a compatible adapter rather
than claiming automatic old/new-version compatibility.

### Autonomous local coding and repair

The `coding-local` adapter adds capability `code.repair` using the installed
Copilot CLI and the existing login. This is **local execution with hosted
Copilot inference**, not offline Ollama. Both adapter `allowExecution: true`
and `allowRemote: true`, plus task `share: true`, are mandatory. Approve the
exact source scope as suitable model context; never select private code,
credential files or personal notes. No vault notes are read by this adapter.
Existing local/offline note capabilities are unchanged.

Example local configuration (replace CLI path with your installed binary):

```json
{
  "adapters": [{
    "id": "coding",
    "type": "coding-local",
    "projectRoot": "C:\\Users\\odaat\\Projects\\rabbitsoftware-cloudflare",
    "cliPath": "C:\\path\\to\\installed\\copilot.exe",
    "allowExecution": true,
    "allowRemote": true,
    "files": ["tools/vault-agent/examples/coding-syntax.mjs"],
    "tests": ["tools/vault-agent/examples/coding-syntax.test.mjs"],
    "maxRounds": 3,
    "maxLines": 12,
    "apply": true
  }]
}
```

The adapter pins its canonical project, executable, file scope, validation,
limits and apply approval. It copies only 1-20 explicit source files and 1-8
separate **immutable** Node test files, rejecting links and credential patterns.
Inputs are frozen as content-addressed coordinator artifacts. It supports
self-contained Node-testable modules; it does not copy dependencies, install
packages or run arbitrary package scripts. Choose a tested compatible adapter
for other languages/build systems rather than broadening command permissions.
Splitting into new files requires those modules to exist in the approved scope.

Task definition:

```json
{
  "version": 1,
  "capability": "code.repair",
  "instruction": "Repair the selected function while preserving its required behavior.",
  "adapters": ["coding"],
  "dependsOn": [],
  "notes": [],
  "share": true
}
```

```powershell
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --config ".wrangler\vault-coding-config.json" --discover
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --enqueue ".wrangler\vault-coding-task.json"
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --config ".wrangler\vault-coding-config.json" --run
```

The configured scope on this computer currently covers **only the public
synthetic addition example**, not unrestricted access to the connected repos.
On 2026-10-12, the real installed Copilot CLI repaired that example through the
vault queue, the runner verified fixed positive/negative/fractional tests, and
applied the change with a backup. The persisted task status is `done`.

During one `--run`, the agent autonomously edits a copied workspace, then the
runner executes the approved fixed Node tests and checks source line budgets.
Failures feed back into up to 3 repair rounds; a claimed answer or process exit
alone is never success. Source line budget is configurable (1-2000, default
400). Context is split losslessly into chunks of at most 4096 UTF-8 bytes and
80 newline delimiters with a hash manifest; instructions tell the host to read
every chunk. Huge source lines must be refactored, not truncated. Per-file
64 KiB and total source-snapshot 256 KiB limits remain explicit errors requiring
smaller dependency tasks. Context is capped at 64 KiB.

CLI tool exposure is limited to view/edit/create/glob/grep, shell tools are
denied, built-in MCP is disabled, and temporary-directory access is disabled.
Only the external runner executes the approved Node tests. Ambient token/secret
variables and Node test/options injections are removed from child environments;
the CLI uses the existing signed-in host profile. The host's tools/MCP/network
permissions are **not** automatically broadened. This is **not an OS sandbox**:
Node tests can execute arbitrary code with the user's account. Only approve
trusted tests/source; use a real container/VM for untrusted workloads.
CLI/version changes that reject these controls fail explicitly.

An agent call has a 180-second deadline; validation has 120 seconds. Combined
process output is capped at 64 KiB. On Windows, timeout/overflow terminates the
specific child PID tree, never processes selected by name. Unexpected files,
links, changed tests or task-context chunks reject validation; workspace text
is checked against a 1 MiB budget after each agent/validation invocation.
This is a post-execution check, not a filesystem quota.

Validated updates stay staged unless `apply: true` was explicitly configured.
Application checks all original source hashes, backs up originals, rechecks
before each write and leaves unrelated dirty files alone. It is not a
cross-editor transaction: close other editors during apply. Partial batches
can resume only for unchanged originals or already-applied content; backups
remain available for operator recovery. No deployment, publishing, spending,
secret access or permission changes are authorized by a coding task.

The idempotency ledger and workspace are retained under
`.wrangler/vault-coding/<task-id>/` in the approved project, separate from the
vault state. Completed work returns its saved receipt without re-execution.
A project-wide `coding.lock` prevents overlapping coding runs even from
different vaults. After a crash, verify its recorded PID stopped before removing
that specific lock; it is never automatically discarded.
An interrupted agent/validation invocation stops for operator review rather
than blindly repeating an ambiguous action. Failed/exhausted repairs do not
restart just because a coordinator task is retried; inspect the retained
feedback and submit a new task revision after repair. Stale coordinator locks
need PID verification as documented above.
Coordinator pruning does not remove these workspaces/backups; review and clean
specific completed job directories separately. There is no aggregate disk quota,
resident daemon, automatic schedule or guarantee against storage exhaustion.

New validated coding receipts also include changed source contents and hashes
so a downstream mailbox can retain code, not just a temporary path. Receipt
serialization must fit the 64 KiB artifact budget **before** copy-back; larger
changes remain unapplied and need a smaller task scope.

Cloud-shell tasks still use explicit authorized HTTPS adapters. No shell was
provisioned or connected. Until an appropriate configured shell advertises the
requested capability, that work stays visibly waiting; no local/cloud provider
switch is made after an adapter is pinned.

```powershell
node --test scripts\test-vault-agent-coding.mjs tools\vault-agent\examples\coding-syntax.test.mjs
```

### Authorized remote and cloud-shell adapters

Optional `--config <local-config.json>` selects up to 16 adapters. The default
is only `local`; no remote host is contacted by default. Keep config outside
tracked notes (for example, the ignored repository `.wrangler` directory).
This example config contains no secret values:

```json
{
  "adapters": [
    { "id": "local", "type": "local" },
    {
      "id": "cf",
      "type": "cloudflare-jobs",
      "url": "https://rabbitsoftware-vault-agent.rabbitsoftware-gateway.workers.dev",
      "allowRemote": true,
      "tokenEnv": "VAULT_AGENT_TOKEN"
    },
    {
      "id": "shell",
      "type": "cloud-shell-http",
      "url": "https://your-authorized-service.example",
      "allowRemote": true,
      "tokenEnv": "VAULT_SHELL_TOKEN"
    }
  ]
}
```

Supply each token through the process environment without printing it or putting
it in a saved command. Missing remote credentials are reported by discovery and
do not disable unrelated local adapters. `local` optionally accepts
`providerConfig` referencing a local Ollama configuration.
An adapter `{"id":"hosted","type":"model","allowRemote":true,"providerConfig":"<ignored-provider-config.json>"}`
reuses the existing explicitly configured OpenAI-compatible provider, including
its model, HTTPS endpoint, token and separate provider-level `allowRemote` approval.
It supports `notes.answer` and `text.transform`, with the same opted-in snapshots
and dependency gates; it never chooses a hosted endpoint by itself. Model calls
use the existing bounded client and 180-second timeout, not the service-adapter
30-second timeout. Its credentials remain in the ignored local provider config,
never coordinator state.

`agent-http` and `cloud-shell-http` are provider-neutral clients for an **existing
authorized service** implementing the contract below. They do not provision a
Google/Azure/AWS shell, launch arbitrary SSH/CLI commands, or turn the desktop
Obsidian plugin into a headless server. The service operator must separately
authorize sandboxed execution, account scopes and any consequential actions.

All remote operations require task `share: true` plus adapter `allowRemote: true`.
Explicit notes must also have `cloud-agent-share: true`. Shared local tasks use
that same opted-in read scope; private dependency artifacts cannot be reclassified
as exportable by a later shared task. Consent is not a complete privacy scanner:
review prompts, inputs and outputs. Credentials never belong in task artifacts.
HTTPS credential-free URLs, no redirects, and bounded JSON constrain remote
calls. Service adapters enforce 30-second timeouts and 64 KiB outbound and
inbound JSON limits; model adapters retain their existing model-client budgets.

The Cloudflare bridge negotiates its existing `/health`, submits normalized
immutable `/jobs` snapshots, and polls durable result/status endpoints. It
supports `notes.answer` and `text.transform`; supply explicit opted-in notes
or shared dependency outputs. Its 16 KiB per-note and 64 KiB job limits remain.
It proposes text only, not shell execution. No Worker deployment was needed.

Agent/cloud-shell contract (all endpoints require Bearer authentication):

- `GET /capabilities` returns
  `{"versions":[1],"capabilities":["shell.job"],"idempotentTasks":true,"peers":[]}`.
  Peer hints (maximum 16) are informational "gossip", never automatic trust,
  network scanning, broadcast, credential forwarding or new adapter registration.
- `POST /tasks` accepts
  `{"version":1,"id":"<task-hash>","definition":{...},"notes":[{"path":"...","content":"..."}],"inputs":[{"task":"<dependency-id>","artifact":"<content-hash>","content":"..."}]}`.
  It returns `{"version":1,"id":"<task-hash>"}`. The service must persist
  idempotency **before executing**, associate the ID with the entire immutable
  request, and reject a differing request for an existing ID. Replays after a
  timeout must never execute the shell action twice.
- `GET /tasks/<id>` returns
  `{"version":1,"id":"<task-hash>","status":"queued|running|waiting"}` while
  pending, or `{"version":1,"id":"<task-hash>","status":"done","content":"bounded result"}`.
  Other statuses are explicit failures. All JSON messages must fit 64 KiB.
  A claimed idempotency capability is not proof: contract-test your service
  and enforce host-side execution/approval/resource limits before real work.

```powershell
node --test scripts\test-vault-agent-tasks.mjs scripts\test-vault-agent-runtime.mjs
```

Tests cover real filesystem restart/locking/integrity/CLI behavior, exact
capacity and UTF-8 byte limits, dependency sharing gates, retries, provider
pinning, and mock HTTP contracts for agents, cloud shells and the Cloudflare
bridge. They do not provision or live-test a new cloud shell.

## Retained agent communication

`npm run vault:network` adds a store-and-forward mailbox independent of an
agent's current session. It stores immutable code, handoff text and task
receipts at `Cloud Agents/Network/mailbox.json`, with content-hash deduplication,
atomic replacement, file sync, a single-host process lock and integrity checks.
The configured vault ignores this directory in Git. Other vaults must add the
same ignore rule. Keep backups; "durable" does not mean immune to disk loss,
manual deletion or an unpowered machine.

Messages survive the sender/receiver leaving a task or restarting. Reading
does not consume them. Recipients explicitly acknowledge the exact message
and content hash **after** durable processing; pending messages are replayed
until acknowledged. Acknowledged code remains readable until explicit pruning.
Delivery is at least once, not exactly-once execution: recipients must keep
their own processed-message IDs before applying side effects, and must not
interpret a received code block as permission to run it.

Create a message JSON file:

```json
{
  "version": 1,
  "sender": "coding-agent",
  "recipient": "vault-orchestrator",
  "key": "syntax-result-v1",
  "kind": "code",
  "route": "local",
  "share": false,
  "content": "export const add = (a, b) => a + b;"
}
```

`sender`/`recipient` are lowercase names, not URLs or credentials.
The key is a sender/recipient-scoped revision/idempotency key; reusing it with
different content or routing is refused. A local route has no network upload.
A cloud route additionally requires `share: true` and remains
`cloud-pending`—no remote service, tunnel or delivery daemon was authorized.
Queued cloud messages cannot be locally acknowledged or silently pruned.
Do not place secrets or private data in exportable messages.

```powershell
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --send ".wrangler\vault-network-handoff.json"
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --receive vault-orchestrator
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --read "vault-orchestrator:<message-id>"
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --list
```

These commands can run from another task/shell using an absolute script path
and vault path; the caller does not need to work inside the vault. They require
the same host/filesystem authorization. This is not a multi-host shared-file
queue; do not operate concurrent copies over Dropbox/OneDrive/Git.

After safely processing a message, an acknowledgment JSON file contains
`{"recipient":"vault-orchestrator","id":"<message-id>","artifact":"<content-hash>"}`:

```powershell
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --ack "<ack-file.json>"
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --prune "<acknowledged-id>,<acknowledged-id>"
```

`--receive` returns up to 16 pending message headers, not bulk code contents,
plus a remaining count. Read the individual messages. The mailbox caps retained
messages/artifacts at 128 each, content at 65536 UTF-8 bytes per message and
serialized state at 8 MiB. CLI input JSON is capped at 128 KiB including JSON
escaping. No pending message is auto-deleted or overwritten on exhaustion;
storage full is a visible failure. Split larger work into explicitly ordered
revision keys. Operator pruning removes only acknowledged local messages and
unreferenced content. Once pruned, its deduplication tombstone is gone; replaying
that old key creates a new message. Keep recipient processing IDs for stronger
side-effect idempotency.

If the process crashes, inspect `mailbox.json.lock` and verify its recorded
PID stopped before removing that specific lock. Unsupported versions,
missing/corrupted artifacts and changing immutable keys are rejected without
resetting stored information.

### Coding/task feedback retained for other agents

```powershell
npm run vault:tasks -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --publish vault-orchestrator
```

This reads completed/failed/blocked tasks and copies their status and result
contents into local `task-receipt` messages. It does not execute the task again,
read arbitrary paths, contact a cloud provider or grant permissions. Repeated
publishing is deduplicated; changed status/result creates a new receipt.
Publishing is explicit rather than a transaction with task execution: if the
mailbox is full or the host stops, repair capacity and run `--publish` again.
Receipts retain result content independently of coordinator pruning.
New coding repair receipts include validated changed source paths, content and
hashes; receipts created before this feature still have their original metadata.
Oversized receipt content is refused, not truncated. Retained workspaces/backups
remain separately governed by the coding adapter's cleanup rules.

### Optional authenticated local network transport

For other local agents/processes, start the mailbox only on loopback:

```powershell
# Generate a temporary server credential without printing or saving it.
$env:VAULT_MAILBOX_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --serve 8810
```

Supply the token to authorized local clients via their process environment,
never notes, command-line arguments, browser pages or model context. Stop the
foreground server with Ctrl+C. It is not installed as a Windows service and no
scheduler was created. Its address/port is printed, never its token.

All endpoints require `Authorization: Bearer <token>`:

- `GET /health`: version 1, loopback transport, `cloudDelivery: false`.
- `POST /messages`: the message JSON above; returns ID, replay flag and status.
- `GET /inbox/<recipient>`: up to 16 pending message headers.
- `GET /inbox/<recipient>/<id>`: retained local message and code content.
- `POST /ack`: acknowledgment JSON; idempotently records completion.

The service binds **only** `127.0.0.1`, accepts only loopback Host headers,
refuses browser Origin headers, emits no CORS grants, compares hashed tokens
in constant time, and limits incoming JSON to 64 KiB of actual streamed bytes.
HTTP content near the CLI content limit may exceed the JSON envelope budget;
split it or use the same-host CLI, never silently truncate. Received message
JSON includes metadata/escaping in addition to the bounded content.
Connection/header/request limits bound server work. Tokens authorize the
whole local mailbox, not separately authenticated recipient identities;
message sender/recipient labels are routing metadata, not proof of identity.
Do not give this token to an untrusted agent. Local filesystem permissions
remain the security boundary for CLI callers.

The production Cloudflare Worker cannot call your computer's loopback address.
It retains its existing snapshot/results API; future cloud-mailbox integration
needs a separately authorized deployment/service and client adapter. No
private note was uploaded, no local port exposed publicly, and no cloud
deployment happened here. While the host is off, data stays on disk but no
local communication occurs. Reconnect/replay needs a powered host.

```powershell
node --test scripts\test-vault-agent-network.mjs scripts\test-vault-agent-coding.mjs
```

Checks cover real HTTP loopback/authentication/restart, file/CLI persistence,
message replay/acknowledgment, hash integrity, exact storage/content limits,
queued cloud routes and publishing task results without re-executing agents.

## Retained tool packages and lightweight gossip

Tools developed during tasks can be retained with their usage skills in the
mailbox's independent package catalog. Content remains local in
`Cloud Agents/Network/mailbox.json`, alongside non-shared companion guides at
`Cloud Agents/Network/Packages/<sha256>.md`. Guides reference immutable source
bundles; they do not install code or skills. There are two workflows:

1. The local note AI's `stage_tool` action, or `vault:network --package FILE`,
   retains a complete source/skill package **unvalidated, pending review**.
   Arbitrary imported/generated code is never automatically executed.
2. Run an already approved exact-scope `code.repair` task with `coding-local`.
   The runner develops/repairs the copied source, runs fixed trusted Node tests,
   checks hashes and line limits, and records validation provenance.
   `vault:tasks --publish <agent>` retains the terminal receipt and matching
   changed source as a pending package with `scoped-tests-passed` metadata.
   Frozen test paths/hashes and coding identity must match. This does not
   expand the approved scope or authorize cloud-shell execution. A successful
   no-change task and older receipts are published without new packages.

Example package JSON (source and skill are embedded strings, not executable
commands or paths to arbitrary local files):

The runnable CLI input example is `tools/vault-agent/examples/tool-package.json`.
It contains only public synthetic code and a reviewable skill; no validation
claim is attached.

```json
{
  "version": 1,
  "name": "synthetic-add",
  "description": "Synthetic addition utility; review before reuse.",
  "capabilities": ["code.add"],
  "files": [
    {"path": "add.mjs", "content": "export const add = (a, b) => a + b;\n"},
    {"path": "SKILL.md", "content": "---\nname: synthetic-add\ndescription: \"Use for approved synthetic addition tasks.\"\n---\n# Addition\nReview and test add.mjs before running it.\n"}
  ]
}
```

Optional `task` is the originating task's SHA-256. There is no package input
field for claiming tests passed. Full bundles are normalized and content-hashed,
with safe unique relative paths, 1-8 namespaced capabilities and 1-8 text files.
Serialized UTF-8 package content is capped at exactly 32768 bytes. Files sort
by deterministic code-point order, not platform locale. Larger tasks must be
split/refactored into bounded units; content is never silently truncated.
If automatic package retention exceeds a limit, publication fails explicitly
**after retaining the ordinary task receipt**; no completed coding work reruns.

```powershell
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --package "C:\approved\package.json"
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --gossip 0
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --fetch-package "<package-sha256>"
# After inspecting the package, supply {"id":"<sha256>","reviewer":"human-review"}:
npm run vault:network -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --approve-package "C:\approved\review.json"
```

Gossip is bounded **pull**, not fan-out: at most 16 advertisements and 8192
serialized UTF-8 bytes per poll, containing hash/name/capabilities, revision,
review status, validation label and package byte count. No code, skill body,
description or private task inputs are broadcast. Persist the returned `cursor`
and use it on the next poll; fetch full bundles only as needed. A cursor is
specific to this mailbox, not transferable to another instance. Revisions
advance on retention, first validation and review; the catalog reports latest
state, not a permanent event log of every intermediate review. Re-reading is
safe. The note AI's `package_catalog` polls locally; hosted note providers are
refused private catalog enumeration.

All package responses have `executable: false`, including approved ones.
Review is a local record, not proof of safety or a signed identity.
Verify the returned bundle hash and test compatibility in the intended approved
scope before explicit installation/use. Embedded `SKILL.md` is reviewable data,
not an active customization. Do not treat source or skill instructions as
permission to expand tools, scope or providers.

The existing authenticated loopback server additionally exposes:

- `POST /packages`: retain a version 1 package as publisher `local-http`.
- `GET /packages/<sha256>`: fetch source bundle and review/validation metadata.
- `GET /gossip/<cursor>`: compact metadata advertisements.

No HTTP review endpoint exists. All existing authentication, browser refusal,
loopback, request-byte and whole-mailbox access boundaries apply. Local scripts,
software and agent hosts can use these endpoints or the CLI when available;
they must implement the versioned protocol and possess appropriate authorization.
No background gossip process, network scanner, provider connection or skill
installation was added. Offline storage works while disconnected; access needs
a powered local host. Cloud delivery still requires separately authorized
transport and remains queued.

The catalog caps at 64 packages and shares the mailbox's 128-artifact/8 MiB
limits. Message pruning never removes package-referenced content. Packages have
no automatic eviction or package-prune command; a full catalog blocks additions
without deleting retained information. Plan reviewed export/migration before
capacity exhaustion. Existing mailbox files without catalog fields remain
compatible.

```powershell
node --test scripts\test-vault-agent-packages.mjs scripts\test-vault-agent-network.mjs scripts\test-vault-agent-coding.mjs scripts\test-vault-agent-runtime.mjs
```

## TypeScript and Java task mailbox adapters

`tools/vault-agent/clients/VaultMailbox.mts` and
`tools/vault-agent/clients/VaultMailbox.java` connect Node TypeScript and Java
software to the existing retained mailbox. Both invoke the **same-host Node
CLI** with arguments, not a shell command. They require no server, token, HTTP,
AI inference or internet. A local Node runtime, the CLI source and accessible
vault remain prerequisites. These are software-task reporting adapters, not
new coordinator execution providers.

Construct with absolute Node/entrypoint/vault paths, a stable lowercase sender,
and the return recipient. TypeScript defaults Node to `process.execPath`.
`completeTask(taskSha256, revision, result)` stores a version 1 `task-receipt`
with literal result content, status `completed`, and stable key
`task:<sha256>:<revision>`. `reportTask` also supports `failed` and `blocked`.
Save the result locally first; success confirms retention, not recipient action.
Repeated identical completion is deduplicated, including after acknowledgment;
changed results require a new 1-32-character revision.

`receive()` reads the inbox addressed to the configured **sender**;
`read(id)` fetches retained content and `acknowledge(id, artifact)` confirms
durable processing. The configured recipient is for outbound messages only.
Do not acknowledge until the recipient has saved results and processed IDs.
Reads replay until acknowledgment; side effects are not inherently exactly once.
TypeScript checks fetched content hashes and returns typed responses. Java
returns versioned JSON strings for the application's existing parser; it adds
no external JSON library. The shared store validates message integrity.

Both adapters bound CLI calls to 30 seconds and output to 1 MiB, clean up their
temporary input/output files, and propagate errors without provider fallback.
The mailbox still enforces 65536-byte content and 128 KiB CLI input limits.
Receipt JSON adds overhead; a 64 KiB raw result may be too large. Split work
without truncation. A busy/full/unavailable vault visibly fails; keep the result
and retry the same key. There is no independent client outbox when the vault is
unavailable. Cloud delivery remains unconnected.

Node 24 directly runs the `.mts` source using type stripping.
`tools/vault-agent/examples/complete-task.mts` accepts CLI path, vault, sender,
recipient, task SHA-256, result revision, and saved UTF-8 result file:

```powershell
node tools\vault-agent\examples\complete-task.mts `
  "C:\Users\odaat\Projects\rabbitsoftware-cloudflare\scripts\vault-agent-network.mjs" `
  "C:\Users\odaat\Documents\RabbitOS Vault" `
  "typescript-worker" "vault-orchestrator" `
  "<task-sha256>" "v1" "C:\approved\saved-result.txt"
```

Java requires Java 11+ (verified with 21). Compile into an ignored build folder:

```powershell
New-Item -ItemType Directory -Force .wrangler\java-mailbox | Out-Null
javac --release 11 -Xlint:all -Werror -d .wrangler\java-mailbox tools\vault-agent\clients\VaultMailbox.java
$node = (Get-Command node).Source
java -cp .wrangler\java-mailbox VaultMailbox $node `
  "C:\Users\odaat\Projects\rabbitsoftware-cloudflare\scripts\vault-agent-network.mjs" `
  "C:\Users\odaat\Documents\RabbitOS Vault" `
  "java-worker" "vault-orchestrator" `
  complete "<task-sha256>" "v1" "C:\approved\saved-result.txt"
```

The Java CLI also accepts `receive`, `read <message-id>`, and
`ack <message-id> <artifact-hash>`. Identity labels do not provide isolation
from another local process with filesystem access. Generated result code never
executes automatically. Source bundles support `.mts` and `.java` retention;
compiled `.class`/`.jar` binaries are not tool packages.

`npm run test:vault-mailbox-clients` strictly type-checks TypeScript, compiles
Java with warnings treated as errors, and exchanges actual Unicode completion
receipts across both languages through the mailbox CLI. Java must be on PATH,
or set `VAULT_JAVA_HOME` to an approved JDK directory. Missing Java fails that
explicit validation command; no runtime is silently installed.
`npm run test:vault-agent` also covers TypeScript clients without requiring Java.
TypeScript and Node typings are development-only dependencies.

The vault companion is `Cloud Agents/TypeScript and Java Task Mailbox.md`,
linked from its main service guide. No scheduler or resident process is installed.

## Agent-owned local dispatchers

`scripts/vault-agent-dispatch.mjs` (`npm run vault:dispatch`) lets an agent request
work from a named dispatcher, using the existing task adapters and mailbox.
Each dispatcher owns `Cloud Agents/Dispatchers/<name>/state.json` with a separate
lock, queue, frozen inputs and bounded approval ledger. The original default
coordinator remains independent. Local data never becomes hosted merely because
a dispatcher is named after a provider.

### Request, approve and call

```powershell
$vault = "C:\Users\odaat\Documents\RabbitOS Vault"
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher `
  --sender vault-orchestrator --request tools\vault-agent\examples\dispatch-coding.json
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher --inspect "<request-id>"
# Only after explicit approval of this exact request:
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher --approve "<request-id>"
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher `
  --discover --config .wrangler\vault-coding-config.json
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher `
  --run --config .wrangler\vault-coding-config.json
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher --list
```

The request file is the existing version 1 task definition, not arbitrary
commands or adapter credentials. A mailbox `handoff` envelope retains
`{"version":1,"type":"agent-request","task":<normalized-definition>}`.
Requests use stable `request:<task-sha256>` keys and are addressed to the named
dispatcher; self-dispatch requests are refused. Sender labels remain local
routing metadata, not authenticated principals. Requests themselves grant no
permissions. `--approve` persists a specific request's task into the isolated
queue; it does not execute. Request-selected dependencies must already exist in
that dispatcher queue.

The vault ignores `Cloud Agents/Dispatchers/` in Git publishing because frozen
inputs can contain private content. The local note runtime registers the
dispatcher and language usage guides, but never indexes dispatcher state.
Its existing 16000-byte note limit is unchanged; oversized guides are visibly
excluded rather than silently loaded into a small model context.

One explicitly invoked `--run` passes approved tasks to existing configured
adapters: local Ollama/read/search, compatible hosted models, installed Copilot
(`coding-local`), authorized HTTP agents, Cloudflare jobs, or configured shell
services. It does not provision any of them. Without `--config`, only the local
adapter is selected. Configurations are operator-owned, never supplied by the
request. Sharing, source scope, credential, capability/version and pinned
identity checks remain enforced. The installed coding config still approves
only the public synthetic addition file and fixed tests.

The local runtime's `agent_request` action accepts `dispatcher` and `task`;
it retains the request as `note-agent`, returns `requiresApproval: true`, and
does not expose approval/execution tools. Hosted note providers are refused
local submission. The workspace host or requester uses the mailbox CLI to read
responses (`--receive note-agent` for local note AI requests). Java/TypeScript
clients can submit the same envelope with their existing `send` method, or
invoke the request CLI. No hidden host SDK or unrestricted subagent tool is used.

### Durable return routing

A pass runs at most eight tasks and returns at most eight terminal responses.
Responses are local `task-receipt` messages with `type: "agent-response"`,
dispatcher, original request ID, task ID, terminal status, adapter, output hash,
actual result content or explicit error. The destination is the original request
sender, not a model-supplied redirect. The original request is acknowledged only
after its response is durably retained. Returned results remain pending for the
requester to process and exact-hash acknowledge.

Completion is not rerun after a full mailbox or interruption during return.
Later passes deduplicate the response and complete bookkeeping. Do not prune
acknowledged original requests until the dispatch ledger shows `delivered`;
otherwise an interrupted bookkeeping replay may need operator recovery.
Result envelope overhead counts toward the mailbox's 64 KiB limit. Oversized
returns block visibly without truncation or task reexecution.

Identical normalized tasks requested by multiple senders share one execution
within a dispatcher; each approved requester receives a response. Waiting
tasks retain frozen inputs and use existing retry times. Failed/blocked work
returns explicit feedback; review and submit a new task revision for changed
work rather than erasing ledgers. No dispatcher retry/prune command was added.
Each queue retains the existing coordinator capacities plus a 128-request
approval limit; no automatic eviction exists.

### Evidence review and bounded editor repair

New dispatcher return receipts include `review: {artifact, verdict, executed:
false}`. The private review artifact checks output digests, local coding runner
identity, frozen source hashes, immutable test paths/hashes, changed path/hash
lists and line limits. It does not rerun tests. Verdicts distinguish
`scoped-evidence-consistent`, `unverified`, and `contradicted`; they are not
proof of safety, exhaustive coverage, or factual correctness. Ordinary AI/worker
text remains unverified even when the provider reports task completion.
Unsupported/disputed coding success returns status `review-required` and
unchanged `executionStatus`; the CLI exits nonzero for that new delivery.
No task state is relabeled as failed and no repair/reexecution is triggered.
New coding requests freeze line/round budgets; review compares receipts to them.
Older requests can lack those fields and report `limitsBoundToRequest: false`;
their original configured limit is not independently established by review.

```powershell
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher --review "<task-id>"
# Optional fresh authorized capability diagnostics:
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher `
  --review "<task-id>" --config .wrangler\vault-coding-config.json
```

`--review` persists a content-hashed private artifact on the selected task.
With no config it performs local evidence checks only. With config it can
discover current adapter capabilities (version lookup or authorized endpoint).
It never calls `advance`, changes permissions, retries work or changes provider.
A capability now present suggests an old availability blocker may be stale;
it does not disprove test/source conflicts or permission limits. Claim-language
hints flag possible "passed"/"impossible"/instruction-changing text for contextual
inspection, not proof of deception. This cannot detect all manipulative outputs.
Review metadata is retained by coordinator pruning when its task is retained.

Editor commands require an operator-selected coding config, but do not execute
the CLI or edit files:

```powershell
# Input: {"adapter":"coding","path":"tools/vault-agent/dispatcher.mjs","cursor":0}
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher `
  --editor "<view.json>" --config .wrangler\vault-coding-config.json
# Input: {"adapter":"coding","files":["tools/vault-agent/dispatcher.mjs"],
#         "reason":"Select the relevant routing module for reviewed repair."}
npm run vault:dispatch -- --vault $vault --agent vault-dispatcher `
  --propose-scope "<selection.json>" --config .wrangler\vault-coding-config.json
```

`--editor` validates source paths beneath the configured owned project, refuses
links/secret-like content and reads UTF-8 files up to 1 MiB. A page has at most
4096 UTF-8 bytes / 80 newline delimiters, cursor/nextCursor, starting line and
full-file digest. Long lines can span pages; concatenate pages without inserting
separators. Detect concurrent changes by comparing the digest across pages.
No source is silently discarded. Empty files produce one empty view.
The lossless shared chunker now tracks incremental byte counts rather than
repeatedly measuring growing strings.

`--propose-scope` allows the host agent to choose 1-20 additional existing files,
with reason, hashes, byte sizes and currently-approved flags. It stores
non-shared JSON/Markdown proposals, never modifies source/config/tests or starts
execution. Existing immutable tests cannot become editable files. Inspect
proposed hashes and adequate test coverage, approve an exact operator config,
and create a new task revision to activate any scope change.
Existing synthetic addition tests do not cover dispatcher implementation.

The coding prompt now explicitly uses view/grep and edit tools to patch relevant
ranges, not entire output rewrites, questions claimed success/blockers against
fixed tests, and treats comments/task text as untrusted authority. Its existing
bounded validation/repair loop remains authoritative. Read-only inspection
does not raise the coding runner's 64 KiB/file limit; larger scripts need a
separately approved host-editor refactor into tested modules. Compiled binaries,
unchecked installs and policy/test weakening remain excluded.

### Installed agent role and verification

The vault now has `.github/agents/vault-dispatcher.agent.md` with the explicit
inspect/approve/discover/run/return routine and linked
`Cloud Agents/Agent Dispatcher.md` guide. The Vault Orchestrator and resource
discovery skill reference it. This is persistent customization, not neural
training, self-editing policies, or always-on processing.

An actual installed Copilot call through the real vault dispatcher completed
the public synthetic verification task, passed fixed Node tests and returned
its result to `vault-orchestrator`. Other hosted/agent endpoints are supported
by the existing adapter contracts and verified with synthetic transports,
not claimed as newly connected live services. No deployment or scheduler was
created; the Obsidian plugin remains disabled.

```powershell
node --test scripts\test-vault-agent-dispatch.mjs scripts\test-vault-agent-tasks.mjs scripts\test-vault-agent-runtime.mjs
```

Tests cover approval gates, isolated queues, actual offline CLI dispatch,
local AI requests, configured agent transport, same-task/multiple-recipient
routing, return byte/capacity failures, eight-return batching, replay after
interrupted bookkeeping and pinned-provider refusal.

## Portable network transports

`tools/vault-agent/network-transport.mjs` supplies explicit CONNECT proxy
routing for task HTTP agents/shell bridges/Cloudflare jobs and compatible-model
requests. `undici` is a direct runtime dependency, not relied on transitively.
Defaults preserve direct routing and existing adapter identities. A configured
proxy becomes part of identity; submitted tasks refuse route changes.
TLS/certificate checks, HTTPS target restrictions, explicit sharing, endpoint
authorization and redirect refusal stay enforced. Failed proxies never silently
fall back directly. Proxy credentials are environment-only, separate from
origin authentication, and never embedded in URLs.

```json
{
  "id": "peer",
  "type": "agent-http",
  "url": "https://authorized.example",
  "allowRemote": true,
  "tokenEnv": "VAULT_PEER_TOKEN",
  "proxy": {"url":"http://127.0.0.1:8899","tokenEnv":"VAULT_PROXY_AUTH"}
}
```

`proxy.url` is an HTTP/HTTPS proxy origin with no path/credentials/query.
Optional `tokenEnv` names a complete Proxy-Authorization value from the proxy
administrator. Prefer TLS to a remote proxy; an HTTP CONNECT request exposes
its proxy auth header on that leg. No TLS-disable or downgrade option exists.
HTTP here describes the proxy leg, not a plaintext target.
Hosted compatible model provider configs or model adapter entries accept proxy
selection; conflicting selections fail. Local Ollama/Copilot adapters reject
this field because their own supported runtime network configuration is separate.
No SOCKS/PAC, implicit proxy-environment selection, full-device networking or
legacy standalone sync-CLI proxy feature is implied.

Carrier independence means OS-managed IP: configured Ethernet/Wi-Fi,
Windows mobile broadband, Android/iPhone tethering, Starlink/satellite routers
can provide the route. No modem/SIM/terminal configuration is performed.
Unknown hardware is usable only if its driver/router already provides compatible
IP; non-IP radios, SMS-only links and undocumented device APIs require a real
identified/authorized adapter. This cannot remove carrier subscriptions,
keys, network physics, authentication or DNS/TLS requirements.

```powershell
npm run vault:network -- --diagnose
npm run vault:network -- --diagnose --config "<approved-adapters.json>"
npm run vault:network -- --diagnose --config "<approved-adapters.json>" --resolve-dns
```

Diagnostics require no vault and expose at most 32 interface names/families
(not IP/MAC addresses), 16 configured remote routes, credential presence flags
and optional bounded DNS resolution. They do not scan networks, connect to
terminals, authenticate providers or identify carrier type. DNS probes target
only configured endpoint/proxy hosts, with a 3-second resolver cancellation
deadline per route; IP literals skip DNS. A proxy can resolve the destination
even if local destination DNS is unavailable. Interface/DNS success does not
prove working internet or delivery. Model endpoints stored in provider files are
not loaded/probed by this diagnostic. Environment proxy values are never printed.

### Offline bundle relay

`tools/vault-agent/offline-relay.mjs` exports selected local mailbox messages
already marked `share: true` into a version 1 bundle and imports reviewed bundles
into a destination mailbox. It is independent of HTTP/DNS/proxy during transfer
and can use approved removable media or an authorized file channel.
Private existing receipts are refused; never alter immutable sharing metadata.
Cloud-pending messages are not converted into local deliveries.

```powershell
npm run vault:network -- --vault "<source-vault>" --export-relay "<message-id>,<message-id>" --output "C:\approved\relay.json"
npm run vault:network -- --vault "<destination-vault>" --import-relay "C:\approved\relay.json"
```

Selection caps at 16 messages; serialized UTF-8 bundle caps at 256 KiB including
hash. Input is validated completely before batch persistence, including stable
message/content/bundle hashes, immutable key conflicts and existing capacity.
Imports are atomic with respect to the existing mailbox file; full/invalid
bundles leave retained state unchanged. Export uses new files only (`wx`),
never overwrites output or consumes source messages. Re-import deduplicates,
including locally acknowledged copies.

Imported handoffs/requests remain untrusted and **never execute or approve**
anything. Sender labels/hashes are not authentication/signatures; files are
not encrypted. Use trusted channels/appropriate separately approved encryption
and verify sender identity out-of-band. Source acknowledgment is not propagated
automatically from the destination; importing does not claim source delivery.
Normal recipient processed-ID/exact-hash acknowledgment applies locally.
Dependencies and execution config remain destination-dispatcher scoped.
No resident relay service or automatic private snapshot transfer is installed.

The vault companion is `Cloud Agents/Portable Network Transports.md`,
registered in the local runtime's bounded service-guide scope.

```powershell
node --test scripts\test-vault-agent-transports.mjs
```

Tests include actual authenticated CONNECT/TLS traffic with temporary locally
trusted test certs, target/proxy credential separation, invalid-certificate
and redirect refusal, failed-route no fallback, adapter-route identity pinning,
offline replay/atomicity/byte caps and no-secret diagnostics. The real proxy test
requires `openssl` (Git for Windows bundled path by default or `VAULT_OPENSSL`);
certs remain temporary and system trust is unchanged. Physical satellite/mobile
devices and third-party provider endpoints are not claimed as live-tested.

## General-purpose vault-owned agent

### Automatic reports and exact-call challenges

The local `vault:agent --task` runtime retains private `Cloud Agents/Results/run-<uuid>.json`
reports before provider initialization, including failure paths. Reports contain
provider/model, prompt hash, host/model call origins, argument hashes, observed
call status, source hashes, staged paths and timestamps. Success still saves its
Markdown answer. Error types are retained without raw credential-bearing provider
diagnostics. Synced temporary-file/rename updates preserve complete reports;
interrupted `running` reports are not success. Disk failure is surfaced, not
success-shaped. Review storage growth; no background retention/pruning service
is installed. Dispatcher evidence stays in its existing durable ledgers/receipts.

Operator-owned Ollama/compatible provider configs may specify `requiredCalls`,
up to eight `{name, arguments}` objects. Only exact successful model-selected
calls satisfy them; initial host retrieval is distinguished. Premature answers
are rejected with a corrective turn, and the existing turn budget remains.
This does not authorize self-approval, shell execution, wider coding scope or
production changes. The low-level `runAgent` also accepts `requiredCalls` and
an optional `onCall` recorder; direct callers must choose their persistence sink.
Agent prose remains unverified unless appropriate evidence supports its claims.

### Gateway quota repair and source provenance

Gateway deployment now uses `workers/gateway/src/handler.mjs`, a maintainable
entrypoint exporting the repaired `Limits` Durable Object while reusing the
unchanged compiled request handler and `cleanRequest` from `src/index.js`.
Original pre-bundle source/source maps were not found in the repository or
reachable Git history. The bundle remains preserved rather than blindly edited;
the Qwen sibling's existing `cleanRequest` import remains compatible.

`src/quota.mjs` stores hourly timestamps and the legacy daily count together
under the existing `day` key using a storage transaction. Accepted reservations
are durable before a response, survive instance/runtime recreation and share
the existing daily budget. Expired hourly timestamps are pruned on accepted
reservations; UTC rollover preserves the prior reset behavior. Existing daily
counts survive upgrade. Old in-memory-only hourly timestamps cannot be recovered,
so the first repaired hourly interval starts with newly recorded reservations.
No namespace/schema migration or secret replacement is required.

```powershell
npm run test:gateway
npx wrangler deploy --config workers\gateway\wrangler.toml --dry-run
```

The tests use real local workerd restarts for hourly/daily persistence and
concurrent reservations, check exact rolling-window/UTC boundaries and legacy
daily counts, and preserve health/CORS/error contracts. They also run existing
Qwen request/quota regressions. No live inference request or production quota
write is needed for these tests. Production origins were reconciled with the
active version before deployment; preserve unknown remote vars with `--keep-vars`.

The local runtime in `tools/vault-agent/` is not restricted to the cloud service's
three output modes. It handles arbitrary subject requests through an actual
multi-turn tool loop: resource discovery, keyword search, note reading, staging
proposals, and staging cited learning. It can draft code, research, art prompts,
service designs, or other text proposals, but cannot execute arbitrary code,
render images, run shell commands, provision infrastructure, or edit originals.
Capabilities must be supplied by actual tools; the agent never claims unlimited
expertise or access.

Each task first runs resource discovery and a local search, then reads up to two
explicitly referenced or top-matching notes before invoking the model. These
verified tool outputs bootstrap the model rather than relying on it to choose
retrieval correctly. It can request further reads through the tool loop.

Without a config the runtime uses the already-installed local Ollama
`qwen2.5:3b`, which works offline but takes minutes per task on this 8 GB,
CPU-only machine. It runs with an 8192-token context and a 1500-output-token
cap. Structured JSON schemas constrain model actions; input, output, context, and
turn limits fail explicitly instead of silently switching providers. A reply that
is cut off or is not valid JSON is re-requested (shorter) up to two times before
the run fails. Initial evidence marks its two-snippet limit and summarized
resource inventory; more detailed discovery and reads remain available through
tools. The Obsidian plugin now uses the hosted model instead (next section).

### Hosted model and corpus search

The plugin's `local-provider.json` selects `openai-compatible` hosted Qwen through
the vault agent Worker (`POST /v1/chat/completions`), which answers in seconds.
The bearer token is read from `tokenFile` (`rabbit-web\.env.cloud-supabase`,
`VAULT_AGENT_TOKEN`), outside the vault, because the vault and this config file
are published to GitHub. `local-provider.ollama.json` keeps the offline config;
copy it over `local-provider.json` for the cloud-access status command, which
only runs with the local model.

Hosted runs can read only notes with `cloud-agent-share: true`. Everything else
comes from the vector corpus: the Worker embeds text with
`@cf/baai/bge-base-en-v1.5` into Vectorize index `rabbitsoftware-corpus` (768
dimensions, cosine, `source` metadata index). Every task starts with one
`corpus_search` of the prompt and the model can search again; retrieved passages
are listed under "Corpus passages retrieved" in the result note.

Worker routes (all behind `VAULT_AGENT_TOKEN`, each with its own UTC daily cap in
`VaultBudget`): `/v1/chat/completions` (1000 calls), `/v1/corpus/search` (3000),
`/v1/corpus/upsert` (2000 requests of up to 25 chunks), `/v1/corpus/delete`.

```powershell
node scripts\vault-corpus-index.mjs --plan     # counts only, no network
node scripts\vault-corpus-index.mjs --apply    # upload changed chunks, delete removed ones
node scripts\vault-corpus-index.mjs --apply --repos ""   # without repository docs
```

The indexer reads public vault notes from the vault's published `origin/main`
(skipping agent results, proposals, coordinator state and notes marked
`cloud-agent-share: false`), the website's public research corpus, and tracked
Markdown in the `rabbit-web`, `rabbitsoftware-cloudflare` and `research-agents`
repositories. Those repositories are private: their docs now live in Vectorize,
and agent answers can quote them. Result notes are published by Git Sync unless
`Cloud Agents/Results/**` and `Cloud Agents/Proposals/**` are in its exclude
patterns. Chunks matching credential patterns are skipped. Run `--apply` again
after documentation changes; unchanged chunks are not re-sent.

`npm run vault:live` (`scripts/vault-live.mjs`) re-indexes the corpus and pulls
finished cloud job results, logging to `.wrangler/vault-live.log`. It never
uploads notes and never runs task queues or dispatchers, which stay operator
decisions. The vault's `.gitignore` keeps new `Cloud Agents/Results/` and
`Cloud Agents/Proposals/` out of the 30-minute `Tools/sync-vault.ps1` push; the
Git Sync plugin needs the same folders in its own exclude patterns. To run it
every 15 minutes:

```powershell
$repo = "C:\Users\odaat\Projects\rabbitsoftware-cloudflare"
Register-ScheduledTask -TaskName "RabbitOS Vault agents" `
  -Action (New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "`"$repo\scripts\vault-live.mjs`"" -WorkingDirectory $repo) `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15)) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -Hidden)
# Remove: Unregister-ScheduledTask -TaskName "RabbitOS Vault agents" -Confirm:$false
```

```powershell
npm run vault:agent -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --search "agents workers"
npm run vault:agent -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --read "Agents/Agents.md"
npm run vault:agent -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --task "Research the selected notes and propose a cited implementation."
```

Local knowledge roots are `Agents`, `Workers`, `Platform`, `Pathways`, `Tools`,
`Cloud Agents/Knowledge`, and `Cloud Agents/Learned`. Other folders and linked
filesystem trees are not automatically traversed. The two root-level Cloud
Agents service guides are also explicitly readable/searchable; results,
unreviewed proposals and credential files are not. Searches report excluded
oversized notes and empty/missing roots, and refuse scopes over 2000 notes.
Hosted-provider search/read excludes notes without `cloud-agent-share: true`.
Private code and personal data never belong in hosted model context.

Outputs go to `Cloud Agents/Results/local-<id>.md`. Proposed work goes to
`Cloud Agents/Proposals/<id>-<index>.json`, with a companion Markdown note
visible in Obsidian. Originals are not modified.
Promote reviewed learning explicitly:

```powershell
npm run vault:agent -- --vault "C:\Users\odaat\Documents\RabbitOS Vault" --approve-learning "Cloud Agents/Proposals/<id>-<index>.json"
```

Promotion verifies all cited source hashes and saves a non-shared note under
`Cloud Agents/Learned`. This is retrieval memory, not model retraining or proof
that generated claims are true. Code and other proposals require ordinary
reviewed editing/testing with the workspace host's tools.

### Obsidian and workspace integration

```powershell
npm run vault:agent:install -- --vault "C:\Users\odaat\Documents\RabbitOS Vault"
```

The installer copies only the owned plugin entrypoint and manifest to
`.obsidian/plugins/rabbit-vault-agent`. It never changes existing plugin settings
or credential files. Enable **Rabbit Vault Agent** in Obsidian Community plugins.
Its task modal offers local Ollama or an explicitly configured provider; its
cloud-result command downloads previously submitted jobs. It invokes fixed owned
Node entrypoints without a shell, passes task text over stdin, and opens saved
results. Node must be available on Obsidian's PATH. Closing/disabling the plugin
stops its local child processes; local work does not run on an unpowered machine.

Cloud credentials are stored only in the vault's Git-ignored plugin `data.json`,
under `provider`: `type`, `url`, `token`, `allowRemote`. The activated setup uses
`type: "cloudflare-jobs"` and an approved random token. Never print or copy that
file into notes or tracked source. Explicitly selecting that provider submits
only opted-in knowledge to durable cloud jobs; empty scopes fail without upload.
The modal does not silently switch when local inference fails.

For another hosted model, use an ignored local JSON config with
`type: "openai-compatible"`, `model`, a full HTTPS chat-completions `url`,
`token`, and `allowRemote: true`; supply `--config` to the CLI. Only providers
supporting the request's JSON output and chat parameters are compatible; errors
are explicit. Google Cloud requires an authorized project, a supported model and
Google Cloud OAuth credentials, not an arbitrary API key. Consult its current
[OpenAI-compatible endpoint documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/start/openai).
This adapter has been contract-tested but no Google Cloud service is provisioned
or live-tested. Expired tokens must be refreshed explicitly.

Open the existing `RabbitOS.code-workspace` to make the vault's
`.github/agents/vault-orchestrator.agent.md` and
`.github/skills/vault-resource-discovery/SKILL.md` discoverable. The orchestrator
coordinates provider-aware research/building using the host's actual MCP, web,
terminal, edit, and installed skill capabilities. Use it for reviewed implementation
and provider-specific infrastructure, rather than giving a local note tool
unrestricted shell access. New host tools, providers and domain skills must be
installed/authorized and verified; their names alone do not make them available.

### Access and optional cloud shells

The user requested that the native plugin remain installed without enabling it
or reloading Obsidian. Existing vault/MCP access is unchanged. The new cloud
Worker can access only its private R2 snapshots/results through its bindings;
other Workers do not automatically gain local filesystem or bucket access.
Authorized clients can connect through the token-protected API. There is no
anonymous endpoint exposing vault files and no local MCP tunnel.

No additional cloud shell was required or provisioned. If a concrete task needs
one, choose the authorized provider and scoped runtime explicitly, install the
headless CLI/MCP agent connection there, and share only approved non-private
resources. The desktop Obsidian plugin cannot run in a headless cloud shell.
Google Cloud project authorization and shell provisioning remain separate from
the existing Cloudflare service.

### Importing owned GitHub repositories

`scripts/import-github-vault.py` downloads every repository owned by the currently
authenticated `gh` user, including private, forked, and archived repositories.
It requires Python 3.11+ and `gh auth login`. Each default branch is pinned to a
commit and downloaded directly into the vault's `GitHub Imports\<owner>\<repo>`
folder. No downloaded code is executed, and existing local working copies are
untouched.

Before importing, add `/GitHub Imports/` to the vault's `.gitignore`. The script
refuses imports if this folder is not ignored or contains Git-tracked files.
Private snapshots, the generated index, and the hash manifest stay local.

```powershell
python scripts\import-github-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault"
python scripts\import-github-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault" --verify-only
python scripts\test-import-github-vault.py
```

Open `GitHub Imports/00 GitHub imports.md` in Obsidian for the repository index.
The importer records empty repositories and verifies every extracted file's
SHA-256 hash. Re-running verifies completed snapshots and resumes missing
repositories without overwriting edits or refreshing to newer commits.

Snapshots exclude Git history, other branches, release assets, and submodule
contents. LFS files may remain pointers; archive symlinks are stored as text
targets rather than active filesystem links. The manifest records both counts.
Windows-incompatible filenames fail explicitly by default. Pass
`--sanitize-windows-names` to replace invalid characters with underscores and
disambiguate colliding names; `renamed_paths` in the manifest maps each original
file path to its local path. This was used for the `RABBIT-SOFTWARE` import.
Code and binary files remain on disk even if Obsidian hides unsupported file
types; Copilot can access them through the vault tools with your approval.
Obsidian's directory listing also hides empty and dotfile-only repositories;
the generated index and manifest still include them. If a batch import leaves
the file tree stale, close and reopen the vault to refresh its cache.

### Full histories and live two-way access

`scripts/sync-github-vault.py` manages the Git-ignored `GitHub Live` library:

- `History\<owner>\<repo>`: non-shallow, download-only Git mirrors, including
  branches and tags. Mirrors are addressed with explicit `--git-dir` to honor
  Git's `safe.bareRepository=explicit` policy. Auto-GC is disabled; the tool does
  not force-push, prune, or delete local history.
- `Repositories\<owner>\<repo>`: full Git working copies on the default branch,
  with LFS downloads and recursively initialized submodules.
- `Release assets`: published assets downloaded with IDs, original names, sizes,
  and SHA-256 hashes recorded in `release-assets.json`. Local asset edits stop
  downloads rather than replacing files or uploading them to GitHub.
- `policy.json`, `status.json`, and `sync.log`: local publishing policy and
  explicit operation results. Private and archived repositories never auto-push.

```powershell
python scripts\sync-github-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault" --setup
python scripts\sync-github-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault"
python scripts\sync-github-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault" --verify-only
python scripts\sync-github-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault" --setup --repository rabbitsoftware-io/brainflow
python -m unittest scripts\test-import-github-vault.py scripts\test-sync-github-vault.py
```

`--setup` never commits or pushes. Without it, eligible public, non-archived repos
automatically commit and push edits on their default branch, using the existing
Git identity and the Copilot co-author trailer. Private commits/pushes require a
separate approved Git operation in that working copy. Other branches are fetched
into history/remote refs, not automatically checked out or published.

Fast-forward-only incoming updates preserve local edits. Staged changes,
conflicts, divergent histories, linked files, obvious credential paths/content,
and large non-LFS additions stop automatic publishing and are logged. These
guards are not a complete secret scanner: never put personal files or secrets
in an automatically published public repository. The tool never stashes,
rebases, force-pushes, or runs repository hooks.

Windows-incompatible paths retain their full Git mirrors and the mapped snapshot
under `GitHub Imports`; native checkout and automatic publishing are disabled.
Missing/disabled LFS objects are reported as partial imports. For a public fork
whose GitHub LFS endpoint is explicitly disabled, the tool attempts its verified
public parent as a download-only LFS source, without changing `origin`.
Cloud-unavailable LFS objects and deleted GitHub history cannot be recreated.

Install the user-level **RabbitOS GitHub Vault Sync** Windows task:

```powershell
pwsh -File scripts\install-vault-sync-task.ps1 -Vault "C:\Users\odaat\Documents\RabbitOS Vault"
Get-ScheduledTask -TaskName "RabbitOS GitHub Vault Sync"
Get-ScheduledTaskInfo -TaskName "RabbitOS GitHub Vault Sync"
Disable-ScheduledTask -TaskName "RabbitOS GitHub Vault Sync"
```

The task triggers every five minutes and at sign-in, runs at normal user
privilege, and remains independent of VS Code. It runs only while that user is
logged in. A Windows file lock and scheduler policy prevent overlapping runs;
large downloads can take longer than the trigger interval. Failures are recorded
in `GitHub Live\sync.log` and a nonzero task exit status.

### Personal files and recordings

`Computer\Downloads` and `Computer\OneDrive` are live junctions to the approved
source roots. `Computer\Documents media` links the Documents music/video aliases
to their real source folders. Documents contains the vault itself, which is
excluded to prevent a recursive link. The old Pictures alias has a missing
target; existing pictures are accessible through the OneDrive link instead.

These links provide immediate two-way local edits without duplicate copies.
Source deletions are real deletions; this is not a backup. Existing snapshots
and older library links are unchanged. `Computer` is Git-ignored, so personal
recordings are not automatically committed or pushed to GitHub.

OneDrive handles its own cloud sync and must be running and signed in.
Files On-Demand remain placeholders until accessed; this setup does not promise
offline availability or unlock OneDrive Personal Vault. Other cloud accounts
and recording locations are outside the approved source roots.

`scripts/index-vault-library.py --vault <vault> --source <folder>` accepts repeated
source arguments and records metadata only in `Computer\Library inventory.json`.
It excludes the vault itself, stops cycles, and reports inaccessible/out-of-scope
links. It does not read, transcribe, upload, or modify recording contents.
Directory aliases are scanned through their resolved approved targets and indexed
once, avoiding legacy Documents-junction access restrictions. Indexed paths use
that canonical directory. File links are also checked: targets outside approved
roots are reported and targets inside the vault are excluded.

### RabbitOS command files and VS Code Run button

`scripts\rabbitos-commands.ps1` is the shared PowerShell 7 launcher for the
Cloudflare repository (`cloudflare`), the separate web console (`console`), and
the isolated Python repair checkout (`core`). `.vscode\tasks.json` exposes setup,
validation, development and **show commands only** tasks in the Agents Run
button and VS Code's **Tasks: Run Task** command. Nothing runs on workspace
creation. Setup installs pinned npm dependencies only when explicitly selected.

Run from this repository; commands resolve their working directory themselves:

```powershell
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action Setup
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area console -Action Setup
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area core -Action Setup
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action Validate
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area console -Action Validate
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area core -Action Validate
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action Dev
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action Dev -Target sync
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action Dev -Target node-worker
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action Dev -Target gateway
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area console -Action Dev
```

Add `-Preview` to print local setup/validation/development commands without
executing them. `-Repository <path>` selects a different checkout. Defaults are
this repository, `%USERPROFILE%\Projects\rabbit-web`, and
`<vault>\GitHub Live\Repairs\RABBIT-SOFTWARE-pylint`. `-Vault <path>` overrides
the vault location. Paths containing spaces or quotes are quoted safely.
Native command failures stop the sequence and produce a nonzero exit status.
Validation suppresses generated Python bytecode caches.

Worker development uses the `-dev` configuration with `--local`, not production
bindings. Start sync and node-worker in separate terminals, sync first.
Local mode does not disable outbound HTTP calls (for example the gateway's
inference endpoint). Console development uses the existing vinext command and
may reach configured Supabase resources; do not test remote writes without
approval. Local secrets must be supplied separately in ignored files; the
launcher does not generate, read, display or copy their values.

The following actions **only print commands**, even without `-Preview`:

```powershell
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action PublishCommands
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area console -Action PublishCommands
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area core -Action PublishCommands
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action DeployCommands
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action DeployCommands -Target sync
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area console -Action DeployCommands
pwsh -NoProfile -File scripts\rabbitos-commands.ps1 -Area cloudflare -Action VaultCommands
```

Publication templates stage only the listed repair files, preserve unrelated
changes, include the co-author trailer, and use `main` as the observed Git
default branch. Review staged changes, check for an existing PR and choose a
stacking/base strategy for the core follow-up to RABBIT-SOFTWARE PR #18.
These templates are not publication approval. The Pages production branch is
still `master`, independently of the Git default branch.

Deployment templates preserve the existing Pages/Wrangler and console
vinext/Cloudflare workflows. Both Pages preview and production are remote
writes. Review current dashboard bindings/secrets before Worker deployment;
recover original sources for generated bundles first. No deployment command is
executed by the launcher.

Known missing areas are explicit rather than guessed:

- The focused core tests need only Python; the workflow tests need Bash.
  Full application dependency setup and a safe runnable entrypoint remain
  unverified. Core `Dev` fails explicitly rather than starting unknown code.
- The two reclassified shell documents do not supply the missing
  `dna_quantum_crypto.py` and `neural_memory_to_image.py` implementations.
- Full application Pylint/GitHub matrix validation, historical BrainFlow LFS
  recovery, and Windows-invalid upstream paths remain separate work.
- The vault guide `GitHub Live\Coordinator\RabbitOS commands.md` links directly
  to the local command source, not an older imported snapshot. Existing live
  sync is inspected, not reinstalled or silently given new publishing scope.

Test the command launcher without installs, application startup or remote writes:

```powershell
python -B -m unittest scripts\test-rabbitos-commands.py
```

### Local repository connecting agent

`scripts/audit-vault-repos.py` builds a read-only coordination map inside the
Git-ignored `GitHub Live\Coordinator` folder. It uses existing full-history
mirrors, the sync-status snapshot, GitHub repository metadata, open issues/PRs,
and the latest observed Actions run for repositories with tracked workflows.
It does not edit source repositories, create branches/issues, publish metadata,
deploy Workers, or send note contents to a model.

```powershell
python scripts\audit-vault-repos.py --vault "C:\Users\odaat\Documents\RabbitOS Vault"
python -m unittest scripts\test-audit-vault-repos.py
```

Open `GitHub Live\Coordinator\00 Repository coordinator.md` for descriptions,
per-repo branch inventories, existing issue/PR links, explicit README cross-repo
connections, and tracked Wrangler configs. `Backlog.md` distinguishes reported
sync/CI blockers from documentation or CI review candidates. An absent README,
description, or workflow is not proof of broken code; application code and
non-default-branch file contents are not audited by this inventory.

Descriptions use existing GitHub metadata, then a tracked README heading.
Unknown purpose remains explicitly unconfirmed, especially for empty repos.
Descriptions stay local until reviewed and approved for GitHub publication.
Retrieval failures are recorded in repository notes and produce a nonzero exit.

Sync updates preserve the last known result of repositories not yet processed
in the current cycle and record per-repository observation times. A completed
cycle also writes `last-completed-status.json`. The coordinator falls back to
that snapshot and verified local history when current-cycle status is absent;
it never equates a partial status list with missing repository files.

Generated notes are replaced on rerun. Keep approved scope, manual descriptions,
task ownership, branch/PR links and verified test outcomes in the preserved
`Decisions.md` note. A repair starts with a confirmed gap and dedicated branch,
not an edit to an automatically pushed public default-branch working copy.
No new Worker is needed to connect this local backlog. Future cloud coordination
needs a separately approved bridge and access policy; never tunnel the vault's
localhost API or upload private notes/recordings by default.

### External task references

- [Perplexity Computer task thread](https://www.perplexity.ai/computer/tasks/b932bee4-75e2-41ef-b8dd-4434e1a9a206?view=thread):
  user-provided reference for RabbitOS coordination, also recorded in the vault's
  preserved `GitHub Live\Coordinator\Decisions.md` note.

The thread's contents, ownership, status and repository relationships have not
been verified. This is a navigation link, not an API integration or live sync;
adding it does not authorize uploading repository contents, private notes or
recordings to Perplexity. Access may require the user's signed-in account.

### RF Nexus static export preview

`tools\rf-nexus-preview` hosts only the three reviewed HTML/JS/CSS files from
the user-provided RF Nexus export, in a separate Worker named
`rabbitsoftware-rf-nexus-preview`. It is not the RabbitOS console or a working
RF Nexus backend. A visible warning explains unavailable features; API,
WebSocket and write requests fail explicitly. CSP blocks outbound connections,
the embedded Perplexity editor is removed from served HTML, and non-exported
paths return 404. Reports, spreadsheets, archives and vault contents are never
served. The preview is public but marked noindex.

Public preview:
https://rabbitsoftware-rf-nexus-preview.rabbitsoftware-gateway.workers.dev

The original export is preserved in the vault. Staged copies of only
`index.html`, `assets\index-drmRIFDg.js` and `assets\index--vzZ5AZu.css` go under
the Git-ignored `tools\rf-nexus-preview\public` directory. Do not copy the vault
folder wholesale. Full source/server recovery is needed for actual integration;
do not patch the generated bundle to fabricate a working backend.

```powershell
node --test tools\rf-nexus-preview\test.mjs
npx --no-install wrangler deploy --config tools\rf-nexus-preview\wrangler.jsonc --dry-run
# Only after explicit approval to publish the static preview:
npx --no-install wrangler deploy --config tools\rf-nexus-preview\wrangler.jsonc
```

## Supabase

Project ref `ludxbakxpmdqhfgdenwp`. `supabase/` holds the CLI config and (future) migrations.

- `npm run supabase:link | supabase:start | supabase:stop | supabase:diff | supabase:types` wrap `npx supabase`. `supabase:start` needs Docker.
- Auth supplements the existing signed-device accounts; it does not replace them. `sync` exposes `GET /v1/supabase/health` and `GET /v1/supabase/me` (verifies a Supabase `Authorization: Bearer` access token against the project's JWKS and returns the user).
- `SUPABASE_URL` is a plain var in both `wrangler.toml` files. `SUPABASE_JWT_SECRET` is an optional secret, only needed for legacy HS256 projects.
- Not deployed yet. These sync changes are in the esbuild bundle, so they go live only on an explicit `cd workers/sync && npx wrangler deploy`.
