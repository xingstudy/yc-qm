import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function retryFunction(...workflows: string[]) {
  const bodies = workflows.flatMap((workflow) =>
    [...workflow.matchAll(/ {10}verify_with_retry\(\) \{\n(?<body>(?: {12}.*\n)+) {10}\}/g)].map(
      (match) => match.groups?.body,
    ),
  );
  const [body, ...others] = bodies;
  if (!body || others.some((other) => other !== body))
    throw new Error("inconsistent registry verification retry functions");
  return `verify_with_retry() {\n${body.replace(/^ {10}/gm, "")}}\nverify_with_retry "$@"`;
}

test("the release publishes signed images and never a package", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.doesNotMatch(workflow, /npm pack/);
  assert.doesNotMatch(workflow, /npm publish/);
  assert.doesNotMatch(workflow, /verify:release/);
  assert.doesNotMatch(workflow, /prepare-release-manifest/);
  assert.doesNotMatch(workflow, /^ {2}package:$/m);
  assert.match(workflow, /^ {2}image:$/m);
  assert.equal(existsSync(".github/workflows/release-images.yml"), false);
});

test("the release is the sole sandbox-base publisher and bakes in the browser engine", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.match(
    workflow,
    /- name: sandbox-base\n\s+dockerfile: fly\/Dockerfile\n\s+build-args: INSTALL_BROWSER_ENGINE=1\n/,
  );
  assert.match(workflow, /build-args: \$\{\{ matrix\.build-args \}\}/);
  assert.equal(existsSync(".github/workflows/publish-sandbox-base.yml"), false);
  assert.equal(existsSync(".github/workflows/publish-images.yml"), false);
});

test("the release signs private images without requiring anonymous registry access", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.doesNotMatch(workflow, /anonymously pullable|DOCKER_CONFIG="\$probe"/);
  assert.match(workflow, /permissions:\s+contents: read\s+packages: write\s+id-token: write/);
  assert.match(
    workflow,
    /docker\/login-action@[^\n]+\s+with:\s+registry: ghcr\.io\s+username: \$\{\{ github\.actor \}\}\s+password: \$\{\{ github\.token \}\}/,
  );
  assert.match(workflow, /platforms: linux\/amd64\s+provenance: false/);
  assert.match(
    workflow,
    /image='ghcr\.io\/yc-software\/qm\/\$\{\{ matrix\.name \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}'\s+cosign sign --yes "\$image"\s+verify_with_retry "\$image"/,
  );
  assert.ok(workflow.indexOf("docker/login-action") < workflow.indexOf("docker/build-push-action"));
  assert.ok(workflow.indexOf("docker/build-push-action") < workflow.indexOf("Sign exact image"));
});

test("the CLI package publishes publicly with provenance", () => {
  const manifest = JSON.parse(readFileSync("cli/package.json", "utf8")) as {
    private?: boolean;
    repository?: { url?: string; directory?: string };
    publishConfig?: { access?: string; provenance?: boolean };
    scripts?: Record<string, string>;
  };

  assert.equal(manifest.private, undefined);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.provenance, true);
  assert.equal(manifest.repository?.url, "git+https://github.com/yc-software/qm.git");
  assert.equal(manifest.repository?.directory, "cli");
  assert.equal(manifest.scripts?.["verify:release"], undefined);
  assert.equal(existsSync("cli/scripts/verify-release-manifest.mjs"), false);
  assert.equal(existsSync("scripts/prepare-release-manifest.mjs"), false);
});

test("publishing the CLI is a separate, attested, main-only operation", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^ {2}workflow_call:$/m);
  assert.doesNotMatch(workflow, /^ {2}push:$/m);
  assert.doesNotMatch(workflow, /^ {2}pull_request:$/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /permissions:\s+contents: read\s+id-token: write/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /packages: write/);
});

test("the published package pins real image digests, never the checked-in sentinel", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.ok(
    workflow.indexOf("Pin published image digests") < workflow.indexOf("npm publish"),
    "digests are resolved before the package is published",
  );
  assert.match(workflow, /for service in core web-ui admin portal auth sandbox-base; do/);
  assert.match(workflow, /printf '%s\\n' "\$out" > cli\/manifest\.json/);
  assert.match(workflow, /no published image for \$repo at \$IMAGES_REF/);
  assert.match(workflow, /\{63\}\$"\) \| not\)/);

  const sentinel = JSON.parse(readFileSync("cli/manifest.json", "utf8")) as {
    sandboxBase: string;
    services: Record<string, string>;
  };
  const refs = [sentinel.sandboxBase, ...Object.values(sentinel.services)];
  assert.equal(refs.length, 6);
  assert.ok(
    refs.every((ref) => ref.startsWith("registry.invalid/")),
    "the checked-in manifest stays a sentinel so a source checkout never pulls a stale digest",
  );
});

test("the release republishes nothing already on npm so a half-finished run can resume", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.match(workflow, /if npm view "@yc-software\/qm@\$version" version/);
  assert.ok(
    workflow.indexOf("npm view") < workflow.indexOf("npm publish --provenance"),
    "the already-published check guards the publish rather than following it",
  );
  assert.match(workflow, /manifest: \$\{\{ steps\.pin\.outputs\.manifest \}\}/);
});

test("one dispatchable workflow drives the whole release, main-only and in order", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /^on:\n {2}workflow_dispatch:$/m);
  assert.match(workflow, /releases are cut from main; this run is on \$GITHUB_REF/);
  assert.doesNotMatch(
    workflow,
    /^ {4}if: github\.ref == 'refs\/heads\/main'$/m,
    "a non-main dispatch fails loudly instead of skipping every job and reporting green",
  );
  assert.match(
    workflow,
    /^ {2}images:\n[\s\S]*?needs: preflight\n[\s\S]*?uses: \.\/\.github\/workflows\/release-package\.yml$/m,
  );
  assert.match(workflow, /^ {2}cli:\n[\s\S]*?needs: images\n[\s\S]*?uses: \.\/\.github\/workflows\/publish-cli\.yml$/m);
  assert.match(workflow, /^ {2}release:\n[\s\S]*?needs:\n {6}- preflight\n {6}- cli$/m);
  assert.match(workflow, /concurrency:\n {2}group: release\n {2}cancel-in-progress: false/);
});

test("the release refuses a tag it already published and writes the tag last", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /tag="v\$\(jq -r \.version cli\/package\.json\)"/);
  assert.match(workflow, /is already released; bump cli\/package\.json before releasing again/);
  assert.ok(
    workflow.indexOf("already released") < workflow.indexOf("gh release create"),
    "the tag gate runs before anything is published",
  );
  assert.match(workflow, /gh release create "\$TAG"/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /"images\.json#Pinned image digests"/);
});

test("the tag is created atomically at the released commit, never adopted from elsewhere", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(
    workflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/refs" \\\n\s+-f ref="refs\/tags\/\$TAG" -f sha="\$GITHUB_SHA"/,
  );
  assert.match(workflow, /--verify-tag/);
  assert.doesNotMatch(
    workflow,
    /--target/,
    "--target only names a commit when gh creates the tag itself, so a tag another actor raced in would silently win",
  );
  assert.ok(
    workflow.indexOf("git/refs") < workflow.indexOf("gh release create"),
    "the ref is created before the release so a duplicate tag fails the run",
  );
});

test("a resumed publish keeps npm only when it already pins the digests being released", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.match(workflow, /npm pack "@yc-software\/qm@\$version"/);
  assert.match(workflow, /tar -xzf "\$published\/\$tarball" -C "\$published" package\/manifest\.json/);
  assert.match(workflow, /is on npm pinning different image digests; bump the version/);
  assert.ok(
    workflow.indexOf("npm pack") < workflow.indexOf("keeping it"),
    "the published tarball is compared before the publish is skipped",
  );
});

test("only the tagging job may write to the repository", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  const writes = workflow.match(/^ {6}contents: write$/gm) ?? [];
  assert.equal(writes.length, 1);
  assert.match(workflow, /^ {2}release:\n[\s\S]*?permissions:\n {6}contents: write\n[\s\S]*?gh release create/m);
  assert.doesNotMatch(workflow, /packages: write\n {4}secrets: inherit/);
});

test("images are signed from a main ref, so the pinned cosign identity keeps verifying", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const images = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.match(release, /^on:\n {2}workflow_dispatch:$/m);
  assert.doesNotMatch(release, /^ {2}push:$/m);
  assert.match(release, /if \[ "\$GITHUB_REF" != refs\/heads\/main \]/);
  assert.match(images, /--certificate-identity='[^']*release-package\.yml@refs\/heads\/main'/);
});

test("production images publish through a separate Docker Hub workflow", () => {
  const workflow = readFileSync(".github/workflows/release-production-images.yml", "utf8");

  assert.match(workflow, /^name: Publish production images$/m);
  assert.match(workflow, /release_tag must use prod-vMAJOR\.MINOR\.PATCH/);
  assert.match(workflow, /production images are released from main/);
  assert.match(
    workflow,
    /docker\/login-action@[^\n]+\s+with:\s+registry: docker\.io\s+username: lijixing\s+password: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/,
  );
  assert.doesNotMatch(workflow, /:latest/);
  assert.doesNotMatch(workflow, /ghcr\.io/);
  assert.equal(workflow.match(/^ {4}environment: production-images$/gm)?.length, 4);
});

test("production release covers every pull-only image and explicitly targets x86_64", () => {
  const workflow = readFileSync(".github/workflows/release-production-images.yml", "utf8");

  for (const [name, dockerfile] of [
    ["core", "deploy/core/Dockerfile"],
    ["web-ui", "deploy/web-ui/Dockerfile"],
    ["admin", "deploy/admin/Dockerfile"],
    ["portal", "deploy/portal/Dockerfile"],
    ["auth", "deploy/auth/Dockerfile"],
    ["edge", "deploy/edge/Dockerfile"],
  ] as const) {
    assert.match(workflow, new RegExp(`- name: ${name}\\n\\s+dockerfile: ${dockerfile.replace("/", "\\/")}`));
  }
  assert.match(workflow, /^ {2}sandbox-base:$/m);
  assert.match(workflow, /^ {2}sandbox-local:$/m);
  assert.equal(workflow.match(/platforms: linux\/amd64/g)?.length, 3);
});

test("production version tags are promoted only after scan, signature, and complete digest verification", () => {
  const workflow = readFileSync(".github/workflows/release-production-images.yml", "utf8");
  const formalTag = /qm-\$\{name\}:\$\{RELEASE_TAG\}/;

  assert.match(workflow, /severity: HIGH,CRITICAL\s+ignore-unfixed: false\s+exit-code: 1/g);
  assert.match(workflow, /cosign sign --yes "\$image"/);
  assert.match(
    workflow,
    /for name in core web-ui admin portal auth edge sandbox-base sandbox-local; do\s+test -s "qm-\$\{name\}\.image"/,
  );
  assert.match(workflow, formalTag);
  assert.ok(
    workflow.indexOf("Verify complete signed digest set") < workflow.indexOf("Refuse conflicting version tags"),
  );
  assert.ok(workflow.indexOf("Refuse conflicting version tags") < workflow.indexOf("Promote verified digests"));
  assert.ok(workflow.indexOf("Promote verified digests") < workflow.indexOf("Create production release"));
  const beforePromotion = workflow.slice(0, workflow.indexOf("Promote verified digests"));
  assert.doesNotMatch(beforePromotion, /docker buildx imagetools create --tag/);
});

test("registry verification retries only delayed signature visibility with bounded exponential backoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-cosign-verify-retry-"));
  const log = join(directory, "log");
  const cosign = join(directory, "cosign");
  const sleep = join(directory, "sleep");

  writeFileSync(
    cosign,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$COSIGN_RETRY_LOG\"\nattempt=$(awk '/^verify / { count++ } END { print count + 0 }' \"$COSIGN_RETRY_LOG\")\nif [ \"$attempt\" -lt 3 ]; then\n  printf 'no signatures found\\n' >&2\n  exit 23\nfi\nprintf 'verified\\n'\n",
  );
  writeFileSync(sleep, '#!/usr/bin/env bash\nprintf \'sleep %s\\n\' "$1" >> "$COSIGN_RETRY_LOG"\n');
  chmodSync(cosign, 0o755);
  chmodSync(sleep, 0o755);

  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        retryFunction(
          readFileSync(".github/workflows/release-production-images.yml", "utf8"),
          readFileSync(".github/workflows/release-package.yml", "utf8"),
        ),
        "verify-with-retry",
        "registry.example/image@sha256:abc",
        "--certificate-identity=identity",
        "--certificate-oidc-issuer=issuer",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COSIGN_RETRY_LOG: log },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "verified\n");
    assert.equal(result.stderr, "no signatures found\n".repeat(2));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "verify registry.example/image@sha256:abc --certificate-identity=identity --certificate-oidc-issuer=issuer",
      "sleep 2",
      "verify registry.example/image@sha256:abc --certificate-identity=identity --certificate-oidc-issuer=issuer",
      "sleep 4",
      "verify registry.example/image@sha256:abc --certificate-identity=identity --certificate-oidc-issuer=issuer",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registry verification fails non-retryable errors immediately", () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-cosign-verify-retry-"));
  const log = join(directory, "log");
  const cosign = join(directory, "cosign");
  const sleep = join(directory, "sleep");

  writeFileSync(
    cosign,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$COSIGN_RETRY_LOG\"\nprintf 'certificate validation failed\\n' >&2\nexit 41\n",
  );
  writeFileSync(sleep, '#!/usr/bin/env bash\nprintf \'sleep %s\\n\' "$1" >> "$COSIGN_RETRY_LOG"\n');
  chmodSync(cosign, 0o755);
  chmodSync(sleep, 0o755);

  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        retryFunction(
          readFileSync(".github/workflows/release-production-images.yml", "utf8"),
          readFileSync(".github/workflows/release-package.yml", "utf8"),
        ),
        "verify-with-retry",
        "registry.example/image@sha256:abc",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COSIGN_RETRY_LOG: log },
      },
    );

    assert.equal(result.status, 41);
    assert.equal(result.stderr, "certificate validation failed\n");
    assert.equal(readFileSync(log, "utf8"), "verify registry.example/image@sha256:abc\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registry verification stops after bounded delayed signature retries", () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-cosign-verify-retry-"));
  const log = join(directory, "log");
  const cosign = join(directory, "cosign");
  const sleep = join(directory, "sleep");

  writeFileSync(
    cosign,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$COSIGN_RETRY_LOG\"\nprintf 'no signatures found\\n' >&2\nexit 23\n",
  );
  writeFileSync(sleep, '#!/usr/bin/env bash\nprintf \'sleep %s\\n\' "$1" >> "$COSIGN_RETRY_LOG"\n');
  chmodSync(cosign, 0o755);
  chmodSync(sleep, 0o755);

  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        retryFunction(
          readFileSync(".github/workflows/release-production-images.yml", "utf8"),
          readFileSync(".github/workflows/release-package.yml", "utf8"),
        ),
        "verify-with-retry",
        "registry.example/image@sha256:abc",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COSIGN_RETRY_LOG: log },
      },
    );

    assert.equal(result.status, 23);
    assert.equal(result.stderr, "no signatures found\n".repeat(6));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "verify registry.example/image@sha256:abc",
      "sleep 2",
      "verify registry.example/image@sha256:abc",
      "sleep 4",
      "verify registry.example/image@sha256:abc",
      "sleep 8",
      "verify registry.example/image@sha256:abc",
      "sleep 16",
      "verify registry.example/image@sha256:abc",
      "sleep 32",
      "verify registry.example/image@sha256:abc",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every signed registry image uses the bounded verification helper", () => {
  const production = readFileSync(".github/workflows/release-production-images.yml", "utf8");
  const packageWorkflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.equal(production.match(/cosign sign --yes/g)?.length, 4);
  assert.equal(production.match(/verify_with_retry\(\) \{/g)?.length, 5);
  assert.equal(production.match(/verify_with_retry "\$(?:image|final)"/g)?.length, 5);
  assert.equal(production.match(/max_attempts=6/g)?.length, 5);
  assert.equal(production.match(/\[\[ "\$output" != \*"no signatures found"\* \]\]/g)?.length, 5);
  assert.equal(packageWorkflow.match(/cosign sign --yes/g)?.length, 1);
  assert.equal(packageWorkflow.match(/verify_with_retry\(\) \{/g)?.length, 1);
  assert.equal(packageWorkflow.match(/verify_with_retry "\$image"/g)?.length, 1);
  retryFunction(production, packageWorkflow);
});

test("production promotion is conflict-safe and retries the same digest idempotently", () => {
  const workflow = readFileSync(".github/workflows/release-production-images.yml", "utf8");

  assert.match(
    workflow,
    /if \[ "\$existing" != "\$expected" \]; then\s+echo "\$tag already points at a different digest"/,
  );
  assert.match(
    workflow,
    /if \[ "\$existing" != "\$expected" \]; then\s+docker buildx imagetools create --tag "\$tag" "\$image"/,
  );
  assert.match(workflow, /test "\$actual" = "\$expected"/);
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/refs"/);
  assert.equal(workflow.match(/git\/matching-refs\/tags\/\$RELEASE_TAG/g)?.length, 2);
  assert.match(workflow, /select\(\.ref == \$ref\) \| \.object\.sha/);
  assert.doesNotMatch(workflow, /git\/ref\/tags\/\$RELEASE_TAG" --jq \.object\.sha 2>\/dev\/null \|\| true/);
  assert.match(workflow, /reserved=\$\(gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$RELEASE_TAG"/);
  assert.match(workflow, /if \[ "\$reserved" != "\$RELEASE_SHA" \]/);
  assert.match(workflow, /if \[ "\$existing" != "\$RELEASE_SHA" \]/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /cmp -s "\$file" "\$directory\/\$\(basename "\$file"\)"/);
  assert.match(workflow, /cp scripts\/init-production-env\.sh init-production-env\.sh/);
  assert.match(workflow, /"images\.production\.env#Pinned Docker Hub production images"/);
  assert.match(workflow, /cosign sign-blob --yes --bundle SHA256SUMS\.bundle SHA256SUMS/);
  assert.match(workflow, /cosign verify-blob/);
});

test("a partial production promotion resumes the original signed digest artifacts", () => {
  const workflow = readFileSync(".github/workflows/release-production-images.yml", "utf8");

  assert.match(workflow, /^ {6}resume_run_id:$/m);
  assert.match(workflow, /if: inputs\.resume_run_id == ''/g);
  assert.match(workflow, /run-id: \$\{\{ inputs\.resume_run_id \}\}/);
  assert.match(workflow, /pattern: production-qm-\*-\$\{\{ inputs\.resume_run_id \}\}/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$RESUME_RUN_ID/);
  assert.match(workflow, /release_sha=\$\(jq -r \.head_sha <<< "\$run"\)/);
  assert.match(workflow, /ref: \$\{\{ needs\.preflight\.outputs\.release_sha \}\}/);
  assert.match(workflow, /printf 'release_sha=%s\\n' "\$release_sha" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /name: production-release-candidate-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /name: production-release-candidate-\$\{\{ inputs\.resume_run_id \}\}/);
  assert.match(workflow, /test "\$\(jq -r \.release_tag release-candidate\.json\)" = "\$RELEASE_TAG"/);
  assert.match(workflow, /retention-days: 30/g);
});
