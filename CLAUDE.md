# CLAUDE.md

Source and deploy config for the Rabbitsoftware platform on Cloudflare (zone `rabbitsoftware.io`). See [README.md](README.md) for the full map of hostnames, bindings and resource IDs, and [DEVELOPMENT.md](DEVELOPMENT.md) for the local workflow.

## Layout

- `site/` — static Pages site (`rabbitsoftware-site`), no build step.
- `workers/sync/` — main API (`api.rabbitsoftware.io`): accounts, device sync, corpus. Uses D1, KV, R2, Durable Objects. D1 schema in `workers/sync/schema.sql`.
- `workers/node-worker/` — archive-verification agent (`agent.rabbitsoftware.io`), runs a Workflow and calls sync's `ArchiveAgent`.
- `workers/gateway/` — rate-limited AI chat gateway to a Hugging Face endpoint.
- `scripts/dev-smoke.mjs` — dev-only signed smoke test.
- `scripts/probe.mjs` (`npm run probe`) and `site/status.html` — health checks of the website, RabbitOS console and Workers; `tools/gprobe` is vendored.
- The RabbitOS console lives in the separate `rabbit-web` repo (`app.rabbitsoftware.io`); the site only links to it (`#rabbitos` section in `site/index.html`).
- Each Worker has `wrangler.toml` (production) and `wrangler.dev.toml` (`-dev` resources).

## Commands

- `npm run dev:site | dev:sync | dev:node-worker | dev:gateway` — local only (`--local`, simulated bindings).
- `npm run preview:site` — deploys `site/` to the Pages `preview` branch; production is untouched.
- Deploy the site to production: `npx wrangler pages deploy site --project-name rabbitsoftware-site --branch master` (only when asked). Deploy a Worker: `cd workers/<name> && npx wrangler deploy`. Deploy `sync` before `node-worker`.

## Rules

- Production is live. Do not run deploys, remote D1 writes, or R2/KV writes unless asked explicitly.
- Do not redeploy Worker bundles blindly; keep existing bindings and secrets. `gateway/src/index.js` and `sync/src/agent-entry.js` are esbuild output with no original source.
- Secrets are never committed (`HF_TOKEN`; `ADMIN_ACCOUNT`, `SIGNUP_KEY`). Local ones go in untracked `.dev.vars`.
- Never commit `.dev.vars`, `backup/`, `.env`, or anything under `private-cloud-data`.
- Prefer the `-dev` configs and resources when testing.
- The canonical `www` -> apex redirect is a Cloudflare Single Redirect rule, not a Pages `_redirects` file.

## Tooling

- Agent skills live in `.claude/skills/` and `.agents/skills/` (gitignored), pinned by `skills-lock.json` to `cloudflare/skills`.
- Windows with PowerShell; use `pwsh` (7.x) for scripts. Wrangler's `workerd`/`esbuild` need `npm install-scripts approve` once.
