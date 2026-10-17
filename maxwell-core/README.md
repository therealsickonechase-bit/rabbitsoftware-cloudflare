# Maxwell Core

A node for the Maxwell chain, in the shape of Bitcoin Core: it keeps a verified local copy of the chain, answers questions about it over a local RPC (and a REST interface), and can sign the head it verified as a **witness**. One program, no dependencies, Node.js 22 or newer. It runs on a Raspberry Pi, any Linux, macOS or Windows, in Docker, or in the cloud.

It is a **read-only** node: it never mines and holds no secret that can change the chain. The project's own design is in `docs/maxwell-core.md`.

## What it needs

| | |
|---|---|
| Memory | about 30 MB while running (measured), a 300 MB limit is set in the service |
| Disk | a few hundred KB for the chain, plus a small state file |
| Network | outbound HTTPS only. Nothing listens beyond `127.0.0.1` unless you start the public gateway on purpose |
| Raspberry Pi | a Pi 4 or 5 with a **64-bit** OS (Raspberry Pi OS 64-bit or Ubuntu). A Pi 3 or a 32-bit OS has no official Node.js 22 build |
| Always on | that is the point of a Pi here: it keeps time while your main PC sleeps |

## Install on a Raspberry Pi or any Linux with systemd

1. **Node.js 22 or newer.** Download the Linux build for your machine from <https://nodejs.org/en/download> (choose *Linux ARM64* for a 64-bit Pi) and put `node` on your path, or use your distribution's package if it is 22 or newer. Check with `node -v`.
2. **Get this folder** (`maxwell-core/` from the `rabbitsoftware-cloudflare` repository) onto the machine.
3. **Look first, then install:**
   ```
   sudo ./install.sh --dry-run
   sudo ./install.sh
   ```
   It checks Node, creates a system user `maxwell` (no login), copies the program to `/opt/maxwell-core`, creates the data folder `/var/lib/maxwell`, installs a hardened systemd service, and adds the `maxwell-cli` command.
4. **Try it** (the first sync takes a few seconds):
   ```
   systemctl status maxwell-core
   maxwell-cli getblockchaininfo
   maxwell-cli verifychain
   maxwell-cli getblock 12
   ```
   Bitcoin Core users will recognise the names: `getblockcount`, `getbestblockhash`, `getblockhash`, `getblock`, `getblockheader`, `getblockchaininfo`, `getchaintips`, `getmininginfo`, `getnetworkinfo`, `getpeerinfo` (peers are the registered witnesses), `uptime`, `help`, plus `getwitnessinfo` and `getanchorinfo`.

Update by pulling the new folder and running `sudo ./install.sh` again. Remove with `sudo ./install.sh --uninstall` (add `--purge` to delete the data folder).

## Docker (amd64 and arm64)

```
docker build -t maxwell-core .
docker run -d --name maxwell-core -v maxwell-data:/data --restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL maxwell-core
docker exec maxwell-core node maxwell-core.mjs cli getblockchaininfo
```
or `docker compose up -d`. On a Pi use the same commands (the base image is multi-architecture).

## The public read-only gateway

For a website or a shared tool to read the chain you can run a gateway: it serves **only public chain data**, has no cookie or secret, allows CORS, and limits each client to 120 requests a minute.

```
node maxwell-core.mjs serve --public --bind 0.0.0.0 --port 8645
curl http://127.0.0.1:8645/rest/chaininfo.json
curl http://127.0.0.1:8645/rest/block/12.json
curl -s -X POST http://127.0.0.1:8645/ -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}'
```
REST routes: `/rest/chaininfo.json`, `nodeinfo`, `mininginfo`, `chaintips`, `peers`, `witnesses`, `anchors`, `/rest/block/<height or hash>.json`, `/rest/blockhashbyheight/<n>.json`. Put a reverse proxy with TLS in front before exposing it to the internet. Owner methods (`sync`, `stop`) are never available on it.

The project runs one on Google Cloud (see `docs/maxwell-core.md`); from the RabbitOS cloud shell: `curl -s <that address>/rest/chaininfo.json`.

## Becoming a witness

A witness checks the chain independently and signs the head it verified, so others can see how many separate parties agree (`docs/peer-review.md`).

```
node witness.mjs keygen --name mynode          # makes mynode.key (private) and mynode.pub (public)
sudo install -o maxwell -g maxwell -m 0600 mynode.key /var/lib/maxwell/witness/mynode.key
sudo -u maxwell node /opt/maxwell-core/maxwell-core.mjs witness --name mynode --datadir /var/lib/maxwell
sudo systemctl enable --now maxwell-core-witness.timer      # every 6 hours; edit WITNESS_NAME in the service if your name differs
```
Publish `/var/lib/maxwell/witness/mynode.cosignature.json` at an https address and send a pull request adding your public key and that address to `site/witness/registry.json`.

## Safety, in short

The private RPC listens on `127.0.0.1` only and every call needs the cookie in the data folder (mode 600, owned by the service user); it refuses wrong `Host` headers (DNS-rebinding) and any request that carries a browser `Origin`. A chain that is invalid, shorter, or contradicts the one already stored is refused and flagged, never adopted. The service runs as an unprivileged user with no capabilities, a read-only filesystem except its own data folder, and a memory limit. The program writes nowhere else.

## Tests

`workers/qa-audit/test/maxwell-core.test.mjs` (run with `npm test` in `workers/qa-audit`). Beyond the unit tests this version was run in Linux containers: amd64 and arm64 (emulated), unprivileged with a read-only root filesystem; the installer on a clean Debian, including `systemd-analyze verify` on the units.
