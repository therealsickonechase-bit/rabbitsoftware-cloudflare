# RabbitOS Research Agent (A2A) for Cloud Run. No dependencies, no secrets. Build context is this folder; Setup-GcpResearchAgent.ps1 puts the hub's research.mjs next to server.mjs first.
FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs research.mjs ./
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
