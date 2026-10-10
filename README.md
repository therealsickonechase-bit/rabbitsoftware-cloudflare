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

## Storage and other resources

| Resource | Name / ID | Used by |
|---|---|---|
| D1 | `rabbitsoftware-sync` (`6abca1c1-784c-4151-bd37-95f9fe30cc52`) | sync (`DB`) |
| KV | `DNA_BLOCKCHAIN` (`1780c2bce503474b908e43a5d321fbdb`) | sync |
| R2 | `rabbitsoftware-sync` | sync (`SYNC`) |
| R2 | `rabbitsoftware-project-events` | written by the `rabbitsoftware_project_events` pipeline |
| Pipeline | `rabbitsoftware_project_events` | sync (`PROJECT_EVENTS`) |
| Durable Object | `Quota` (sync), `Limits` (gateway) | per-account quotas / per-client rate limits |
| Workflow | `workflow-rabbitsoftware-node-worker` (`MyWorkflow`) | node-worker |

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
