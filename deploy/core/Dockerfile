FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

ARG PKG_REFRESH_WEEK=
RUN apk upgrade --no-cache \
  && printf 'os packages refreshed for week %s\n' "${PKG_REFRESH_WEEK:-unknown}"

RUN apk add --no-cache ca-certificates curl git git-daemon docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=moderate \
  && rm -rf /root/.npm /tmp/node-compile-cache /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY licenses/earendil-works-pi-coding-agent.LICENSE /usr/share/licenses/qm/pi-coding-agent.LICENSE

COPY src ./src
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis
COPY scripts/production-preflight.ts ./scripts/production-preflight.ts
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080

USER node
CMD ["node", "src/index.ts"]
