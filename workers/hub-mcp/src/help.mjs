// hub_help: how a worker (a person or an AI assistant) finds their way around the platform.
// Static facts live here; the commands come from the catalog, and every command id named here must exist in it (tests check).

import { GUEST_URL, OWNER_SHELL_URL } from './catalog.mjs'
import { CODING_AGENTS, LANGUAGES, OTHER_AGENTS } from './guide.mjs'

/** Each service: what it is, where, how to check it, and which catalog commands help. `check` ids are guest-readable; `fix` ids are owner commands. */
export const SERVICES = Object.freeze([
  { id: 'site', name: 'rabbitsoftware.io (public website)', where: 'Cloudflare Pages', url: 'https://rabbitsoftware.io', about: 'Static pages, the status page, the chain viewer.', check: ['hub-status'], fix: ['gcp-standby-preview', 'gcp-standby-run'], note: 'If Pages is down, the Cloud Run standby copy has the same pages.' },
  { id: 'status', name: 'Live status page and feed', where: 'Cloud Run job rabbit-status, public bucket, Pages', url: 'https://rabbitsoftware.io/status.html', about: 'Every 5 minutes: which public services answer, whether the chain copies agree, the public data tree.', check: ['hub-status'], fix: ['gcp-status-preview', 'gcp-status-run'], note: 'An alert emails the owner if the recorder stops for 30 minutes.' },
  { id: 'app', name: 'RabbitOS app (console)', where: 'Cloudflare Workers (vinext) with Supabase', url: 'https://app.rabbitsoftware.io', about: 'The console, the public chain and data APIs, the research pages.', check: ['hub-status', 'web-chain-head'], fix: [], note: 'App deploys are the owner\'s decision: npm run deploy:vinext.' },
  { id: 'guest-shell', name: 'Guest shell (throwaway terminal)', where: 'Cloudflare Worker gate, then Cloud Run rabbit-visitor-shell behind an allowlist proxy VM', url: GUEST_URL, about: 'A terminal per visitor with claude, gemini, copilot and common languages. 10 idle minutes, 30 in total.', check: ['hub-status', 'hub-selftest'], fix: ['gcp-shell-preview', 'gcp-shell-run', 'gcp-switch-shell-cloudflare'], note: 'If it breaks on Google Cloud, switch back to the Cloudflare sandbox first, then investigate.' },
  { id: 'owner-shell', name: 'Owner shell', where: 'Cloudflare Worker behind Cloudflare Access', url: OWNER_SHELL_URL, about: 'Runs approved commands for the signed-in owner. Sign-in is the owner\'s.', check: [], fix: [], note: 'Owner only.' },
  { id: 'hub', name: 'Hub MCP', where: 'Cloud Run rabbitos-hub-mcp', url: 'https://rabbitos-hub-mcp-vxx5lz7c5a-wl.a.run.app/mcp', about: 'This server: links, status, public chain and data, research tools, the command catalog, safe command drafting.', check: ['hub-selftest', 'hub-help'], fix: ['gcp-hub-preview', 'gcp-hub-run', 'cf-test-hub', 'web-export-commands'], note: 'Owner role needs a hub key: hub-key-new.' },
  { id: 'chain', name: 'Public chain and mirrors', where: 'App (Supabase), Google Cloud public bucket, local file', url: 'https://app.rabbitsoftware.io/chain', about: 'Hash-linked public ledger plus the Maxwell chain, copied to three places that must agree.', check: ['web-chain-head', 'hub-chain-consistency'], fix: ['gcp-daily-backups', 'gcp-miner-job-preview', 'miner-verify-cloud', 'ra-maxwell-adopt'], note: 'A chain entry proves existence and time, not truth. The PC and the Cloud Run miner both add blocks; the app records one block per number, so they cannot fork.' },
  { id: 'data', name: 'Data hub', where: 'App', url: 'https://app.rabbitsoftware.io/data', about: 'Public read-only datasets (research records, topics, runs, summaries, chain blocks).', check: ['hub-research-feed'], fix: [], note: 'Personal data is never in it.' },
  { id: 'research', name: 'Research web', where: 'Public sources, the owner\'s research agents, chain, Supabase, data hub, hub', url: 'https://app.rabbitsoftware.io/research', about: 'PubMed, Europe PMC, ClinicalTrials.gov, openFDA (live through the hub), plus NIH RePORTER, ClinVar and St. Jude (through the agents).', check: ['hub-research-sources', 'hub-research-pubmed', 'hub-research-feed'], fix: [], note: 'Agents on the owner\'s computer decide what to ingest.' },
  { id: 'audit', name: 'Weekly audit', where: 'Cloud Scheduler, Workflow rabbit-qa, Cloud Run job', url: 'https://console.cloud.google.com/storage/browser/rabbitsoftware-io-reports?project=rabbitsoftware-io', about: 'Mondays 09:00 Los Angeles: crawls both sites, scores them, draws the platform map, site map and Supabase tree.', check: [], fix: ['gcp-qa-preview', 'gcp-qa-run', 'gcp-qa-now-run', 'cf-qa-local', 'cf-test-qa'], note: 'The report is private; the owner reads latest.html in the reports bucket.' },
  { id: 'monitoring', name: 'Logs, metrics, alerts, analytics', where: 'Google Cloud (Logging, Monitoring, BigQuery)', url: 'https://console.cloud.google.com/monitoring?project=rabbitsoftware-io', about: 'Five alert policies, six uptime checks, a dashboard, BigQuery analytics kept 90 days.', check: [], fix: ['gcp-observability-preview', 'gcp-observability-run', 'gcp-monitoring-run'], note: 'No visitor IP addresses are stored.' },
  { id: 'standby', name: 'Standby website and app mirror', where: 'Cloud Run', url: 'https://rabbit-site-standby-vxx5lz7c5a-wl.a.run.app', about: 'Copies ready if Cloudflare is down.', check: ['hub-status'], fix: ['gcp-standby-run'], note: 'Re-run the standby script after the website changes.' },
  { id: 'backups', name: 'Backups', where: 'Google Cloud Storage (private, versioned), run daily 3:00 AM', url: 'https://console.cloud.google.com/storage/browser/rabbitsoftware-io-backups?project=rabbitsoftware-io', about: 'Private backups, the public chain copy and the rabbit web miner.', check: [], fix: ['gcp-daily-backups', 'gcp-backup-job-preview', 'gcp-backup-job-run', 'cf-test-backup-job'], note: 'Never reachable from the guest shell. The nightly Cloud Run job rabbit-backup (03:30) writes the cloud copy under platform-cloud/ once it is set up.' },
  { id: 'toolbox', name: 'Toolbox: commands and files for the agents', where: 'gs://rabbitsoftware-io-backups/toolbox/ (private), read-only for the cloud task worker and explorer', url: 'https://console.cloud.google.com/storage/browser/rabbitsoftware-io-backups/toolbox?project=rabbitsoftware-io', about: 'The command catalog and the files the commands use, with a manifest of hashes, so local and cloud agents hold the same thing. Built only from git-tracked code, scripts and documents that pass a secret scan; never secrets or personal data. Republished nightly.', check: [], fix: ['toolbox-publish', 'toolbox-verify', 'toolbox-list', 'agent-capabilities'], note: 'Callers use the hub tools command_get (files a command uses), agent_capabilities and toolbox_status; guests get links to the public repositories only.' },
  { id: 'echo', name: 'PC and cloud echo', where: 'Cloud Run job rabbit-echo + PC task RabbitOS Echo, every 5 minutes', url: 'https://console.cloud.google.com/run/jobs?project=rabbitsoftware-io', about: 'The PC and Google Cloud acknowledge each other without any network link: each leaves a signed note (counter, random ID, time) in a private bucket folder and acknowledges the last note from the other side. Staging: tasks and notes left for an agent wait in the bucket and are delivered to its local inbox, so agents that are not running still receive them. The DNA sequence of a person follows the same acknowledgement-only model: compared on the PC only, and only an acknowledgement (never the sequence or the result) is echoed.', check: [], fix: ['echo-pc-run', 'echo-pc-register', 'stage-add', 'stage-pending'], note: 'Heartbeat chart (24 h, 5-minute cells) is public on rabbitsoftware.io/status.html; the logs and daily digests stay in the private reports bucket. Owner-only detail otherwise.' },
  { id: 'vault', name: 'Obsidian vault copy in Google Cloud', where: 'Google Cloud Storage (private, versioned), uploaded hourly from the PC of the owner', url: 'https://console.cloud.google.com/storage/browser/rabbitsoftware-io-vault-private?project=rabbitsoftware-io', about: 'The vault notes and agent files (what the private GitHub sync takes), minus Local/EEG and the PC-folder view. One-way: the vault is never changed.', check: [], fix: ['gcp-vault-bucket-preview', 'vault-gcs-preview', 'vault-gcs-sync', 'vault-gcs-list', 'vault-gcs-restore'], note: 'Never reachable from the guest shell, the hub or the Cloud Run services. Replaced or deleted notes are kept 90 days.' },
  { id: 'wallet', name: 'Wallet key (Cloud KMS) - donations open', where: 'Google Cloud KMS HSM key rabbit-wallet/maxwell-donations', url: 'https://console.cloud.google.com/security/kms/keyring/manage/us-west2/rabbit-wallet/keys?project=rabbitsoftware-io', about: 'One hardware-protected secp256k1 key gives a Bitcoin (bc1q) and an Ethereum address. The private key cannot be exported. Donations are OPEN: the front page of rabbitsoftware.io, /donate and the app show the Bitcoin and Ethereum addresses with open-in-wallet links (switch: workers/wallet/donations.json, open). A watcher job records what arrives (private) and emails the owner; the project has a lien against deletion and an alert on any key change. Recovery plan: docs/wallet.md.', check: [], fix: ['gcp-wallet-preview', 'gcp-wallet-watch-preview', 'gcp-wallet-recovery-preview', 'cf-wallet-state', 'cf-test-wallet-watch', 'cf-wallet-prove', 'cf-wallet-build-donate', 'cf-wallet-status', 'cf-wallet-withdraw-dry', 'cf-test-wallet'], note: 'Open but not yet promoted: still to do are the small wallet test and the legal and tax decision. The withdrawal tool is built and tested (guards: allowlist, limits, retyped confirmation) but has not yet been used with real funds; see docs/wallet.md.' },
  { id: 'anchor', name: 'Anchoring: Bitcoin (OpenTimestamps), Ethereum, XRP Ledger', where: 'Cloud Run job rabbit-anchor, proofs in the public ledger bucket', url: 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/index.json', about: 'Every 6 hours the job anchors the public ledger and Maxwell chain heads to Bitcoin if they changed, and upgrades earlier proofs once Bitcoin confirms them. The rabbit-anchor-chains job posts the same fingerprint to Ethereum and the XRP Ledger once their small fee accounts are funded. Ask the hub tool anchor_status for the live state.', check: [], fix: ['gcp-anchor-preview', 'gcp-anchor-run', 'gcp-anchor-chains-preview', 'gcp-anchor-chains-run', 'cf-test-anchor', 'cf-test-anchor-chains'], note: 'A proof shows a document existed by a Bitcoin block; it does not show the contents are true.' },
  { id: 'vault-mirror', name: 'Vault mirror (GitHub to Google Cloud)', where: 'Cloud Run job rabbit-vault-mirror, hourly at :40', url: 'https://console.cloud.google.com/storage/browser/rabbitsoftware-io-vault-private/github-mirror?project=rabbitsoftware-io', about: 'Clones the private vault repository on GitHub and copies it to the private vault bucket (github-mirror/), so the cloud copy stays current even when the PC is off. Needs a read-only GitHub token in Secret Manager; the Obsidian plugin and the PC sync do not change.', check: [], fix: ['gcp-vault-mirror-secrets-preview', 'gcp-vault-mirror-preview', 'cf-test-vault-mirror'], note: 'If it fails, the usual cause is an expired token: the owner creates a new read-only token and stores it again (the owner commands are in the catalog).' },
  { id: 'agents', name: 'Agents and the Google Cloud Agent Registry', where: 'Cloud Run rabbit-research-agent (A2A), rabbitos-hub-mcp (MCP); listed in the Agent Registry of project rabbitsoftware-io', url: 'https://rabbit-research-agent-vxx5lz7c5a-wl.a.run.app/.well-known/agent-card.json', about: 'The Research Agent answers the A2A protocol (message/send) with live read-only searches of public research sources. It and the Hub are registered in the Agent Registry so they can be found and called. The other agents run on the owner PC, on Cloudflare or as jobs; docs/agents.md lists all of them and how each is deployed.', check: [], fix: ['gcp-research-agent-preview', 'gcp-agent-registry-preview', 'gcp-task-worker-preview', 'gcp-research-explorer-preview', 'gcp-eeg-analysis-preview'], note: 'Registering describes where an agent is; it gives nobody access.' },
  { id: 'huggingface', name: 'Hugging Face (model, Space, datasets, buckets)', where: 'huggingface.co/Therealsickonechase-bit', url: 'https://huggingface.co/Therealsickonechase-bit', about: 'The owner’s model Llama-3.2-3B-RabbitSoftware-GGUF, the image Space rabbitos-eeg-qwen-image (receives fixed words only), three datasets (two private) and four buckets. The hub tool huggingface_status reports the public metadata and whether the Space runs; the buckets and datasets are backed up to the private Google Cloud backups bucket nightly from the owner’s PC.', check: [], fix: ['web-hf-backup-preview'], note: 'Private datasets are never read by the hub.' },
  { id: 'rfnexus', name: 'RF Nexus static preview', where: 'Cloud Run service rf-nexus-preview', url: 'https://rf-nexus-preview-vxx5lz7c5a-wl.a.run.app', about: 'A frozen export of the RF Nexus interface. No backend (API calls answer 503). Not part of RabbitOS.', check: [], fix: ['gcp-rfnexus-preview', 'gcp-rfnexus-run'], note: 'Moved from Cloudflare to Google Cloud on 2026-10-15; the Worker was deleted.' },
  { id: 'kubernetes', name: 'Kubernetes (optional)', where: 'Not created', url: '', about: 'A script is ready if it is ever wanted. Cloud Run covers today\'s needs.', check: [], fix: ['gcp-gke-preview'], note: 'Billed while it exists.' },
])

export const BASIC_TOOLS = Object.freeze({
  everywhere: ['ls, cd, cat, less, head, tail, grep, find, sed, awk', 'git, curl, jq, tar, unzip', 'node and npm, python3 and pip, pwsh (PowerShell 7)'],
  guest_helpers: [
    { tool: 'rabbit-save / rabbit-restore', use: 'keep files from ~/work across sessions (guest sandbox)' },
    { tool: 'ledger', use: 'print the public ledger head and events' },
    { tool: 'repos', use: 'list the public code under /workspace (read-only)' },
    { tool: 'rabbit-net check', use: 'check the sandbox can reach the allowed hosts' },
  ],
  owner_scripts: ['pwsh -File scripts/powershell/Setup-Gcp*.ps1 -WhatIf  (preview any Google Cloud change)', 'npm run test:auth, npm run lint, npx tsc --noEmit  (rabbit-web checks)', 'cd workers/<name> && npm test  (a Worker\'s own tests)'],
})

const TOPICS = ['overview', 'services', 'tools', 'commands', 'shells', 'agents', 'research', 'troubleshooting']
export const HELP_TOPICS = TOPICS

const idsFor = (catalog, role, ids) => ids.map((id) => catalog.get(role, id)).filter(Boolean).map((e) => ({ id: e.id, label: e.label, command: e.command, risk: e.risk }))

export function helpFor(topic, catalog, role = 'guest') {
  const owner = role === 'owner'
  switch (topic ?? 'overview') {
    case 'overview': return {
      topic: 'overview', role,
      what: 'RabbitOS (app.rabbitsoftware.io) and rabbitsoftware.io on Cloudflare, with Supabase as the database and Google Cloud for the visitor shell, this hub, standby, backups, monitoring, the status feed and the weekly audit. The owner\'s computer holds the research agents, the Maxwell chain and personal data (which never leaves it).',
      topics: TOPICS.map((t) => ({ topic: t, ask: `hub_help {"topic":"${t}"}` })),
      first_steps: ['hub_briefing for the rules', 'hub_status to see what answers right now', 'hub_help services for who does what', 'commands_search with your role and a few words to find a command', 'command_draft to check any command before a person runs it'],
      nothing_runs_itself: 'No hub tool runs a command or writes data. A person pastes and presses Enter.',
    }
    case 'services': return {
      topic: 'services', role,
      services: SERVICES.map((s) => ({
        id: s.id, name: s.name, where: s.where, url: s.url || null, about: s.about, note: s.note,
        check_with: idsFor(catalog, role, s.check),
        ...(owner ? { fix_or_change_with: idsFor(catalog, role, s.fix) } : { owner_commands: s.fix.length ? 'ask the owner; these need their computer and credentials' : null }),
      })),
    }
    case 'tools': return {
      topic: 'tools', role, basic: BASIC_TOOLS,
      languages: owner ? LANGUAGES.owner : LANGUAGES.guest, not_installed: owner ? undefined : LANGUAGES.guest_not_installed,
      mcp_tools: 'tools/list on the hub lists every tool with its schema; all are read-only.',
    }
    case 'commands': return {
      topic: 'commands', role, counts: catalog.counts(), groups: catalog.groups(role),
      how: ['commands_search {"role":"' + role + '","q":"words"}', 'commands_list with a group', 'command_get with an id', 'command_draft to check your own line'],
      where_they_run: owner ? 'Owner commands run on the owner\'s computer from the repo root (or the owner shell for non-deploy ones). Deploys, migrations and secrets are by hand.' : `Guest commands run in the sandbox at ${GUEST_URL}.`,
    }
    case 'shells': return {
      topic: 'shells', role,
      guest: { url: GUEST_URL, rules: 'Human check, one terminal per address, 15 idle minutes (typing or output counts), 60 in total. Work in ~/work; /workspace is read-only. Network only to the allowlist and the hub.', agents: 'claude, gemini, copilot with your own key entered in the API keys drawer; they reach this hub through MCP.' },
      owner: { url: OWNER_SHELL_URL, rules: 'Cloudflare Access sign-in. Non-deploy commands only; deploys are run by the owner on their computer.' },
    }
    case 'agents': return {
      topic: 'agents', role, coding_agents: CODING_AGENTS, other_agents: OTHER_AGENTS,
      how_they_use_the_hub: 'Each is configured with the MCP server rabbitos-hub. Start with hub_briefing, then hub_help.',
    }
    case 'research': return {
      topic: 'research', role,
      read_stored: ['research_feed', 'data_rows {"dataset":"research_records"}', 'concept_lookup', 'chain_events'],
      search_live: 'research_search {"source":"pubmed|europepmc|clinicaltrials|openfda|openalex|inspirehep","query":"..."}; research_link {"query":"..."} searches several sources and links the answer to RabbitOS, Maxwell and Google Cloud',
      explain: 'research_sources shows the whole flow from public sources to the shell.',
      commands: idsFor(catalog, role, ['hub-research-sources', 'hub-research-pubmed', 'hub-research-feed']),
    }
    case 'troubleshooting': return {
      topic: 'troubleshooting', role,
      steps: [
        'Open https://rabbitsoftware.io/status.html. If its report is old, the recorder stopped.',
        'Run hub_status, then hub_selftest.',
        'Chain copies disagree: chain_consistency; the owner re-runs the daily backup job.',
        'Guest shell broken on Google Cloud: the owner switches it back to Cloudflare (gcp-switch-shell-cloudflare).',
        'Hub key leaked: the owner revokes it (hub-key-revoke).',
        'Anything else: read the weekly audit report, or ask the owner.',
      ],
      owner_commands: owner ? idsFor(catalog, role, ['gcp-switch-shell-cloudflare', 'hub-key-revoke', 'gcp-daily-backups']) : 'owner role only',
    }
    default: return null
  }
}
