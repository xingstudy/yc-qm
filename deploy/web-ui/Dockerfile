FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
ARG WEB_UI_BASE=/
ARG NPM_INSTALL_REGISTRY=https://registry.npmjs.org
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared npm ci --prefer-offline --no-audit --registry="${NPM_INSTALL_REGISTRY}"
COPY plugins/web-ui/index.html plugins/web-ui/shared.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /chassis/src
RUN npm run build

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app
ARG NPM_INSTALL_REGISTRY=https://registry.npmjs.org
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared npm ci --omit=dev --prefer-offline --no-audit --registry="${NPM_INSTALL_REGISTRY}" && rm package-lock.json
COPY plugins/web-ui/server ./server
COPY plugins/web-ui/src/app-edit.ts ./src/app-edit.ts
COPY plugins/admin/src /admin/src
RUN ln -s /app/node_modules /admin/node_modules
COPY plugins/admin/public /admin/public
COPY plugins/chassis/src /chassis/src
COPY --from=build /app/dist-web ./dist-web

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
CMD ["node", "server/index.ts"]
