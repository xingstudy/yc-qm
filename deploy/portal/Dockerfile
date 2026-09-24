FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app

ARG NPM_INSTALL_REGISTRY=https://registry.npmjs.org
COPY plugins/portal/package.json plugins/portal/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared npm ci --omit=dev --prefer-offline --no-audit --registry="${NPM_INSTALL_REGISTRY}"

COPY plugins/auth/package.json plugins/auth/package-lock.json /auth/
RUN --mount=type=cache,target=/root/.npm,sharing=shared npm ci --prefix /auth --omit=dev --prefer-offline --no-audit --registry="${NPM_INSTALL_REGISTRY}"

COPY plugins/portal/src ./src
COPY plugins/auth/src /auth/src
COPY plugins/chassis/src /chassis/src
COPY plugins/portal/tsconfig.json ./

ARG PKG_REFRESH_RUN_ID=
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked apk upgrade --no-cache \
  && rm -rf /tmp/node-compile-cache /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
  && printf 'os packages refreshed for run %s\n' "${PKG_REFRESH_RUN_ID:-unknown}"

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
RUN apk add --no-cache util-linux
USER node
CMD ["node", "src/index.ts"]
