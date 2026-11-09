#!/bin/sh
set -eu

npm install --global --ignore-scripts npm@12.0.2
hash -r
npm install --prefix /tmp/npm-fixes --ignore-scripts --omit=dev \
  brace-expansion@5.0.12 ip-address@10.7.5 http-cache-semantics@4.3.0 undici@6.29.1 tar@7.5.22
npm_site="$(npm root -g)/npm/node_modules"
for name in brace-expansion ip-address http-cache-semantics undici tar; do
  rm -rf "$npm_site/$name"
  cp -a "/tmp/npm-fixes/node_modules/$name" "$npm_site/"
done
NPM_SITE="$npm_site" node -e 'for (const [name, version] of Object.entries({"brace-expansion":"5.0.12","ip-address":"10.7.5","http-cache-semantics":"4.3.0",undici:"6.29.1",tar:"7.5.22"})) { const installed = require(`${process.env.NPM_SITE}/${name}/package.json`).version; if (installed !== version) throw new Error(`${name}: ${installed}`); }'
npm --version
npx --version
rm -rf /tmp/npm-fixes /root/.npm
