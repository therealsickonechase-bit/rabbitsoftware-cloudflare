# Maxwell Core in a container. Works on amd64 and arm64 (Raspberry Pi 4/5 with a 64-bit OS), because the base image is multi-architecture and there are no dependencies.
#   docker build -t maxwell-core maxwell-core
#   docker run -d --name maxwell-core -v maxwell-data:/data --restart unless-stopped maxwell-core            # private node (RPC on 127.0.0.1 inside the container)
#   docker exec maxwell-core node maxwell-core.mjs cli getblockchaininfo
# Public read-only gateway (Cloud Run, or a home server you want others to query):
#   docker run -p 8645:8645 maxwell-core serve --public --bind 0.0.0.0 --port 8645
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json maxwell-core.mjs witness.mjs ./
ENV NODE_ENV=production MAXWELL_DATADIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
ENTRYPOINT ["node", "maxwell-core.mjs"]
CMD ["serve"]
