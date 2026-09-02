FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

ARG PKG_REFRESH_WEEK=
RUN apk upgrade --no-cache \
  && printf 'os packages refreshed for week %s\n' "${PKG_REFRESH_WEEK:-unknown}"

WORKDIR /app

COPY plugins/portal/package.json plugins/portal/package-lock.json ./
RUN npm ci --omit=dev \
  && rm -rf /root/.npm /tmp/node-compile-cache /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY plugins/portal/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/portal/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
