# The hosted diffity server (packages/server). Build from the repository root:
#   docker build -t diffity-server .

FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/git/package.json packages/git/
COPY packages/github/package.json packages/github/
COPY packages/parser/package.json packages/parser/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/git/package.json packages/git/
COPY packages/github/package.json packages/github/
COPY packages/parser/package.json packages/parser/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
# The workspace packages are bundled into dist; only the server's npm dependencies are installed.
RUN npm ci --omit=dev --workspace @diffity/server --include-workspace-root=false --ignore-scripts

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin diffity \
  && mkdir -p /data \
  && chown diffity:diffity /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/packages/server/package.json ./package.json
COPY --from=build /src/packages/server/dist ./dist
ENV NODE_ENV=production \
  DIFFITY_DATA_DIR=/data \
  DIFFITY_BIND=0.0.0.0 \
  PORT=5390
USER diffity
VOLUME /data
EXPOSE 5390
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 5390) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
