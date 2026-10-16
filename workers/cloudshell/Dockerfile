FROM docker.io/cloudflare/sandbox:0.13.0-next.776.1
RUN mkdir -p /workspace

# Gemini CLI for the owner shell (same pinned version as the guest sandbox). It needs GEMINI_API_KEY, which the Worker passes ONLY to working-session commands
# (see src/session.mts); no key is stored in the image. Settings: no telemetry, no self-update, and the read-only RabbitOS hub tools.
ARG GEMINI_CLI_VERSION=0.64.0
RUN npm install -g --fetch-retries=6 --fetch-retry-mintimeout=3000 --fetch-timeout=120000 "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
 && npm cache clean --force \
 && gemini --version
COPY container/gemini-settings.json /root/.gemini/settings.json
COPY container/GEMINI.md /root/.gemini/GEMINI.md
