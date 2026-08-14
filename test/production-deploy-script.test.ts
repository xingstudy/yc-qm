import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

const imageEntries = [
  ["QM_CORE_IMAGE", "qm-core", "1"],
  ["QM_WEB_UI_IMAGE", "qm-web-ui", "2"],
  ["QM_ADMIN_IMAGE", "qm-admin", "3"],
  ["QM_PORTAL_IMAGE", "qm-portal", "4"],
  ["QM_AUTH_IMAGE", "qm-auth", "5"],
  ["QM_EDGE_IMAGE", "qm-edge", "6"],
  ["QM_SANDBOX_IMAGE", "qm-sandbox-local", "7"],
] as const;

function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

test("the production deployer verifies a versioned digest lock before running Compose", () => {
  const directory = mkdtempSync("/tmp/qm-production-deploy-");
  try {
    const deployment = join(directory, "deployment");
    const scripts = join(deployment, "scripts");
    const release = join(directory, "release");
    const bin = join(directory, "bin");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(release);
    mkdirSync(bin);
    copyFileSync("scripts/deploy-production-release.sh", join(scripts, "deploy-production-release.sh"));
    const envFile = join(deployment, ".env.production");
    writeFileSync(envFile, "QM_RELEASE_TAG=prod-v1.2.3\nQM_COMPOSE_PROJECT=qm\nQM_POSTGRES_VOLUME=qm_postgres-data\n");
    chmodSync(envFile, 0o600);
    writeFileSync(
      join(release, "compose.production.yaml"),
      "name: ${QM_COMPOSE_PROJECT}\nservices:\n  core:\n    image: ${QM_CORE_IMAGE}\nvolumes:\n  postgres-data:\n    name: ${QM_POSTGRES_VOLUME}\n",
    );
    writeFileSync(join(release, "release.production.tag"), "prod-v1.2.3\n");
    const manifest = imageEntries
      .map(([name, repository, digit]) => `${name}=docker.io/lijixing/${repository}@sha256:${digit.repeat(64)}`)
      .join("\n");
    writeFileSync(join(release, "images.production.env"), `${manifest}\n`);
    writeFileSync(join(release, "images.production.json"), "{}\n");
    writeFileSync(
      join(release, "SHA256SUMS"),
      execFileSync(
        "sha256sum",
        ["compose.production.yaml", "release.production.tag", "images.production.env", "images.production.json"],
        { cwd: release },
      ),
    );
    writeFileSync(join(release, "SHA256SUMS.bundle"), "verified bundle fixture\n");
    const dockerLog = join(directory, "docker.log");
    const cosignLog = join(directory, "cosign.log");
    executable(
      join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
cp "$QM_TEST_RELEASE_DIR/\${url##*/}" "$output"
`,
    );
    executable(
      join(bin, "cosign"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$QM_TEST_COSIGN_LOG"
`,
    );
    executable(
      join(bin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "compose version" ]]; then
  exit 0
fi
printf 'QM_CORE_IMAGE=%s QM_POSTGRES_VOLUME=%s QM_RELEASE_TAG=%s\n' "\${QM_CORE_IMAGE-unset}" "\${QM_POSTGRES_VOLUME-unset}" "\${QM_RELEASE_TAG-unset}" >> "$QM_TEST_DOCKER_LOG"
printf '%s\n' "$*" >> "$QM_TEST_DOCKER_LOG"
`,
    );
    execFileSync("bash", [join(scripts, "deploy-production-release.sh"), envFile], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QM_CORE_IMAGE: `docker.io/attacker/qm-core@sha256:${"a".repeat(64)}`,
        QM_POSTGRES_VOLUME: "attacker-postgres",
        QM_RELEASE_TAG: "prod-v9.9.9",
        QM_RELEASE_BASE_URL: "https://release.example.test",
        QM_TEST_COSIGN_LOG: cosignLog,
        QM_TEST_DOCKER_LOG: dockerLog,
        QM_TEST_RELEASE_DIR: release,
      },
      stdio: "pipe",
    });

    const lockedRelease = join(deployment, ".releases", "prod-v1.2.3");
    const lockFile = join(lockedRelease, "images.production.env");
    assert.equal(statSync(lockFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(lockFile, "utf8"), `${manifest}\n`);
    const cosignCalls = readFileSync(cosignLog, "utf8");
    assert.match(cosignCalls, /^verify-blob /m);
    assert.equal(cosignCalls.match(/^verify docker\.io\/lijixing\//gm)?.length, 7);
    const dockerCalls = readFileSync(dockerLog, "utf8");
    assert.doesNotMatch(dockerCalls, /attacker|prod-v9\.9\.9/);
    assert.equal(dockerCalls.match(/^QM_CORE_IMAGE=unset QM_POSTGRES_VOLUME=unset QM_RELEASE_TAG=unset$/gm)?.length, 4);
    assert.match(dockerCalls, new RegExp(`--env-file ${envFile} --env-file ${lockFile}`));
    assert.match(dockerCalls, / config --quiet$/m);
    assert.match(dockerCalls, / pull$/m);
    assert.match(dockerCalls, / up -d --wait --pull never --remove-orphans$/m);
    assert.match(dockerCalls, / ps$/m);

    const beforePrepare = readFileSync(dockerLog, "utf8").length;
    execFileSync("bash", [join(scripts, "deploy-production-release.sh"), envFile, "prepare"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QM_RELEASE_BASE_URL: "https://release.example.test",
        QM_TEST_COSIGN_LOG: cosignLog,
        QM_TEST_DOCKER_LOG: dockerLog,
        QM_TEST_RELEASE_DIR: release,
      },
      stdio: "pipe",
    });
    const prepareCalls = readFileSync(dockerLog, "utf8").slice(beforePrepare);
    assert.match(prepareCalls, / pull$/m);
    assert.doesNotMatch(prepareCalls, / up -d /m);

    rmSync(join(bin, "curl"));
    rmSync(join(bin, "cosign"));
    const beforeApply = readFileSync(dockerLog, "utf8").length;
    execFileSync("bash", [join(scripts, "deploy-production-release.sh"), envFile, "apply"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QM_TEST_DOCKER_LOG: dockerLog,
      },
      stdio: "pipe",
    });
    const applyCalls = readFileSync(dockerLog, "utf8").slice(beforeApply);
    assert.doesNotMatch(applyCalls, / pull$/m);
    assert.match(applyCalls, / up -d --wait --pull never --remove-orphans$/m);

    execFileSync("bash", [join(scripts, "deploy-production-release.sh"), envFile, "down"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QM_RELEASE_BASE_URL: "https://release.example.test",
        QM_TEST_COSIGN_LOG: cosignLog,
        QM_TEST_DOCKER_LOG: dockerLog,
        QM_TEST_RELEASE_DIR: release,
      },
      stdio: "pipe",
    });
    assert.match(readFileSync(dockerLog, "utf8"), / down --remove-orphans$/m);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
