# The weekly audit as a Cloud Run job. No dependencies and no secrets: it reads public pages and writes one report to a bucket with the job's own identity.
#   docker build -t qa-audit workers/qa-audit
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY data ./data
USER node
ENV NODE_ENV=production
CMD ["node", "src/run.mjs", "--out", "/tmp/out"]
