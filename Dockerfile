# Build from the repository root: docker build -t diffity .

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.3.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/
COPY packages/parser/package.json packages/parser/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# The workspace packages are bundled into dist; only the server's own dependencies are installed.
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @diffity/server

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin diffity \
  && mkdir -p /data \
  && chown diffity:diffity /data
# The same layout as the install: packages/server/node_modules links into /app/node_modules/.pnpm.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/packages/server/node_modules /app/packages/server/node_modules
COPY --from=build /app/packages/server/package.json /app/packages/server/package.json
COPY --from=build /app/packages/server/dist /app/packages/server/dist
WORKDIR /app/packages/server
ENV NODE_ENV=production \
  DIFFITY_DATA_DIR=/data \
  DIFFITY_BIND=0.0.0.0 \
  PORT=5390
USER diffity
EXPOSE 5390
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 5390) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
