# Public shell on GCP (Cloud Run)

A visitor terminal that runs on Google Cloud, so GCP credits pay for the compute. The Cloudflare Worker `public-shell` keeps Turnstile, quotas and the session
token; this service only runs a terminal. **Status: server and image written and tested locally. Nothing is deployed and the Worker does not use it yet.**

## How it works
- One WebSocket to `/pty` = one `bash -l` as the unprivileged `visitor` user (uid 1500). When the session ends the process exits, so Cloud Run starts a clean
  instance for the next visitor. A second connection to the same instance gets 409.
- The Worker signs a short token (`protocol.mjs`, HMAC with `PTY_BRIDGE_SECRET`, at least 32 characters) and sends `{t:'start', cols, rows, keys}` first, then `{t:'i'}` input and
  `{t:'r'}` resize frames. Output comes back as binary frames. Visitor API keys travel only in the start frame and are validated by `public-shell/src/env.mjs`.
- Limits are the same as the Cloudflare version (`public-shell/src/limits.mjs`): 15 idle minutes (typing OR terminal output counts as activity, so a running build or coding agent is not idle), 60 minutes total, 32 MiB of output, 16 KiB frames. The Worker prints a warning 5 and 1 minute before the time limit and 2 minutes before the idle limit.

## Run it locally
```
docker build -f workers/public-shell-gcp/Dockerfile workers -t rabbit-shell-gcp
docker run --rm -p 8080:8080 -e PTY_BRIDGE_SECRET=<32+ random characters> rabbit-shell-gcp
PTY_URL=ws://localhost:8080/pty PTY_BRIDGE_SECRET=<same> node workers/public-shell-gcp/scripts/smoke.mjs
```
Unit tests: `npm test` in this folder (`node --test`, no network).

## Network safety (required before this is public)
A Cloud Run container can reach the whole internet by default, and a public shell must not. The design that fits the budget:
1. Cloud Run with **Direct VPC egress, route all traffic through the VPC**, service account with **no roles**.
2. A VPC egress firewall that **denies everything except TCP 3128 to one small proxy VM** (and blocks the metadata server for tokens).
3. A **Squid proxy on an e2-micro** that allows `CONNECT` only to the fixed host list in `public-shell/src/egress.mjs`, port 443, and logs denials. The container gets `HTTPS_PROXY` from
   `EGRESS_PROXY_URL`; because the firewall allows nothing else, unsetting the variable gains the visitor nothing.
4. Max 6 instances, concurrency 1, request timeout 60 minutes (the Cloud Run maximum; it must stay at least as long as the session limit, or Cloud Run cuts the terminal first).

Not built yet: the VPC, the firewall rules, the proxy VM, the Cloud Run service, the Worker bridge to this service, and the secret. Each is a separate, reviewed step.
