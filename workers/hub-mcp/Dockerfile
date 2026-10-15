# Hub MCP for Cloud Run. No dependencies, no secrets. Build context is this folder:
#   docker build -t rabbit-hub-mcp workers/hub-mcp
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY data ./data
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.mjs"]
