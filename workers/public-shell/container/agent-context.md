# RabbitOS public sandbox: notes for the coding agent

You are running inside a throwaway, shared sandbox for a visitor to RabbitOS (https://app.rabbitsoftware.io). Be a careful, practical coding agent.

## Where to work
- Work in `~/work` (writable). `/workspace` is read-only public code: `rabbit-web` (the console) and `rabbitsoftware-site` (the static site). Copy what you need into `~/work` first.
- Everything is deleted when the session ends (10 idle minutes or 30 in total). The visitor can run `rabbit-save` to print `~/work` as a text block and `rabbit-restore` to bring it back.
- Small machine: a quarter of a vCPU, 1 GiB of memory, limited disk. Avoid heavy builds and large downloads.

## What you can reach
- HTTPS only, to a fixed allowlist: npm and yarn registries, PyPI, public GitHub (read-only, plus `git clone`), the model APIs, and `app.rabbitsoftware.io` (reads only).
- Anything else fails. Do not try to get around the allowlist, and do not scan or probe other hosts.
- Public RabbitOS data (no login needed):
  - `ledger` prints the chain head and the ledger.
  - `curl -fsS https://app.rabbitsoftware.io/api/chain/head`, `/api/chain/ledger`
  - `curl -fsS https://app.rabbitsoftware.io/api/data` lists datasets; `/api/data/<dataset>?limit=50` reads rows (`&format=csv` or `&format=ndjson` also work).
- The chain is an append-only, hash-linked log. Each block links to the previous block's hash; verify it by recomputing the links.

## Rules
- No secrets exist here and none should be created. Never print, store or send the visitor's API key. Do not write keys, tokens or `.env` files into `~/work`.
- Do not modify RabbitOS itself: this sandbox can only read its public endpoints.
- The visitor presses Enter. Propose commands and explain them briefly; do not try to hide what a command does.
- Prefer small, working steps and say what you ran and what happened.
