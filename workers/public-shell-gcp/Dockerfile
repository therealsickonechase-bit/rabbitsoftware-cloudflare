# Cloud Run visitor terminal. Build context is the workers/ folder:
#   docker build -f workers/public-shell-gcp/Dockerfile workers
# Same tools, agent notes and visitor account as workers/public-shell (Cloudflare), plus the Node PTY server. No secrets are copied in.

FROM node:22-bookworm-slim AS pty-build
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/workers/public-shell-gcp
COPY public-shell-gcp/package.json ./
RUN npm install --omit=dev --ignore-scripts=false --fetch-retries=6 --fetch-retry-mintimeout=3000 && npm cache clean --force

FROM node:22-bookworm-slim
USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ripgrep vim nano curl jq python3 python3-pip python3-venv ca-certificates \
      build-essential make zip unzip tree sqlite3 tmux less util-linux libicu72 libssl3 \
 && rm -rf /var/lib/apt/lists/*

# Pinned CLIs (same versions as the Cloudflare image).
ARG GEMINI_CLI_VERSION=0.64.0
ARG CLAUDE_CODE_VERSION=2.1.285
ARG COPILOT_CLI_VERSION=1.0.89
# The CLIs ship their native binary as an OPTIONAL platform package; npm ignores a failed download of an optional package, which once produced
# empty claude/copilot installs. So: retry the fetches, and fail the build unless all three CLIs really run.
RUN npm install -g --fetch-retries=6 --fetch-retry-mintimeout=3000 --fetch-timeout=120000 "@google/gemini-cli@${GEMINI_CLI_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@github/copilot@${COPILOT_CLI_VERSION}" \
 && npm cache clean --force
RUN gemini --version && claude --version && copilot --version

# PowerShell 7 from the official tarball, checked against its SHA256.
ARG POWERSHELL_VERSION=7.6.6
ARG POWERSHELL_SHA256=ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc
RUN curl -fsSL -o /tmp/powershell.tar.gz "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz" \
 && echo "${POWERSHELL_SHA256}  /tmp/powershell.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/microsoft/powershell/7 && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
 && chmod 0755 /opt/microsoft/powershell/7/pwsh && rm -f /tmp/powershell.tar.gz
COPY public-shell/container/pwsh /usr/local/bin/pwsh

RUN useradd --create-home --home-dir /home/visitor --shell /bin/bash --uid 1500 visitor

# Read-only public code, same clean snapshot as the Cloudflare image (run scripts/prepare-workspace.ps1 first).
COPY public-shell/workspace-src/ /workspace/
RUN test -d /workspace/rabbit-web && test -d /workspace/rabbitsoftware-site \
 && for d in /workspace/rabbit-web /workspace/rabbitsoftware-site; do \
      rm -rf "$d/.git" "$d/.claude" "$d/.agents" "$d/backup" "$d/supabase" "$d/node_modules"; \
      find "$d" \( -name '.env' -o -name '.env.*' -o -name '.dev.vars*' -o -name '*.pem' -o -name '*.key' -o -name '*.sqlite' -o -name '*.db' \) -delete; \
    done \
 && chown -R root:root /workspace && chmod -R a-w,a+rX /workspace

COPY public-shell/container/motd /etc/rabbitos-motd
COPY public-shell/container/ledger /usr/local/bin/ledger
COPY public-shell/container/repos /usr/local/bin/repos
COPY public-shell/container/help-rabbit /usr/local/bin/help-rabbit
COPY public-shell/container/rabbit-net /usr/local/bin/rabbit-net
COPY public-shell/container/rabbit-save /usr/local/bin/rabbit-save
COPY public-shell/container/rabbit-restore /usr/local/bin/rabbit-restore
COPY public-shell/container/bashrc /home/visitor/.bashrc
COPY public-shell/container/agent-context.md /tmp/agent-context.md
RUN mkdir -p /home/visitor/.claude /home/visitor/.gemini /home/visitor/.copilot /home/visitor/work \
 && cp /tmp/agent-context.md /home/visitor/.claude/CLAUDE.md && cp /tmp/agent-context.md /home/visitor/.gemini/GEMINI.md \
 && cp /tmp/agent-context.md /home/visitor/.copilot/copilot-instructions.md && cp /tmp/agent-context.md /home/visitor/AGENTS.md \
 && rm -f /tmp/agent-context.md \
 && printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /home/visitor/.bash_profile \
 && chown -R visitor:visitor /home/visitor \
 && chmod 0755 /usr/local/bin/ledger /usr/local/bin/repos /usr/local/bin/help-rabbit /usr/local/bin/rabbit-net /usr/local/bin/pwsh /usr/local/bin/rabbit-save /usr/local/bin/rabbit-restore \
 && chmod 0444 /etc/rabbitos-motd

# The terminal server runs as root (it must start the shell as the visitor account); the visitor cannot read its files or environment.
WORKDIR /app/workers/public-shell-gcp
COPY --from=pty-build /app/workers/public-shell-gcp/node_modules ./node_modules
COPY public-shell-gcp/package.json ./
COPY public-shell-gcp/src ./src
COPY public-shell/src/env.mjs public-shell/src/limits.mjs /app/workers/public-shell/src/
RUN chmod -R go-rwx /app

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.mjs"]
