# syntax=docker/dockerfile:1
#
# Sealround gas relayer (apps/relayer) as a container image.
#
# Build from the REPOSITORY ROOT: the pnpm lockfile and workspace file live
# there, so the build context must be the root, not apps/relayer.
#
#   docker build -f apps/relayer/Dockerfile -t sealround-relayer .
#
# Configuration comes from environment variables only (apps/relayer/README.md,
# "Configuration"). The image holds no .env file and no key. The relayer
# listens on $PORT (default 8787). GET /policy answers without touching the
# chain; GET /health reads the relayer's balance over RPC.
#
# The relayer imports no workspace package, so only its own manifest, sources
# and the root lockfile are copied in.

ARG NODE_BUILD_IMAGE=node:24-slim
ARG NODE_RUNTIME_IMAGE=node:24-alpine
ARG PNPM_VERSION=12.3.4

# ---------------------------------------------------------------------------
# Build: install from the lockfile, compile src/ to dist/, then reinstall
# production dependencies only.
# ---------------------------------------------------------------------------
FROM ${NODE_BUILD_IMAGE} AS build
ARG PNPM_VERSION
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relayer/package.json apps/relayer/
RUN pnpm install --frozen-lockfile --filter @fairground/relayer

COPY apps/relayer/tsconfig.json apps/relayer/tsconfig.build.json apps/relayer/
COPY apps/relayer/src apps/relayer/src
RUN pnpm --filter @fairground/relayer build

# Same lockfile, production dependencies only (hono, @hono/node-server, borsh, near-api-js).
RUN rm -rf node_modules apps/relayer/node_modules \
 && pnpm install --frozen-lockfile --prod --prefer-offline --filter @fairground/relayer

# ---------------------------------------------------------------------------
# Runtime: Node 24 on Alpine, non-root, compiled JavaScript only.
# pnpm links apps/relayer/node_modules/* to ../../node_modules/.pnpm with
# relative symlinks, so both folders keep their place under /app.
# ---------------------------------------------------------------------------
FROM ${NODE_RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/relayer/node_modules ./apps/relayer/node_modules
COPY --from=build /repo/apps/relayer/package.json ./apps/relayer/package.json
COPY --from=build /repo/apps/relayer/dist ./apps/relayer/dist

WORKDIR /app/apps/relayer
# The files stay owned by root and read-only to the process.
USER node
EXPOSE 8787
# Local `docker run` only; hosts use their own checks. /policy needs no RPC call.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/policy').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/main.js"]
