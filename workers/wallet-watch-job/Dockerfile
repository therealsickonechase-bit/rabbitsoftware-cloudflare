# Wallet watcher for Cloud Run. No dependencies, no secrets. Build context is this folder, with the code staged in ./app by Setup-GcpWalletWatch.ps1.
FROM node:22-bookworm-slim
WORKDIR /app
COPY app ./
USER node
ENV NODE_ENV=production
CMD ["node", "wallet-watch.mjs"]
