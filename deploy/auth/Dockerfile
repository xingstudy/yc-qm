FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

WORKDIR /app

COPY plugins/auth/package.json plugins/auth/package-lock.json ./
RUN npm ci --omit=dev \
  && rm -rf /root/.npm /tmp/node-compile-cache /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY plugins/auth/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/auth/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
