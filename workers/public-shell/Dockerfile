# Public visitor sandbox. Same Sandbox SDK line as workers/cloudshell (0.13.0-next.776.1). No secrets are ever copied in.
FROM docker.io/cloudflare/sandbox:0.13.0-next.776.1

USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ripgrep vim nano curl jq python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Node is already in the base image; verify rather than assume.
# The Copilot CLI needs Node 22+: fail the build if the base image's Node is older.
RUN node --version && npm --version \
 && node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"

# Pinned CLIs. Versions checked on the npm registry on 2026-10-14 and each is more than two weeks old.
# Bump deliberately: npm view <pkg>@<version> version
ARG GEMINI_CLI_VERSION=0.62.0
ARG CLAUDE_CODE_VERSION=2.1.285
# @github/copilot 1.0.89 was published 2026-09-28 (16 days before 2026-10-14); 1.0.90 and later were under 14 days old.
ARG COPILOT_CLI_VERSION=1.0.89
RUN npm install -g "@google/gemini-cli@${GEMINI_CLI_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@github/copilot@${COPILOT_CLI_VERSION}" \
 && npm cache clean --force

# PowerShell 7 (`pwsh`), installed from the official release tarball and checked against its SHA256 in the build.
# v7.6.6 was published 2026-09-08 (36 days before 2026-10-14); v7.6.7 (2026-10-13) is too new. The digest below is the one GitHub shows for the asset
# powershell-7.6.6-linux-x64.tar.gz on https://github.com/PowerShell/PowerShell/releases/tag/v7.6.6 (it matches the SHA256 in the release notes).
# Bump deliberately: change both values together from the release page. Never copy a checksum from anywhere else.
ARG POWERSHELL_VERSION=7.6.6
ARG POWERSHELL_SHA256=ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc
RUN curl -fsSL -o /tmp/powershell.tar.gz "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz" \
 && echo "${POWERSHELL_SHA256}  /tmp/powershell.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/microsoft/powershell/7 \
 && tar -xzf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
 && chmod 0755 /opt/microsoft/powershell/7/pwsh \
 && rm -f /tmp/powershell.tar.gz
COPY container/pwsh /usr/local/bin/pwsh

# Unprivileged account for the visitor's terminal. The Sandbox control server keeps running as root; the PTY is started via `runuser -u visitor`.
RUN useradd --create-home --home-dir /home/visitor --shell /bin/bash --uid 1500 visitor

# Read-only public code only, copied from a clean snapshot made by scripts/prepare-workspace.ps1 (committed files only, no git history,
# no .env, no .claude, personal email redacted, credential scan passed). Run that script before `wrangler deploy`.
# rabbitsoftware-cloudflare: only the static site is taken.
COPY workspace-src/ /workspace/
RUN test -d /workspace/rabbit-web && test -d /workspace/rabbitsoftware-site \
 && for d in /workspace/rabbit-web /workspace/rabbitsoftware-site; do \
      rm -rf "$d/.git" "$d/.claude" "$d/.agents" "$d/backup" "$d/supabase" "$d/node_modules"; \
      find "$d" \( -name '.env' -o -name '.env.*' -o -name '.dev.vars*' -o -name '*.pem' -o -name '*.key' -o -name '*.sqlite' -o -name '*.db' \) -delete; \
    done \
 && chown -R root:root /workspace && chmod -R a-w,a+rX /workspace

COPY container/motd /etc/rabbitos-motd
COPY container/ledger /usr/local/bin/ledger
COPY container/repos /usr/local/bin/repos
COPY container/help-rabbit /usr/local/bin/help-rabbit
COPY container/rabbit-net /usr/local/bin/rabbit-net
COPY container/bashrc /home/visitor/.bashrc
RUN chmod 0755 /usr/local/bin/ledger /usr/local/bin/repos /usr/local/bin/help-rabbit /usr/local/bin/rabbit-net /usr/local/bin/pwsh \
 && printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > /home/visitor/.bash_profile \
 && chown visitor:visitor /home/visitor/.bashrc /home/visitor/.bash_profile \
 && chmod 0444 /etc/rabbitos-motd
