FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

ARG PKG_REFRESH_WEEK=
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked apk upgrade \
  && printf 'os packages refreshed for week %s\n' "${PKG_REFRESH_WEEK:-unknown}"

WORKDIR /app

ARG NPM_INSTALL_REGISTRY=https://registry.npmjs.org
COPY plugins/auth/package.json plugins/auth/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared npm ci --omit=dev --prefer-offline --no-audit --registry="${NPM_INSTALL_REGISTRY}" \
  && rm -rf /tmp/node-compile-cache /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY plugins/auth/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/auth/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
