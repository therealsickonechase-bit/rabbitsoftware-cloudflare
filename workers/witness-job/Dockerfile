# The cloud witness as a Cloud Run job. No dependencies. The key arrives as the environment variable WITNESS_KEY_PEM from Secret Manager; nothing secret is in the image.
# Setup-GcpWitness.ps1 copies scripts/witness.mjs next to this file before building, so the job runs exactly the public script.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json run.mjs witness.mjs ./
USER node
ENV NODE_ENV=production
CMD ["node", "run.mjs"]
