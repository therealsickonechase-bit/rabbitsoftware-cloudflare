# The cloud backup as a Cloud Run job. pg_dump must be the same major version as Supabase's Postgres (17), so it comes from the PostgreSQL apt repository.
#   gcloud builds submit workers/backup-job --tag us-west2-docker.pkg.dev/rabbitsoftware-io/rabbit-software/backup-job:latest
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_ENV=production
CMD ["node", "src/run.mjs"]
