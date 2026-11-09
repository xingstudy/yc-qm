import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the canonical and packaged MicroVM Dockerfiles stay snapshot-safe and executable", () => {
  const canonical = readFileSync(new URL("../../aws/microvm-agent/Dockerfile", import.meta.url), "utf8");
  const packaged = readFileSync(new URL("../templates/aws/microvm-agent/Dockerfile", import.meta.url), "utf8");
  assert.equal(packaged, canonical);
  for (const file of [
    "patch-pip-vendor.sh",
    "patch-npm.sh",
    "litestream.go.mod",
    "litestream.go.sum",
    "build-files.json",
    "awscli-constraints.txt",
  ]) {
    assert.equal(
      readFileSync(new URL(`../templates/aws/microvm-agent/${file}`, import.meta.url), "utf8"),
      readFileSync(new URL(`../../aws/microvm-agent/${file}`, import.meta.url), "utf8"),
    );
  }
  assert.equal(
    readFileSync(new URL("../templates/aws/microvm-agent/agent.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../../aws/microvm-agent/agent.mjs", import.meta.url), "utf8"),
  );
  assert.match(canonical, /^FROM public\.ecr\.aws\/lambda\/microvms:al2023-minimal@sha256:[a-f0-9]{64}$/m);
  assert.match(canonical, /^FROM golang:1\.26\.10-alpine@sha256:[a-f0-9]{64} AS gh-builder$/m);
  assert.match(canonical, /ARG GH_VERSION=2\.99\.0/);
  assert.match(canonical, /ARG X_MOD_VERSION=0\.41\.0/);
  assert.match(canonical, /go get "golang\.org\/x\/mod@v\$\{X_MOD_VERSION\}"/);
  assert.match(canonical, /go get[^\n]*golang\.org\/x\/net@v0\.62\.0\b/);
  assert.match(canonical, /go version -m \/usr\/local\/bin\/gh \| grep -Eq/);
  assert.match(canonical, /COPY --from=gh-builder \/usr\/local\/bin\/gh \/usr\/local\/bin\/gh/);
  assert.match(canonical, /dnf install -y --releasever=latest[\s\\]+curl-minimal\b/);
  assert.doesNotMatch(canonical, /cli\.github\.com\/packages\/rpm/);
  assert.doesNotMatch(canonical, /dnf install -y gh-/);
  assert.match(canonical, /codeload\.github\.com\/aws\/aws-cli\/tar\.gz\/refs\/tags\/2\.39\.6/);
  assert.match(canonical, /[a-f0-9]{64} {2}\/tmp\/awscli\.tgz" \| sha256sum -c -/);
  assert.match(canonical, /urllib3==2\.8\.0/);
  assert.match(canonical, /pip install --no-cache-dir -c \/tmp\/awscli-constraints\.txt/);
  assert.match(canonical, /rpm -q openssl-snapsafe-libs/);
  assert.match(canonical, /dnf upgrade -y --releasever=latest/);
  assert.match(canonical, /COPY --from=litestream-build \/out\/litestream/);
  assert.match(canonical, /GOTOOLCHAIN=local/);
  assert.match(canonical, /go build -mod=readonly/);
  assert.doesNotMatch(canonical, /litestream\/releases\/download/);
  assert.match(canonical, /pip==26\.2\.2/);
  assert.match(canonical, /sh \/tmp\/patch-pip-vendor\.sh/);
  assert.match(canonical, /sh \/tmp\/patch-npm\.sh/);
  assert.match(canonical, /\bnodejs24\b/);
  assert.match(canonical, /\bnodejs24-npm\b/);
  for (const command of ["npm --version", "npx --version", "setsid --version", "seq 1 1"])
    assert.match(canonical, new RegExp(command));
});
