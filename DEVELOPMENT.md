# Development

Local-first workflow. Nothing here touches production unless you run a deploy
command explicitly.

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

`npm run dev:sync`, `dev:node-worker`, `dev:gateway` run each Worker with `--local`,
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
