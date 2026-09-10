FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS core-base

WORKDIR /app

ARG NPM_INSTALL_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared npm ci --omit=dev --prefer-offline --no-audit --libc=musl --registry="${NPM_INSTALL_REGISTRY}" \
  && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 node_modules/opencode-linux-* \
  && test -x node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude \
  && node_modules/.bin/opencode --version
COPY licenses/earendil-works-pi-coding-agent.LICENSE /usr/share/licenses/qm/pi-coding-agent.LICENSE
RUN mkdir -p /data && chown node:node /data

ARG PKG_REFRESH_WEEK=
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    --mount=type=cache,target=/root/.npm,sharing=shared \
    apk upgrade \
  && apk add ca-certificates curl git git-daemon docker-cli \
  && npm audit --omit=dev --audit-level=moderate --registry=https://registry.npmjs.org \
  && rm -rf /tmp/node-compile-cache /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
  && printf 'os packages refreshed and dependencies audited for week %s\n' "${PKG_REFRESH_WEEK:-unknown}"

ENV NODE_ENV=production
ENV DATA_DIR=/data

FROM core-base AS core

COPY src ./src
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis
COPY scripts/production-preflight.ts ./scripts/production-preflight.ts
COPY tsconfig.json ./

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
EXPOSE 8080

USER node
CMD ["node", "src/index.ts"]
