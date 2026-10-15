# RF Nexus static preview for Cloud Run. No dependencies, no secrets. Build context is this folder, with the three reviewed files staged in ./public by Setup-GcpRfNexus.ps1.
FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs ./
COPY public ./public
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
