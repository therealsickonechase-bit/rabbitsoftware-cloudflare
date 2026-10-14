# Owner command shell and approval broker

This is a **separate**, deployed Linux command and access-broker Worker. It does not
add arbitrary execution to the existing vault-note Worker. RabbitOS's owner
backend is its only intended client; owner access must be configured and
verified separately. The current console has legacy account/login routes
disabled. New restricted authentication and agent APIs are separate opt-in
surfaces; default local-only mode denies all remote operations.

## Agent-approved access

The operator chooses one console mode: `local-only`, `supabase`, or
`cloudflare-access`. Eligible people must have verified identities on an
operator-controlled allowlist. Named agents use a separate scoped machine
credential; they cannot choose an arbitrary human identity. Identity verification
does not itself grant shell/vault access.

An approval agent, entrusted with a **different** credential, decides pending
access requests within the operator's subject/capability policy. Approval lasts
exactly **one hour** from that decision. Allowed capabilities are `shell.execute`,
`vault.submit`, and `vault.read`; no wildcard/admin scope or self-selected
approval flag is accepted. Policy withdrawal, revocation and expiry deny new
operations. A model's approval prose is not a stored authorization decision.

Configure these Worker values only during an explicitly approved activation:

- `RABBIT_CLOUD_ACCESS_SUBJECTS`: JSON array of exact subjects, e.g.
  `["email:public-synthetic@example.com","agent:vault-public-synthetic"]`.
- `RABBIT_CLOUD_AGENT_SCOPES`: JSON array of explicitly delegated capabilities.
- `RABBIT_AGENT_APPROVAL_TOKEN`: separate environment secret, at least32 characters;
  **not** supplied to the console, browser, command environment or note Worker.

Missing policy arrays fail closed. The approved pilot configuration allows only
`email:ringquistchase@gmail.com` and `agent:local-vault-agent`, with the three
explicit capabilities above.
The `AccessGate` Durable Object is one operator-policy coordination atom,
not an unbounded global identity directory. It retains at most64 live request
records, pending for15 minutes, approved for one hour, denied/revoked for15
minutes. Records are pruned transactionally on later access, not by a resident
scheduler. A repeated request cannot renew its own grant or expand its scopes.

Backend-only endpoints use `RABBIT_CLOUDSHELL_TOKEN`:

- POST `/access/request` `{subject,scopes}`: create/reuse a bounded request.
- POST `/access/check` `{subject}`: authoritative current grant and expiry.
- POST `/access/link-job` `{subject,jobId}`: bind a successful submission to
  that subject's current grant, max64 distinct job IDs.
- POST `/access/check-job` `{subject,jobId}`: require same-grant ownership and
  `vault.read` before status/result reads. A guessed job ID is not authority.

Approval-agent-only endpoints use `RABBIT_AGENT_APPROVAL_TOKEN`:

- GET `/access/requests`: eligible pending requests.
- POST `/access/approve`, `/access/deny`, `/access/revoke`: exact `{id}`.

All broker endpoints reject browser Origin headers. Console identity/scope/grant
checks occur before each forwarded shell/vault operation; the broker rechecks
the live policy, never an application-local grant cache. The shared backend
credential is trusted service authority and must never be given to caller agents.
Approver and caller credentials have separate purposes.

Job links expire with the grant. Reapproval requires resubmission/relinking.
An upstream submit followed by linkage failure is an explicit partial-operation
error, not a canceled or successfully linked job. Approval expiration does not
cancel work already accepted upstream.

## Contract

- Server-only `RABBIT_CLOUDSHELL_TOKEN`, at least 32 characters; use the same
  secret in the RabbitOS backend. Never send it to the browser or container.
- Authenticated `GET /health` describes limits without allocating a container.
- Authenticated `POST /execute`, JSON `{ "command": "...", "consent": true }`.
  No `Origin` header, owner ID, environment variables, or extra fields accepted.
- Request maximum 8 KiB; command maximum 4000 UTF-8 bytes, no NUL.
- One owner command through a transactional durable gate. Fixed sandbox ID;
  no automatic retry. Resource configuration permits at most two provisioned
  instances, **not** two concurrent owner commands or a dollar-budget ceiling.
- Explicit `/bin/bash -lc`, `/workspace`, remote execution timeout 60 seconds.
  Startup/readiness and teardown take additional time.
- Return stdout, stderr, exitCode, timedOut and truncated. A nonzero exit code,
  timeout, or truncation is not proof of successful task completion.
  SDK output collection is capped at 65,536 bytes.
- Container destroyed after each command. No mounted vault, persistent files,
  automatic export, interactive PTY, or retained shell session.
- Arbitrary approved shell code may use public networks. Do not paste secrets,
  private notes, or personal data into commands. No live service credentials
  are injected into the container's environment.
- A dropped HTTP response does not prove nonexecution. Never retry implicitly.
  Failed/interrupted teardown leaves the durable gate locked. Recovery requires
  an approved operator to confirm container destruction before clearing `active`
  in the `CommandGate` object. There is no time-expiry overlap fallback.

## Local verification

From the repository root:

```powershell
npx wrangler types --config workers\cloudshell\wrangler.jsonc --env-interface Env --include-runtime workers\cloudshell\worker-configuration.d.ts
npm run typecheck:cloudshell
npm run test:cloudshell
npx wrangler deploy --dry-run --containers-rollout=none --config workers\cloudshell\wrangler.jsonc
```

The last command validates **only the Worker bundle**, not the Docker image.
For a full image build dry-run, use the same command without
`--containers-rollout=none`. Docker Desktop is installed and its Linux engine
has passed the full image build and a real Bash/Node run. Python is absent
from this pinned image. Mock tests alone do not prove Linux execution.

The SDK and image are both pinned to `0.13.0-next.776.1`; the image tag exists
in the public registry. Installed preview types govern this implementation,
not examples for the newer `1.0.0` API. Do not mix package/image release lines.

Local execution requires an approved working Docker runtime and an ignored
local secret file, then `npm run dev:cloudshell` (local port 8806).
Native Windows Wrangler container development is unsupported; use WSL with
Node and Docker integration configured. Those WSL prerequisites are not yet
configured here, so no local container Worker listener is claimed.

## Activation gate

Before an additional live rollout: approve paid Containers usage, choose and verify owner
authentication, build and execute the real image locally or in approved CI,
configure server-only secrets, review cost monitoring, and explicitly approve
deployment of the Worker and console. Verify owner denial paths and an
authenticated public-synthetic shell command afterward. Do not use a
Worker-only rollout to claim a functioning new shell.

## Verified pilot activation (2026-10-12)

- Shell/broker: `https://rabbitsoftware-cloudshell.rabbitsoftware-gateway.workers.dev`.
- Separate Supabase console: `https://rabbit-web-cloud-supabase.rabbitsoftware-gateway.workers.dev`.
- Separate Access console: `https://rabbit-web-cloud-access.rabbitsoftware-gateway.workers.dev`.
- Main console was not redeployed; its tool policy remains `local-only`.
- Anonymous shell health returned 401; authenticated health returned 200.
  Missing command consent was rejected. A real isolated Linux command returned
  exact expected stdout, exit 0, no stderr, timeout or truncation.
- The named agent requested all three scopes, the separately authenticated
  approving coding agent approved it, and both console routes executed a
  consented synthetic command with exact checked output. The grant lasts one
  hour; deployment does not renew it.
- Both Access policies are reusable: one exact email Allow policy and one
  Service Auth policy for one specific service token, not Any Service Token.
  Anonymous Access requests redirect to authentication. The pilot service
  token expires 2026-10-13T18:44:42Z; operator renewal/rotation is explicit.
- Access service JWTs have an empty `sub`; the console verifies their signed
  `common_name` against the exact configured Client ID, after verifying issuer,
  audience, signature and expiry.
- Live transport testing exposed a redirect-mode failure. The BFF now uses
  `manual` and rejects redirects without following or forwarding credentials.
- A consented public-synthetic note job completed with its exact marker/path,
  empty edits, same-grant result reads through both consoles, guessed-job 403
  and machine browser-Origin 403. Human browser sign-in remains unverified.
  No private vault notes were uploaded by these activation checks.

Ignored local and production credential snapshots are distinct; do not
implicitly rotate them. The console deployment helper transfers only caller,
backend and note credentials, never the approval secret.

The opt-in vault bridge uses the existing [vault-agent protocol](../vault-agent/src/protocol.mjs);
viewing browser results is not automatic local-vault writeback.

## Local/connected agent caller

`npm run vault:cloud-access -- --vault <vault-path> --request vault.submit,vault.read`
requests access for the server-configured named agent, not a user-selected
subject. Other explicit actions are `--status`, `--shell <consented-json-file>`,
`--submit <consented-snapshot-json-file>`, `--job-status <id>` and
`--job-result <id>`. Caller environment uses `RABBIT_CLOUD_TOOLS_URL` and
`CLOUD_TOOLS_AGENT_TOKEN`.

An authorized approving agent uses `RABBIT_CLOUDSHELL_URL` and
`RABBIT_AGENT_APPROVAL_TOKEN` with `--list`, `--approve <request-id>`,
`--deny <request-id>`, `--revoke <request-id>`, or explicitly
`--approve-allowed` (max16 decisions per invocation, server policy enforced).
This is agent-side approval, not a scheduled daemon or silent human override.

The local Ollama vault runtime can also expose a native `cloud_access` tool
when a trusted provider config explicitly supplies `cloudAccess`, with
`allowRemote: true`, an exact `actions` subset (`request`, `status`, `list`,
`approve`, `deny`, `revoke`), fixed app/broker origins, and `tokenEnv` /
`approvalTokenEnv` references. It is disabled by default and refused for
hosted note providers. No arbitrary shell or note-upload tool is added to
the local model loop. Pending queue output is bounded to16 with an explicit
remaining count. Model-selected decisions retain origin/hash/status evidence
in the existing automatic run report; prompts/notes cannot expand host actions.

The installed native plugin now supports trusted `localProviderConfig` and
`localCallerCredentials` paths. It bounds/validates the caller credential file
and transfers only `CLOUD_TOOLS_AGENT_TOKEN`, removing backend, approval and
note tokens from that child environment. This pilot enables only `request`
and `status` for local Ollama. The separately configured hosted note provider
is preserved. The command **Report connected cloud-access status with the
local agent** performs a read-only local-model task and retains its report.
Obsidian's desktop CLI is not needed.
That report command requires a successful model-selected status call before
accepting an answer; it does not fabricate a tool call from model prose.

Every attempted CLI operation retains a private report under
`Cloud Agents/Results/cloud-access-<uuid>.json`, including failures, request
hashes and terminal output when available. File creation/update is synced and
atomic; a hard interruption may leave `running`, never fabricated success.
The CLI checks a128-report retention capacity before starting further actions;
archive reviewed reports explicitly. Transport success does not establish
factual correctness of command output.

Optional `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` service credentials
support an explicitly configured Access-protected API. Optional
`CLOUD_TOOLS_PROXY_URL`/`CLOUD_TOOLS_PROXY_TOKEN_ENV` reuse the existing explicit
CONNECT/TLS transport; no insecure proxy fallback. Offline calls fail visibly
and retain the failure; they are not automatically replayed or approved.

## Confirm-then-run coding agent

`npm run agent:code -- "task"` lets a model propose files plus one bash command per
step. The script prints them and asks `Run this in CloudShell? [y/N/e(dit)/q]` on the
terminal. **Every command needs your explicit y**; there is no auto-confirm option and
it refuses to run without a TTY. It also needs an active, separately approved
one-hour grant: request one with
`npm run vault:cloud-access -- --vault <vault-path> --request shell.execute`
and wait for the approval agent (this tool never approves itself or touches the
approval token). Each command runs in a container that is destroyed afterwards and
holds no secrets; nothing persists between steps. Max 8 steps; a denied/expired
grant (HTTP 401/403) stops the run. Commands that dump the environment or read
`~/.ssh` are refused locally; `curl | sh` needs an extra y. Output fed back to the
model is scrubbed of credential patterns and capped at 16 KB.

Environment: `CLOUD_TOOLS_AGENT_TOKEN`, `RABBIT_CLOUD_TOOLS_URL` (shell caller), and
`CODING_AGENT_PROVIDER` = `gemini` (`GEMINI_API_KEY`, `CODING_AGENT_MODEL` required),
`claude` (`ANTHROPIC_API_KEY`; model defaults to `claude-sonnet-5-5`) or `ollama`
(`OLLAMA_HOST`, default `http://127.0.0.1:11434`, and `CODING_AGENT_MODEL`). Keys
are read only from the environment and sent only to the provider endpoint.
`--report-dir DIR` (default `./.coding-agent-reports`, gitignored) receives a private
`Cloud Agents/Results/coding-agent-<uuid>.json` audit file with request hashes,
decisions and exit codes (no command text). Tests: `npm run test:coding-agent`.

**The pilot service token expired 2026-10-13T18:44:42Z and needs operator renewal
before any live use.**
