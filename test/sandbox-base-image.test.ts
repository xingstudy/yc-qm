import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the sandbox base permits Claude Code's required install script", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /npm install -g --allow-scripts=@anthropic-ai\/claude-code/);
});

test("the sandbox base builds a patched GitHub CLI", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /ARG GH_VERSION=2\.98\.0/);
  assert.match(dockerfile, /ARG X_MOD_VERSION=0\.40\.0/);
  assert.match(dockerfile, /go get "golang\.org\/x\/mod@v\$\{X_MOD_VERSION\}"/);
  assert.match(dockerfile, /go version -m \/usr\/local\/bin\/gh \| grep -Eq/);
});
