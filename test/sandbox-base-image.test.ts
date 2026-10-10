import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the sandbox base permits Claude Code's required install script", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /npm install -g --allow-scripts=@anthropic-ai\/claude-code/);
});

test("the sandbox base replaces npm's vulnerable bundled dependencies", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  const nodeRuntime = dockerfile.match(/FROM node:[\s\S]*?(?=\nFROM ubuntu:)/)?.[0];
  const npmFix = nodeRuntime?.match(/RUN npm install -g[\s\S]*?&& rm -rf \/root\/\.npm/)?.[0];
  const finalStage = dockerfile.match(/FROM ubuntu:[\s\S]*/)?.[0];

  assert.ok(npmFix);
  assert.ok(finalStage);
  assert.match(npmFix, /\bbrace-expansion@5\.0\.12\b/);
  assert.match(npmFix, /\bip-address@10\.7\.1\b/);
  for (const [name, version] of [
    ["http-cache-semantics", "4.3.0"],
    ["undici", "6.28.1"],
  ]) {
    assert.ok(npmFix.includes(`${name}@${version}`));
    assert.ok(npmFix.includes(`/usr/local/lib/node_modules/npm/node_modules/${name}`));
    assert.ok(npmFix.includes(`/tmp/npm-fixes/node_modules/${name}`));
    assert.ok(finalStage.includes(`["${name}", "${version}"]`));
  }
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
  assert.match(dockerfile, /ARG X_MOD_VERSION=0\.41\.0/);
  assert.match(dockerfile, /^FROM golang:1\.26\.9-alpine@sha256:[a-f0-9]{64} AS gh-builder$/m);
  assert.match(dockerfile, /ARG GOPROXY=https:\/\/proxy\.golang\.org,direct/);
  assert.match(dockerfile, /ARG PIP_INDEX_URL=https:\/\/pypi\.org\/simple/);
  assert.match(dockerfile, /GOPROXY="\$GOPROXY" go mod download/);
  assert.match(dockerfile, /go get "golang\.org\/x\/mod@v\$\{X_MOD_VERSION\}"/);
  assert.match(dockerfile, /go get[^\n]*golang\.org\/x\/net@v0\.60\.0\b/);
  assert.match(dockerfile, /go version -m \/usr\/local\/bin\/gh \| grep -Eq/);
  assert.match(localBuild, /--build-arg "GOPROXY=\$\{GOPROXY\}"/);
  assert.match(localBuild, /--build-arg "PIP_INDEX_URL=\$\{PIP_INDEX_URL\}"/);
});

test("the sandbox base replaces browser-use's vulnerable anyio and pypdf pins", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  const browserRuntime = dockerfile.match(/ARG BROWSER_USE_VERSION=[\s\S]*?(?=\nRUN agent_site=)/)?.[0];

  assert.ok(browserRuntime);
  assert.match(browserRuntime, /s\/anyio==4\.12\.1\/anyio==4\.14\.2\/g/);
  assert.match(browserRuntime, /importlib\.metadata\.version\('anyio'\) == '4\.14\.2'/);
  assert.match(browserRuntime, /s\/pypdf==6\.10\.2\/pypdf==6\.19\.0\//);
  assert.match(browserRuntime, /importlib\.metadata\.version\('pypdf'\) == '6\.19\.0'/);
});

test("the sandbox base patches pip's vendored urllib3 and its inventory", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  const pipRuntime = dockerfile.slice(dockerfile.indexOf("RUN agent_site="));

  assert.match(pipRuntime, /urllib3==2\.8\.0/);
  assert.match(pipRuntime, /rm -rf[^\n]*"\$agent_site\/pip\/_vendor\/urllib3"/);
  assert.match(pipRuntime, /cp -a[\s\S]*?\/tmp\/pip-vendor-fix\/urllib3[\s\S]*?"\$agent_site\/pip\/_vendor\/"/);
  assert.match(pipRuntime, /s\/urllib3==2\.7\.0\/urllib3==2\.8\.0\//);
  assert.match(pipRuntime, /pkg:pypi\/urllib3@2\.8\.0/);
  assert.match(pipRuntime, /assert urllib3\.__version__ == "2\.8\.0"/);
  assert.match(pipRuntime, /pip index versions pip/);
});
