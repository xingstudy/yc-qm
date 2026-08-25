import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the canonical and packaged MicroVM Dockerfiles stay snapshot-safe and executable", () => {
  const canonical = readFileSync(new URL("../../aws/microvm-agent/Dockerfile", import.meta.url), "utf8");
  const packaged = readFileSync(new URL("../templates/aws/microvm-agent/Dockerfile", import.meta.url), "utf8");
  assert.equal(packaged, canonical);
  assert.equal(
    readFileSync(new URL("../templates/aws/microvm-agent/agent.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../../aws/microvm-agent/agent.mjs", import.meta.url), "utf8"),
  );
  assert.match(canonical, /^FROM public\.ecr\.aws\/lambda\/microvms:al2023-minimal@sha256:[a-f0-9]{64}$/m);
  assert.match(canonical, /^FROM golang:1\.26\.6-alpine@sha256:[a-f0-9]{64} AS gh-builder$/m);
  assert.match(canonical, /ARG GH_VERSION=2\.98\.0/);
  assert.match(canonical, /ARG X_MOD_VERSION=0\.40\.0/);
  assert.match(canonical, /go get "golang\.org\/x\/mod@v\$\{X_MOD_VERSION\}"/);
  assert.match(canonical, /go version -m \/usr\/local\/bin\/gh \| grep -Eq/);
  assert.match(canonical, /COPY --from=gh-builder \/usr\/local\/bin\/gh \/usr\/local\/bin\/gh/);
  assert.match(canonical, /dnf install -y[\s\\]+curl-minimal\b/);
  assert.match(canonical, /awscli-exe-linux-aarch64-\d+\.\d+\.\d+\.zip/);
  assert.match(canonical, /[a-f0-9]{64} {2}\/tmp\/awscliv2\.zip" \| sha256sum -c -/);
  assert.match(canonical, /rpm -q openssl-snapsafe-libs/);
  assert.match(canonical, /\bnodejs24\b/);
  assert.match(canonical, /\bnodejs24-npm\b/);
  for (const command of ["npm --version", "npx --version", "setsid --version", "seq 1 1"])
    assert.match(canonical, new RegExp(command));
});
