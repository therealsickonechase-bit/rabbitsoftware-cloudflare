# rabbitsoftware-cloudflare

Source and deploy configuration for the Rabbitsoftware platform on Cloudflare
(account `Ringquistchase@gmail.com's Account`, zone `rabbitsoftware.io`).
Captured from the live account on 2026-10-08.

## What runs where

| Hostname | Component | Purpose |
|---|---|---|
| rabbitsoftware.io, www | Pages project `rabbitsoftware-site` (`site/`) | Public website: project pages, a RabbitOS section linking to the console, and a live status page (`/status`) |
| app.rabbitsoftware.io | Worker from the separate `rabbit-web` repo (vinext on Cloudflare) | The RabbitOS console (Supabase for accounts and data). Deployed from `rabbit-web`, not from here |
| api.rabbitsoftware.io | Worker `rabbitsoftware-sync` (`workers/sync`) | Main API: accounts, device sync, history, research/Maxwell snapshots, corpus, quotas |
| agent.rabbitsoftware.io | Worker `rabbitsoftware-node-worker` (`workers/node-worker`) | Archive-verification agent, runs jobs through a Workflow and calls `rabbitsoftware-sync`'s `ArchiveAgent` |
| rabbitsoftware-gateway.workers.dev | Worker `rabbitsoftware-gateway` (`workers/gateway`) | Rate-limited AI chat gateway to a Hugging Face inference endpoint |
| rabbitsoftware-qwen.rabbitsoftware-gateway.workers.dev | Worker `rabbitsoftware-qwen` (`workers/qwen`) | Hosted Qwen3 via Workers AI; shared durable daily/hourly attempt caps for website and RabbitOS chats |
| rabbitsoftware-vault-agent.rabbitsoftware-gateway.workers.dev | Worker `rabbitsoftware-vault-agent` (`workers/vault-agent`) | Authenticated, isolated durable jobs over explicitly shared vault-note snapshots |

`workers/vault-agent/` is a separate Obsidian integration, activated on
2026-10-12 with approval. Its
isolated R2 bucket holds immutable, explicitly opted-in note snapshots; a
Workflow performs note-based tasks, Q&A, or summarizing/organization through
Workers AI. A local connector downloads results and applies separately approved
edit proposals without overwriting changed originals. It does not expose the
local Obsidian API or alter the existing Workers. See
[the vault-agent workflow](DEVELOPMENT.md#obsidian-cloud-agents) for activation,
privacy limits, and local tests.

The owner [cloud command shell](workers/cloudshell/README.md) is implemented
locally as a separate Sandbox Worker, **not deployed**. The RabbitOS console
bridge is also local-only until explicit rollout approval. Three selectable
identity modes and operator-allowlisted person/agent access use persistent
agent-side one-hour scoped approvals; default configuration remains locked.
Unset identity/credential policy and missing Docker remain activation blockers; no private notes,
credentials, or paid resources were provisioned by this work. In Obsidian,
`Pathways/Agent Worker Frontend Backend Network.md` links the evidence,
frontend/backend/network routes, business responsibilities and repair queue.

The provider-independent local counterpart is `tools/vault-agent/`:
`npm run vault:agent` uses Ollama for a general-purpose search/read/tool loop,
stages build/code/research proposals and cited learning, and never switches
providers silently. The Rabbit Vault Agent Obsidian plugin supplies native
commands; the vault's Vault Orchestrator workspace profile uses VS Code's actual
MCP, code, terminal, web, and skill tools for broader reviewed implementation.
An explicitly configured OpenAI-compatible model endpoint can use other hosted
providers, including Google Cloud's compatible endpoint with Google Cloud auth;
this does not provision Google Cloud infrastructure.

`npm run vault:tasks` adds a persistent, provider-neutral dependency queue with
frozen inputs, content-addressed output links, bounded local storage, explicit
offline retry status, and capability/version discovery. Adapters cover local
notes/Ollama, explicitly selected compatible hosted models, the existing Cloudflare Worker, and authorized agent/cloud-shell
HTTPS services. No cloud shell, peer broadcast, scheduler, or infrastructure is
automatically created. See [portable task coordination](DEVELOPMENT.md#portable-vault-task-coordination).

The optional `coding-local` adapter runs the installed Copilot CLI against an
explicit copied source scope, with bounded repair rounds, fixed Node validation,
line-budget checks, backups and conflict-checked application. A real synthetic
repair through the vault queue was verified. Execution is local; Copilot
inference is hosted and requires approval. Cloud-shell execution remains
unconnected, not silently substituted.

`npm run vault:network` supplies retained code/handoff messages, explicit
hash acknowledgments and offline replay. Agents outside the vault can use the
CLI or an optionally started authenticated loopback HTTP mailbox. Task receipts
can be copied into it with `vault:tasks --publish <agent>`. Cloud routes remain
queued; this is not an always-on hosted network. See
[retained agent communication](DEVELOPMENT.md#retained-agent-communication).

Agents can also retain newly developed source and usage skills as immutable,
reviewable packages in a separate mailbox catalog with vault companion notes.
Local AI can stage packages; approved coding tasks run fixed tests and publish
scoped validation provenance. Cursor-based gossip advertises metadata only
(up to 16 entries / 8 KiB per poll); peers fetch code on demand. Review never
installs a skill or grants execution access. This works locally offline, not
as an always-on cloud mesh. See [tool packages and gossip](DEVELOPMENT.md#retained-tool-packages-and-lightweight-gossip).

Dependency-light [TypeScript](tools/vault-agent/clients/VaultMailbox.mts) and
[Java](tools/vault-agent/clients/VaultMailbox.java) adapters route terminal task
results through the same durable local mailbox CLI, including offline replay
and exact-hash acknowledgments. See [language adapters](DEVELOPMENT.md#typescript-and-java-task-mailbox-adapters).

`npm run vault:dispatch` adds agent-owned named dispatchers: retain a request,
approve its exact ID, call configured Copilot/AI/agent adapters, and automatically
return the terminal result to its original sender. Each dispatcher has an
isolated persistent queue. The vault's installed Vault Dispatcher role supplies
the repeatable routine; local AI can stage requests but cannot approve them.
A real installed Copilot call and return delivery were verified in the existing
synthetic scope. No cloud deployment or resident daemon was added. See
[per-agent dispatch](DEVELOPMENT.md#agent-owned-local-dispatchers).

Dispatcher returns now include evidence review rather than trusting AI/worker
success prose. `--review` diagnoses unsupported claims and possibly stale
capability blockers without execution or bypass. `--editor` reads large source
in bounded pages; `--propose-scope` records agent-selected extra files and hashes
for approval. Copilot uses targeted edit tools within the existing fixed-test
repair scope; additional files are never activated by their own proposals.

Agent verification runs now retain private success/failure reports with
host/model tool-call origins. Host-required exact calls prevent premature
answers from being accepted as completed tool work. See
[automatic reports](DEVELOPMENT.md#automatic-reports-and-exact-call-challenges).
The gateway's maintainable entrypoint repairs hourly quota persistence without
editing its legacy compiled handler; run `npm run test:gateway` and see
[gateway quota repair](DEVELOPMENT.md#gateway-quota-repair-and-source-provenance).

Agent/task/model HTTPS connections now support explicit HTTP/HTTPS CONNECT
proxies with normal TLS/authentication and pinned routes. The OS supplies the
access link (including configured cellular/tethered/satellite IP connectivity).
`vault:network --diagnose` reports bounded interface/route metadata; explicitly
shared local messages can travel as reviewed offline relay files. No undocumented
modem/terminal control, carrier provisioning or universal network access is
claimed. See [portable transports](DEVELOPMENT.md#portable-network-transports).

## Storage and other resources

| Resource | Name / ID | Used by |
|---|---|---|
| D1 | `rabbitsoftware-sync` (`6abca1c1-784c-4151-bd37-95f9fe30cc52`) | sync (`DB`) |
| KV | `DNA_BLOCKCHAIN` (`1780c2bce503474b908e43a5d321fbdb`) | sync |
| R2 | `rabbitsoftware-sync` | sync (`SYNC`) |
| R2 | `rabbitsoftware-project-events` | written by the `rabbitsoftware_project_events` pipeline |
| R2 | `rabbitsoftware-vault-agent` (private) | vault-agent (`VAULT`), opted-in immutable snapshots/results |
| Pipeline | `rabbitsoftware_project_events` | sync (`PROJECT_EVENTS`) |
| Durable Object | `Quota` (sync), `Limits` (gateway) | per-account quotas / per-client rate limits |
| Workflow | `workflow-rabbitsoftware-node-worker` (`MyWorkflow`) | node-worker |
| Workflow | `rabbitsoftware-vault-jobs` (`VaultJob`) | vault-agent |
| Durable Object | `VaultBudget` | vault-agent's fixed shared 20-attempt UTC daily inference cap |

## The website (`site/`)

Static files, no build step. It links to RabbitOS (section `#rabbitos`, with `assets/brain-network.svg`) and has `status.html`, which checks the website, the RabbitOS
console and its database from the browser. `npm run probe` runs the same checks from the command line (`scripts/probe.mjs`, with the vendored `tools/gprobe`).
`SITE-DEPLOYMENT-NOTES.txt` is the October 8 recovery record, kept as history.

## About the code

- `workers/node-worker/src/` is the original source, recovered from the source
  map Cloudflare stores alongside the deployed bundle.
- `workers/gateway/src/index.js` and `workers/sync/src/agent-entry.js` are the
  deployed bundles (esbuild output). Their original sources were not found;
  they are byte-identical to what is live and deploy as-is.

## Secrets

Never committed. Set them per Worker with `npx wrangler secret put <NAME>`:

- gateway: `HF_TOKEN`
- sync: `ADMIN_ACCOUNT`, `SIGNUP_KEY`

## Deploying

Workers are deployed one at a time (below). The website is a Pages project: `npm run preview:site` publishes to the `preview` branch for review, and production is
`npx wrangler pages deploy site --project-name rabbitsoftware-site --branch master` (`master` is the production branch). The RabbitOS
console is deployed from the `rabbit-web` repo with `npm run deploy:vinext`.

```bash
cd workers/<gateway|node-worker|sync>
npx wrangler deploy
```

Deploy `sync` before `node-worker`, since node-worker binds to sync's
`ArchiveAgent` entrypoint.
