FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app

COPY plugins/admin/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/admin/public ./public
COPY plugins/admin/tsconfig.json ./

ARG PKG_REFRESH_WEEK=
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked apk upgrade \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
  && printf 'os packages refreshed for week %s\n' "${PKG_REFRESH_WEEK:-unknown}"

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
