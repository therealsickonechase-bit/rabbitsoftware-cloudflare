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

## Obsidian, Copilot, and GitHub

The local `RabbitOS Vault` at `C:\Users\odaat\Documents\RabbitOS Vault` is already
connected to `ringquistchase-collab/rabbitos-vault` on GitHub. Its existing
`git-obsi-sync` plugin is available for manual vault sync; automatic vault sync
is disabled to keep private-repository publishing approval-only. This does not
merge the vault into this Cloudflare repository or change either repository's
deployment workflow.

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

The plugin exposes note read/write and command tools. Review approvals before
allowing edits or commands. Vault notes used in a Copilot request can become
model context; do not request secrets or private linked-folder contents.
Git ignore rules are not MCP access controls. Setup verification initializes
MCP and lists tools without reading, editing, or uploading note contents.

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
python scripts\sync-github-vault.py --vault "C:\Users\odaat\Documents\RabbitOS Vault" --setup --repository ringquistchase-collab/brainflow
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

## Supabase

Project ref `ludxbakxpmdqhfgdenwp`. `supabase/` holds the CLI config and (future) migrations.

- `npm run supabase:link | supabase:start | supabase:stop | supabase:diff | supabase:types` wrap `npx supabase`. `supabase:start` needs Docker.
- Auth supplements the existing signed-device accounts; it does not replace them. `sync` exposes `GET /v1/supabase/health` and `GET /v1/supabase/me` (verifies a Supabase `Authorization: Bearer` access token against the project's JWKS and returns the user).
- `SUPABASE_URL` is a plain var in both `wrangler.toml` files. `SUPABASE_JWT_SECRET` is an optional secret, only needed for legacy HS256 projects.
- Not deployed yet. These sync changes are in the esbuild bundle, so they go live only on an explicit `cd workers/sync && npx wrangler deploy`.
