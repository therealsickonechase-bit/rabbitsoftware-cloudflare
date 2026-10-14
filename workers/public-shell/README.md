# Public CloudShell (`rabbitsoftware-public-shell`)

A **public, ephemeral sandbox** terminal for anyone on RabbitOS (`/cloudshell-public` in rabbit-web). It is a separate Worker from
`workers/cloudshell` (the owner shell and its approval gate, which this does not touch). It has no Supabase, vault, owner-token,
service-role or deploy-token binding, and none may be added. The only secrets are `TURNSTILE_SECRET_KEY` and `SESSION_SIGNING_KEY`.

Nothing here has been deployed or run against live services. Everything below is verified by unit tests, `tsc`, and
`wrangler deploy --dry-run --containers-rollout=none` only.

## How it works

1. The page loads a Turnstile widget. `POST /session {turnstile}` makes the Worker call Siteverify (fails closed). On success the Gate
   Durable Object admits a session (global, per-address and daily caps) and the Worker returns an HMAC-signed token `{sid, exp}`
   (random 128-bit session id). The container is not started yet.
2. The browser opens `wss://<worker>/ws` with subprotocols `rabbit-shell.v1, <token>` (the token is not in the URL, so it is not logged).
   The Origin must be in `ALLOWED_ORIGINS`. The Gate allows one terminal connection per session.
3. The first frame is `hello {cols, rows, keys}`. Only `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `COPILOT_GITHUB_TOKEN` (the visitor's own fine-grained PAT with the "Copilot Requests" permission; the one `*_TOKEN` name exempted from the protected list, exact match only) are accepted, validated and
   placed in the **launch environment of that one terminal process** (`createTerminal({env})`). They are never stored, logged, put in
   Durable Object storage, or set with `setEnvVars`. Every other environment variable of the PTY is built from scratch (`env.mjs`); the
   Worker's own env is never spread into it, and protected names (`*_TOKEN`, `*_SECRET`, `SERVICE_ROLE`, `SUPABASE`, `CLOUDFLARE`, ...) are refused.
4. Frames: `{t:"i",d}` input, `{t:"r",cols,rows}` resize; the Worker sends raw PTY bytes. Text frames only, max 16 KiB (hello 8 KiB), 64 KiB/s of input,
   NUL rejected, 8 MiB of output per session then the terminal is ended.
5. One `PublicSandbox` container per session id (`basic` instance: 1/4 vCPU, 1 GiB, 4 GB disk), PTY runs as unprivileged user `visitor`.
   `Gate` has an alarm that destroys the container at 10 minutes idle or 30 minutes after creation (whichever first); the bridge also
   closes the socket at the hard limit.

Limits live in `src/limits.mjs`: 6 live sessions globally (= `max_instances`), 1 per address, 6 sessions and 400 command lines (Enter presses) per
address per UTC day. Addresses are stored only as an HMAC (`ipKey`), never raw.

## Threat model

| Abuse | Defence | Residual risk |
| --- | --- | --- |
| Crypto mining | 1/4 vCPU, 30 min lifetime, 6 sessions total, egress allowlist (no mining pools, no arbitrary hosts), per-address caps | A miner can still burn the small CPU slice allowed for 30 minutes per session, 6 sessions per address per day. Wasted compute is bounded by the caps, not zero. |
| Scanning / attacking other hosts | HTTPS-only allowlist of ~10 hosts, port 443, no IP literals, GET/HEAD only on source hosts | See "What cannot be restricted". |
| Spam / phishing hosting | No inbound ports exposed, nothing served; sessions are deleted | Visitors can use allowed hosts (e.g. paste text to GitHub is blocked: no credentials, writes refused). |
| Bot signup flooding | Turnstile before every session, per-address and global caps, Origin check | A real human farm or residential proxies can rotate addresses; the global cap of 6 is the backstop and also the denial-of-service ceiling for legitimate users. |
| Credential theft from the operator | No owner secret, Supabase, vault or deploy token exists in the Worker, its env, or the container | None by design; keep it that way. |
| Visitor key leakage | Keys only in browser memory and one PTY launch env; never logged (`logLine` allowlist) | Keys are visible to anything else in the same container (the visitor's own session) and, if the platform logs RPC arguments, in platform internals (not verifiable here). Tell visitors to use low-limit keys. |
| Cost runaway | Hard caps above, kill switch, alarm sweeps | Set Cloudflare billing notifications (below). |

**Kill switch.** `PUBLIC_SHELL_ENABLED` must be exactly `"true"` to serve. It is read from the Worker env on every request (all routes answer 503
otherwise), on every WebSocket frame, and in every Gate sweep (which destroys all live sandboxes). Missing or anything else means off. Turn off with
`PUBLIC_SHELL_ENABLED=false` in `wrangler.jsonc` and redeploy (a var change needs a deploy), or from the dashboard (Worker > Settings > Variables),
or `npx wrangler delete --name rabbitsoftware-public-shell` as the last resort.

### What cannot be restricted (be honest with users)

- Egress is enforced by the Containers `allowedHosts` list plus an outbound handler in the Worker (HTTPS interception). Both are expected to be
  honoured by the platform but **were not tested live here**. Plain TCP/UDP, DNS lookups and anything the interception cannot see (non-HTTP protocols,
  tunnelling over DNS, traffic to IPs without a hostname) may not be covered. Verify after deploy (step 9) before announcing it.
- The allowlist includes `github.com` and registries: a visitor can fetch arbitrary public code and run it inside their sandbox. That is the point of a sandbox, but
  it means content from those hosts can be used for outbound HTTP to those hosts only, not elsewhere.
- A PTY has no per-command timeout. The 60 s command timeout (`LIMITS.commandTimeoutMs`) is defined for non-interactive helper runs but **no `/exec` endpoint
  exists yet**; interactive use is bounded by idle (10 min), lifetime (30 min), output (8 MiB), process (`ulimit -u 256`) and file-size limits instead.
- Per-IP counters rely on `CF-Connecting-IP`; shared NATs share quota, and attackers with many addresses get many quotas.
- The daily command quota counts Enter presses, not processes (a script can run many commands from one line).
- CPU, memory and disk caps are those of the `basic` instance type; custom per-container limits need an enterprise plan.
- `claude` and `gemini` send the visitor's prompts and key to Anthropic / Google; that is outside our control.

## Public data hub from the sandbox

The sandbox may `GET` (and `HEAD`) `https://app.rabbitsoftware.io/api/data` and `/api/data/<dataset>` (research data and the chain ledger
metadata only, read-only, page size at most 200). Everything else on that origin stays closed: any other path, and any non-read method
(`egress.mjs`, tested in `scripts/test-public-shell.mjs`). Example: `curl -fsS "https://app.rabbitsoftware.io/api/data/research_records?limit=50" | jq`.
`help-rabbit` lists the same commands. The hub is public and permanent once copied; personal tables are not in it.

## PowerShell and the network (`pwsh`, `rabbit-net`)

- **PowerShell 7** is installed at `/opt/microsoft/powershell/7` from the official GitHub release tarball, pinned to **7.6.6** (published 2026-09-08, the newest stable release at least
  14 days old on 2026-10-14; 7.6.7 was one day old) and checked in the build with `sha256sum -c` against `ddbc4a2d...03bc`, the digest GitHub shows for
  `powershell-7.6.6-linux-x64.tar.gz` (identical to the SHA256 in the release notes, read from the official release page on 2026-10-14). The login shell stays **bash**;
  visitors type `pwsh` (the page has a "Start PowerShell" button that types it without Enter). `/usr/local/bin/pwsh` is a tiny launcher that sets invariant globalization (no ICU
  needed) and turns off telemetry and update checks.
- **Default = the normal connection.** There is no proxy, VPN or alternative route. `Invoke-WebRequest` / `Invoke-RestMethod` in pwsh go through the same egress allowlist as `curl`
  (HTTPS to the hosts in `src/egress.mjs` only; writes refused on source hosts and on app.rabbitsoftware.io). Nothing was widened for PowerShell.
- **`rabbit-net`** (bash, `container/rabbit-net`): `status` lists the allowlisted connection; `check` sends `curl --head` (5 s timeout) to each allowlisted host and prints HTTP code and time.
  No scanning, no raw sockets, no loops over address ranges. A test keeps its host list equal to `EGRESS_HOSTS`.
- **Intentionally absent:** `ping`/ICMP, `dig`/`nslookup`/`host`, `traceroute`, `nmap`, `netcat`, `socat`, `tcpdump` and any port scanner. Reasons: the sandbox can only send HTTPS to named hosts, so ICMP,
  arbitrary DNS and TCP probing cannot work through the allowlist (a tool that appears to work would give false answers); and such tools are exactly what is used to scan other people's machines
  from a free shared box. In pwsh, `Test-NetConnection`, `Resolve-DnsName` and `-TraceRoute` are Windows-only or need those absent tools, so expect them to fail on Linux. For real network
  diagnostics use the RabbitNet module on your own PC (rabbit-web `scripts/powershell/`).
- **Not verified:** the image was not built here (no Docker run); pwsh start-up on the base image (needs libssl, present in the Ubuntu base), and live `Invoke-WebRequest` through the egress handler are untested.

## Owner deploy steps (none have been run)

1. **Docker** must be running locally for `wrangler deploy` to build the image (Containers needs the Workers Paid plan).
2. **Confirm the repos in the Dockerfile are public** (`therealsickonechase-bit/rabbit-web`, `.../rabbitsoftware-cloudflare`); the build clones them anonymously, and only
   `site/` of the second. Anything private makes the build fail (safe), not leak.
3. **Create a Turnstile widget** (dashboard > Turnstile > Add widget): hostname `app.rabbitsoftware.io` (add `localhost` for local tests), mode Managed.
   Note the **site key** (public) and **secret key**.
4. `cd workers/public-shell` then set secrets (you will be prompted for the value; never pass it on the command line):
   - `npx wrangler secret put TURNSTILE_SECRET_KEY`
   - `npx wrangler secret put SESSION_SIGNING_KEY` (at least 32 random characters, e.g. `openssl rand -base64 48`)
5. Review `wrangler.jsonc` (`ALLOWED_ORIGINS`, `max_instances`, `instance_type`). It ships with `PUBLIC_SHELL_ENABLED: "false"`.
6. **Dry run:** `npx wrangler deploy --dry-run --containers-rollout=none --config wrangler.jsonc` (works offline), then deploy: `npx wrangler deploy`
   (first deploy builds and pushes the container image; it can take several minutes). Then give the Worker a stable URL: attach a custom domain such as
   `shell.rabbitsoftware.io` (dashboard > Worker > Settings > Domains) or use the `workers.dev` URL.
7. **Enable cost alerts** before turning it on: dashboard > Manage account > Notifications > add Billing / usage-based alerts (Workers, Durable Objects, Containers) with a low
   threshold, and review Containers usage under Compute > Containers. Consider a Cloudflare WAF rate-limit rule on `POST /session`.
8. **rabbit-web build env** (Cloudflare Pages/Worker vars for the console, public values only): `NEXT_PUBLIC_PUBLIC_SHELL_URL=https://shell.rabbitsoftware.io`
   and `NEXT_PUBLIC_TURNSTILE_SITE_KEY=<site key>`; rebuild and deploy rabbit-web (`npm run deploy:vinext`, only with your go-ahead).
9. **Test with the switch still off, then on:** set `PUBLIC_SHELL_ENABLED` to `"true"`, deploy, open `/cloudshell-public`, run `ledger`, `curl https://example.com` (must
   fail), `curl https://registry.npmjs.org/left-pad` (must work), `env | grep -i -E 'token|secret|supabase|cloudflare'` (must print nothing), then confirm the session ends after idle.
   If the blocked `curl` succeeds, set `PUBLIC_SHELL_ENABLED` back to `"false"` immediately.

## Development

- `npm run test:public-shell` (pure logic: quotas, expiry, per-IP caps, Turnstile deny, keys, protected env names, frame limits, egress, config checks)
- `npm run typecheck:public-shell`; regenerate types after editing `wrangler.jsonc`: `npx wrangler types --config workers/public-shell/wrangler.jsonc workers/public-shell/worker-configuration.d.ts`
- `npm run dev:public-shell` runs it locally (needs Docker for the container; use Turnstile's published test keys, never real ones, in `.dev.vars`).

## Files

`src/index.ts` Worker, `Gate` and `PublicSandbox`; `src/limits.mjs`, `quota.mjs`, `tokens.mjs`, `egress.mjs`, `env.mjs`, `frames.mjs`, `turnstile.mjs` pure modules;
`Dockerfile` and `container/` image contents (pinned `@google/gemini-cli@0.62.0`, `@anthropic-ai/claude-code@2.1.285`, `@github/copilot@1.0.89`, all existing on npm and at least two weeks old on 2026-10-14; `container/rabbit-net`, `container/pwsh` (PowerShell 7.6.6, SHA256 checked); `container/help-rabbit` prints the in-terminal guide, mentioned in the motd).

## GitHub Copilot CLI (`copilot`)

Terminal-only (no REST API). Needs a Copilot subscription and Node 22+. The Dockerfile fails the build if the base image's Node is older than 22; the base
`cloudflare/sandbox:0.13.0-next.776.1` ships Node v22.23.2 (checked by running the already-built local cloudshell image of the same base, offline).
Auth: either `/login` inside `copilot` (device-code flow, the visitor opens the printed URL in their own browser), or `COPILOT_GITHUB_TOKEN` from the keys drawer.
Version choice: `npm view @github/copilot time` showed 1.0.89 (2026-09-28) as the newest release at least 14 days old on 2026-10-14 (1.0.90 was 2026-09-30).

Egress added (exact hosts, because the Container `allowedHosts` list takes no wildcards): `api.githubcopilot.com` (inside GitHub's documented `*.githubcopilot.com`),
`api.github.com` (GET `/user` and `/copilot_internal/*` only) and POST `github.com/login/*` (documented `github.com/login/*`, for the device flow). Source: GitHub Docs
"Copilot allowlist reference" (docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-allowlist-reference). That page covers Copilot in general, not the CLI specifically.

Unverified TODO (not added, so `copilot` may fail until checked live with the sandbox switched on):
- the plan-specific hosts `api.individual.githubcopilot.com`, `api.business.githubcopilot.com`, `api.enterprise.githubcopilot.com` (documented only as wildcards `*.individual.githubcopilot.com` etc.; the exact subdomain the CLI uses is unconfirmed);
- `copilot-proxy.githubusercontent.com` and `origin-tracker.githubusercontent.com` (documented as suggestion APIs; unknown whether the CLI uses them);
- telemetry/experiment hosts (`copilot-telemetry.githubusercontent.com`, `collector.github.com`, `default.exp-tas.com`): deliberately left blocked, the CLI should tolerate their absence but this is untested;
- whether the Containers outbound interception handles WebSocket/streaming responses from the Copilot API.
