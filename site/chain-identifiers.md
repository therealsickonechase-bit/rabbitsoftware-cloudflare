# Chain and Block Identifiers

Use this guide when an agent needs to cite or prepare a read-only inventory of an
existing chain. Do not invent a universal `chain_id`: the project has several
formats, and some do not define one. A block index, event ID, block hash, chain
name, account scope, snapshot digest, and release fingerprint identify different
things and must not be substituted for one another.

## Existing Formats

| System | Chain identifier | Block, entry, or event identifiers | Source of truth |
| --- | --- | --- | --- |
| Local node chains | Node ID plus the local `chain_node-N.json` path; there is no global network chain ID | Node block `index` and `block_hash`; signed payloads also carry an `event_id` | Verified node chain files under local `autonomous/node-N/` state |
| Replicated research ledger | Ledger replica node ID; one logical event can be present on multiple replicas | Research `event_id`; origin node and `origin_index`; originating block `hash_hex`; `replicas` lists local copies | `research_viewer.collect()` merges local ledgers and verifies each replica |
| Maxwell proof-of-work chain | A chain file/instance and its verified genesis-to-tip linkage; the format has no explicit global `chain_id` | `block_number`, `hash`, `previous_hash`; `miner_id` is a label, not authenticated identity | Existing Maxwell chain file after `MaxwellChainAgent.validate_chain()` |
| Account-scoped DNA chain | Chain `name` within a registered account scope; never expose the account identifier in public metadata | Entry `index`, `previous_hash`, and `hash` | Authenticated `/v1/dna/chain/{name}` response from the configured sync service |
| Legacy Maxwell archive | Content-addressed snapshot SHA-256; not a live consensus chain | Archived `block_number`, `hash`, `previous_hash` only | Existing legacy snapshot read through the signed account API |
| Bitcoin timestamp anchor | External network name `bitcoin`; the bridge does not expose a project chain ID | Anchor `height` and `block_hash`, plus source explorer | `external_chain_bridge.fetch_bitcoin_anchor()` and a validated `time_anchor` |
| Bitcoin/Ethereum tip observations | External network/source label; not RabbitSoftware chains | Bitcoin tip height; Ethereum block number. These observations alone do not identify a project block | `external_chain_bridge.py` public read result |

For shared research events, use the event ID to identify the event and the origin
node/index plus block hash to identify its containing block. A replica's local
ledger index is not the origin block index. For Maxwell, never call `miner_id` an
author signature. For DNA, do not copy account identifiers, device identifiers,
keys, or private entry data into public output.

## Authorship and License

Repository-authored chain implementations and adapters are attributed at the
source-code level to Chase Allen Ringquist under UPL-1.0, as declared in
[`NOTICE.md`](../NOTICE.md) and [`LICENSES.md`](../LICENSES.md). The release
manifest records the author, license scopes, commit, per-file Git-object hashes,
and project fingerprint. A `code_release` event records the fingerprint; it does
not publish source files, wallet information, or a new chain ID.

This attribution covers project code only. It does not claim authorship of user
records or payloads, external Bitcoin/Ethereum networks or blocks, or third-party
libraries. Blockchain-DNA is a project/tool name, not a separate network.

## Agent Rules

- Use only identifiers actually present in the named source of truth above. If a
  format has no chain ID, say so; do not derive, assign, or mint one.
- Do not create new chains, genesis blocks, wallet/address records, schemas, or
  templates for publishing chain metadata as part of an inventory task.
- Do not reverse-engineer third-party or private chains, agents, endpoints, or
  wallets. For project-owned code, inspect documented source and schemas only;
  do not bypass signatures, account scoping, permissions, or access controls.
- Do not put wallet secrets, private keys, recovery phrases, account/device IDs,
  personal data, or private block payloads in the author ledger or a public
  chain. A hash can still be identifying or sensitive.
- Prepare a local preview first. Before any remote read of sensitive/account
  data or any upload/write, name the exact service, account scope, object/prefix,
  fields, visibility, cost, and rollback. Wait for fresh approval for that exact
  operation. Never broadcast one generic author record to every configured
  bucket: backups, source mirrors, account sync, public model hosting, and
  metadata streams have different purposes and schemas.

## Cloud Destination Boundaries

These are documented/configured destinations, not an instruction to write to
them:

| Destination | Intended content | Do not use it for |
| --- | --- | --- |
| Cloudflare `rabbitsoftware-sync` R2 | Account-scoped encrypted history and explicitly approved checksum-addressed Maxwell/research/legacy snapshots | A global author directory or arbitrary wallet/block data |
| Cloudflare `DNA_BLOCKCHAIN` KV | Signed, account-scoped DNA chains through the existing authenticated API | Publicly asserting wallet ownership or copying another account's IDs |
| Cloudflare `rabbitsoftware-project-events` | Allowlisted, owner-approved metadata-only operation events | Raw blocks, chain payloads, wallet data, or new event types without schema review |
| AWS `network-os-backups-e2ff1a62` S3 | Encrypted `.dvault` backup objects and backup index | Plain author/license metadata or chain inventories |
| AWS `network-os-github-mirror-63b6d66e` S3 | The configured private Git bundle mirror | Separate chain payloads or wallet records |
| Hugging Face model repo | Released model artifact, model card, and version records with their applicable model license | Account chain data or wallet information |
| Hugging Face private datasets | Their specifically consented/reviewed training or knowledge data | Chain IDs, wallet data, or unscreened records |
| Cloudflare model gateway and Pages | Hosted inference API and reviewed static site assets | Private chain access or local wallet access |

The AWS inventory Lambda is implemented but undeployed. Bucket and Worker names
in this table do not establish current remote contents, authorization, or
permission to change them. Verify remote state only under an approved, exact
plan.
