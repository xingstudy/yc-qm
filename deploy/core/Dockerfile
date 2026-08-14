FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

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
