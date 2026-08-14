FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci
COPY plugins/web-ui/index.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /chassis/src
RUN npm run build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
WORKDIR /app
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci --omit=dev && rm package-lock.json \
  && rm -rf /root/.npm /tmp/node-compile-cache /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY plugins/web-ui/server ./server
COPY plugins/chassis/src /chassis/src
COPY --from=build /app/dist-web ./dist-web

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.ts"]
