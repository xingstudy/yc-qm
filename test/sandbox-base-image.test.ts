import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the sandbox base permits Claude Code's required install script", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /npm install -g --allow-scripts=@anthropic-ai\/claude-code/);
});

test("the sandbox base replaces npm's vulnerable bundled tar", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  const nodeRuntime = dockerfile.match(/FROM node:[\s\S]*?(?=\nFROM ubuntu:)/)?.[0];
  const npmFix = nodeRuntime?.match(/RUN npm install -g[\s\S]*?&& rm -rf \/root\/\.npm/)?.[0];
  const finalStage = dockerfile.match(/FROM ubuntu:[\s\S]*/)?.[0];

  assert.ok(npmFix);
  assert.ok(finalStage);
  assert.match(npmFix, /npm install --prefix \/tmp\/npm-fixes[\s\S]*?\btar@7\.5\.22/);
  assert.match(npmFix, /rm -rf[\s\S]*?\/usr\/local\/lib\/node_modules\/npm\/node_modules\/tar/);
  assert.match(
    npmFix,
    /cp -a[\s\S]*?\/tmp\/npm-fixes\/node_modules\/tar[\s\S]*?\/usr\/local\/lib\/node_modules\/npm\/node_modules\//,
  );
  assert.match(
    finalStage,
    /RUN claude --version[\s\S]*?node -e 'const tar = require\("\/usr\/local\/lib\/node_modules\/npm\/node_modules\/tar"\); const \{ version \} = require\("\/usr\/local\/lib\/node_modules\/npm\/node_modules\/tar\/package\.json"\); if \(!tar \|\| version !== "7\.5\.22"\) throw new Error\(`unexpected tar version \$\{version\}`\)'/,
  );
});

test("the sandbox base builds a patched GitHub CLI", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  const localBuild = readFileSync(new URL("../scripts/local-sandbox-build.sh", import.meta.url), "utf8");
  assert.match(dockerfile, /ARG GH_VERSION=2\.99\.0/);
  assert.match(dockerfile, /ARG X_MOD_VERSION=0\.40\.0/);
  assert.match(dockerfile, /ARG GOPROXY=https:\/\/proxy\.golang\.org,direct/);
  assert.match(dockerfile, /ARG PIP_INDEX_URL=https:\/\/pypi\.org\/simple/);
  assert.match(dockerfile, /GOPROXY="\$GOPROXY" go mod download/);
  assert.match(dockerfile, /go get "golang\.org\/x\/mod@v\$\{X_MOD_VERSION\}"/);
  assert.match(dockerfile, /go version -m \/usr\/local\/bin\/gh \| grep -Eq/);
  assert.match(localBuild, /--build-arg "GOPROXY=\$\{GOPROXY\}"/);
  assert.match(localBuild, /--build-arg "PIP_INDEX_URL=\$\{PIP_INDEX_URL\}"/);
});

test("the sandbox base replaces browser-use's vulnerable anyio pin", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  const browserRuntime = dockerfile.match(/ARG BROWSER_USE_VERSION=[\s\S]*?(?=\nRUN agent_site=)/)?.[0];

  assert.ok(browserRuntime);
  assert.match(browserRuntime, /s\/anyio==4\.12\.1\/anyio==4\.14\.2\/g/);
  assert.match(browserRuntime, /importlib\.metadata\.version\('anyio'\) == '4\.14\.2'/);
});
