import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("core deploy image includes git", () => {
  const dockerfile = readFileSync(join(repoRoot, "deploy/core/Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /\bapk\s+add\b[\s\S]*\bgit\b/,
    "core hosts deployment git repos over git http-backend, which needs git in the image",
  );
  assert.match(
    dockerfile,
    /npm audit --omit=dev --audit-level=moderate/,
    "the production dependency threshold is a build gate",
  );
  assert.match(dockerfile, /npm ci[\s\S]*--libc=musl/);
  assert.match(
    dockerfile,
    /rm -rf node_modules\/@anthropic-ai\/claude-agent-sdk-linux-x64 node_modules\/opencode-linux-\*/,
  );
  assert.match(dockerfile, /test -x node_modules\/@anthropic-ai\/claude-agent-sdk-linux-x64-musl\/claude/);
  assert.match(dockerfile, /node_modules\/\.bin\/opencode --version/);
  assert.doesNotMatch(dockerfile, /patch-pi-shrinkwrap/, "the dependency layer should be lockfile-only");
  assert.match(
    dockerfile,
    /COPY cli\/templates\/slack-manifest\.json \.\/cli\/templates\/slack-manifest\.json/,
    "admin Slack setup needs the canonical manifest at runtime",
  );
  for (const line of dockerfile.split("\n").filter((candidate) => candidate.startsWith("COPY "))) {
    const sources = line.trim().split(/\s+/).slice(1, -1);
    for (const source of sources) {
      assert.equal(existsSync(join(repoRoot, source)), true, `core Dockerfile COPY source does not exist: ${source}`);
    }
  }
});

test("scheduled OS refreshes cannot invalidate production payload layers", () => {
  const productionDockerfiles = [
    "deploy/portal/Dockerfile",
    "deploy/auth/Dockerfile",
    "deploy/web-ui/Dockerfile",
    "deploy/admin/Dockerfile",
    "deploy/edge/Dockerfile",
  ];
  for (const path of productionDockerfiles) {
    const dockerfile = readFileSync(join(repoRoot, path), "utf8");
    const refresh = dockerfile.lastIndexOf("ARG PKG_REFRESH_WEEK");
    assert.notEqual(refresh, -1, `${path} must schedule OS refreshes`);
    assert.ok(dockerfile.lastIndexOf("COPY ") < refresh, `${path} must refresh after its final payload copy`);
    const productionInstall = dockerfile.lastIndexOf("npm ci --omit=dev");
    if (productionInstall !== -1) {
      assert.ok(productionInstall < refresh, `${path} must install production dependencies before its refresh layer`);
    }
  }

  const core = readFileSync(join(repoRoot, "deploy/core/Dockerfile"), "utf8");
  const baseStage = core.indexOf(" AS core-base");
  const runtimeStage = core.indexOf("FROM core-base AS core");
  const refresh = core.indexOf("ARG PKG_REFRESH_WEEK");
  assert.notEqual(baseStage, -1);
  assert.ok(baseStage < refresh);
  assert.ok(refresh < runtimeStage);
  assert.ok(runtimeStage < core.indexOf("COPY src ./src"));
  assert.ok(core.indexOf("npm audit --omit=dev --audit-level=moderate") > refresh);
});

test("deploy image package installs reuse BuildKit caches", () => {
  const npmDockerfiles = [
    "deploy/core/Dockerfile",
    "deploy/portal/Dockerfile",
    "deploy/auth/Dockerfile",
    "deploy/web-ui/Dockerfile",
    "deploy/egress-proxy/Dockerfile",
  ];
  for (const path of npmDockerfiles) {
    const dockerfile = readFileSync(join(repoRoot, path), "utf8");
    const installs = dockerfile.split("\n").filter((line) => line.includes("npm ci"));
    assert.notEqual(installs.length, 0, `${path} must install dependencies`);
    for (const install of installs) {
      assert.match(install, /--mount=type=cache,target=\/root\/\.npm,sharing=shared/);
      assert.match(install, /--prefer-offline/);
      assert.match(install, /--registry=/);
    }
    assert.doesNotMatch(dockerfile, /rm -rf \/root\/\.npm/);
  }

  const apkDockerfiles = [
    "deploy/core/Dockerfile",
    "deploy/portal/Dockerfile",
    "deploy/auth/Dockerfile",
    "deploy/web-ui/Dockerfile",
    "deploy/admin/Dockerfile",
    "deploy/edge/Dockerfile",
  ];
  for (const path of apkDockerfiles) {
    const dockerfile = readFileSync(join(repoRoot, path), "utf8");
    assert.match(dockerfile, /--mount=type=cache,target=\/var\/cache\/apk,sharing=locked[\s\S]*?apk upgrade/);
  }
});
