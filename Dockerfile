# syntax=docker/dockerfile:1

FROM node:22.23.1-bookworm-slim AS workspace
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/engine/package.json apps/engine/package.json

FROM workspace AS development-dependencies
RUN npm ci

FROM development-dependencies AS server-build
COPY apps/engine apps/engine
COPY apps/server apps/server
RUN npm run build --workspace @second-brain/engine
RUN npm run build --workspace @second-brain/server

FROM development-dependencies AS admin-build
COPY apps/admin apps/admin
RUN npm run build --workspace @second-brain/admin

FROM workspace AS production-dependencies
RUN npm ci --omit=dev --ignore-scripts \
      --workspace @second-brain/engine \
      --workspace @second-brain/server \
  && npm cache clean --force

FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/engine

COPY --from=production-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=server-build --chown=node:node /app/apps/engine/dist ./dist
COPY --from=server-build --chown=node:node /app/apps/server/dist /app/apps/server/dist
COPY --from=admin-build --chown=node:node /app/apps/admin/dist /app/admin-ui
COPY --chown=node:node apps/engine/package.json apps/engine/invokta.mcp.json ./
COPY --chown=node:node apps/server/package.json /app/apps/server/package.json
COPY --chown=node:node apps/engine/drizzle ./drizzle

USER node
EXPOSE 3000 3001 3002
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node /app/apps/engine/dist/healthcheck.js

CMD ["node", "dist/mcp-http.js"]
