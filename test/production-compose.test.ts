import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

const imageNames = ["CORE", "WEB_UI", "ADMIN", "PORTAL", "AUTH", "EDGE", "SANDBOX"] as const;
const imageRepositories: Record<(typeof imageNames)[number], string> = {
  CORE: "core",
  WEB_UI: "web-ui",
  ADMIN: "admin",
  PORTAL: "portal",
  AUTH: "auth",
  EDGE: "edge",
  SANDBOX: "sandbox-local",
};
const requiredProductionValues = [
  "QM_COMPOSE_PROJECT",
  "QM_RELEASE_TAG",
  "QM_POSTGRES_VOLUME",
  "QM_CORE_VOLUME",
  "QM_DATABASE_MODE",
  "QM_DATABASE_TRANSPORT",
  "QM_EDGE_PROXY_MODE",
  "POSTGRES_PASSWORD",
  "DOCKER_GID",
  "CORE_SIGNING_SECRET",
  "CAPABILITY_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "PORTAL_SESSION_SECRET",
  "CONNECTOR_SECRET_KEY",
  "SKILL_SIGNING_SECRET",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "AUTH_CLIENT_SECRET",
  "AUTH_SIGNING_JWK",
  "AUTH_TOKEN_SECRET",
  "SMTP_PASSWORD",
] as const;
const generatedValues = [
  "POSTGRES_PASSWORD",
  "CORE_SIGNING_SECRET",
  "CAPABILITY_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "PORTAL_SESSION_SECRET",
  "CONNECTOR_SECRET_KEY",
  "SKILL_SIGNING_SECRET",
  "OIDC_CLIENT_SECRET",
  "AUTH_CLIENT_SECRET",
  "AUTH_SIGNING_JWK",
  "AUTH_TOKEN_SECRET",
] as const;

function envValues(path: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const entry = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (entry) values.set(entry[1]!, entry[2]!);
  }
  return values;
}

function serviceBlock(compose: string, service: string): string {
  const header = new RegExp(`^  ${service}:\\n`, "m").exec(compose);
  assert.ok(header, `${service} must be declared`);
  const afterStart = header.index + header[0].length;
  const nextService = compose.slice(afterStart).search(/^ {2}[a-z][a-z-]*:\n/m);
  return nextService === -1 ? compose.slice(afterStart) : compose.slice(afterStart, afterStart + nextService);
}

test("the production example is a complete fail-closed template without organization-specific configuration", () => {
  const values = envValues(".env.production.example");

  for (const name of requiredProductionValues) {
    assert.ok(values.get(name)?.trim(), `${name} needs an explicit example value`);
  }
  for (const name of ["NODE_ENV", "PORTAL_LOCAL_AUTH_BYPASS", "AUTH_EMAIL_TRANSPORT"] as const) {
    assert.ok(values.get(name)?.trim(), `${name} must not rely on an implicit runtime default`);
  }
  assert.equal(values.get("NODE_ENV"), "production");
  assert.equal(values.get("PORTAL_LOCAL_AUTH_BYPASS"), "0");
  assert.equal(values.get("AUTH_EMAIL_TRANSPORT"), "smtp");
  assert.equal(values.get("QM_COMPOSE_PROJECT"), "qm");
  assert.equal(values.get("QM_RELEASE_TAG"), "prod-v0.0.0");
  assert.equal(values.get("QM_POSTGRES_VOLUME"), "qm_postgres-data");
  assert.equal(values.get("QM_CORE_VOLUME"), "qm_core-data");
  assert.equal(values.get("QM_DATABASE_MODE"), "bundled");
  assert.equal(values.get("QM_DATABASE_TRANSPORT"), "private-network");
  assert.equal(values.get("QM_EDGE_PROXY_MODE"), "same-host");
  assert.equal(values.get("QM_BIND_ADDRESS"), "127.0.0.1");
  assert.equal(values.get("PORTAL_PUBLIC_URL"), "https://qm.example.com");
  assert.equal(values.get("OIDC_ALLOWED_EMAIL_DOMAIN"), "example.com");
  assert.equal(values.get("AUTH_ALLOWED_EMAIL_DOMAIN"), "example.com");
  for (const name of generatedValues) {
    if (name === "AUTH_SIGNING_JWK") {
      assert.match(values.get(name) ?? "", /"kid":"qm-example-do-not-use"/);
    } else {
      assert.match(values.get(name) ?? "", /^qm-example-/);
    }
  }
  assert.doesNotMatch(readFileSync(".env.production.example", "utf8"), /qfpay|aiagents/i);
});

test("the image manifest pins every pull-only first-party image to Docker Hub", () => {
  const values = envValues("images.production.env");
  const refs: string[] = [];

  for (const name of imageNames) {
    const ref = values.get(`QM_${name}_IMAGE`);
    assert.ok(ref, `QM_${name}_IMAGE is required`);
    assert.equal(ref!.split("@sha256:")[0], `docker.io/lijixing/qm-${imageRepositories[name]}`);
    assert.match(ref!, /^docker\.io\/lijixing\/qm-[a-z-]+@sha256:[0-9a-f]{64}$/);
    refs.push(ref!);
  }
  assert.equal(new Set(refs).size, refs.length, "each service must have its own immutable image");
  assert.equal(values.size, imageNames.length, "the production image manifest is an allowlist, not a general env file");
});

test("the production Compose stack is image-only and exposes only the edge", () => {
  const compose = readFileSync("compose.production.yaml", "utf8");

  assert.doesNotMatch(compose, /^\s*build:/m);
  assert.doesNotMatch(compose, /^\s*context:/m);
  assert.doesNotMatch(compose, /^\s*-\s*\.\//m);
  assert.match(compose, /^name: \$\{QM_COMPOSE_PROJECT:\?[^}]+\}$/m);
  for (const name of imageNames) {
    assert.match(compose, new RegExp(`image: \\$\\{QM_${name}_IMAGE:\\?[^}]+\\}`));
  }
  assert.match(compose, /postgres-data:\s*\n\s+name: \$\{QM_POSTGRES_VOLUME:-qm_postgres-data\}/);
  assert.match(compose, /core-data:\s*\n\s+name: \$\{QM_CORE_VOLUME:\?[^}]+\}/);
  assert.match(serviceBlock(compose, "sandbox-image"), /entrypoint:[\s\S]*?\/bin\/true/);
  assert.match(serviceBlock(compose, "core"), /sandbox-image:[\s\S]*?service_completed_successfully/);
  assert.match(serviceBlock(compose, "postgres"), /profiles:[\s\S]*?bundled-postgres/);
  assert.match(serviceBlock(compose, "core"), /postgres:[\s\S]*?required: false/);
  assert.match(serviceBlock(compose, "core"), /DATABASE_URL: \$\{DATABASE_URL:-\}/);
  assert.match(compose, /^\s*edge:\s*$/m);
  assert.match(compose, /edge:[\s\S]*?ports:/);
  assert.match(serviceBlock(compose, "edge"), /QM_BIND_ADDRESS:-127\.0\.0\.1[^\n]*QM_HTTP_PORT:-8088/);
  assert.doesNotMatch(serviceBlock(compose, "auth"), /^\s*profiles:/m);
  for (const service of ["web-ui", "admin", "portal", "auth"]) {
    const block = serviceBlock(compose, service);
    assert.doesNotMatch(block, /^\s*ports:/m, `${service} must stay behind the edge`);
  }
  assert.match(serviceBlock(compose, "postgres"), /127\.0\.0\.1[^\n]*:5432/);
  assert.match(compose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(compose, /group_add:[\s\S]*?DOCKER_GID/);
});

test("literal production volume names survive Compose project overrides", () => {
  const directory = mkdtempSync("/tmp/qm-production-compose-");
  try {
    const envFile = join(directory, ".env.production");
    writeFileSync(envFile, readFileSync(".env.production.example", "utf8"));
    const rendered = JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "--project-name",
          "cli-project",
          "--env-file",
          envFile,
          "--env-file",
          "images.production.env",
          "--profile",
          "bundled-postgres",
          "-f",
          "compose.production.yaml",
          "config",
          "--format",
          "json",
        ],
        { env: { ...process.env, COMPOSE_PROJECT_NAME: "shell-project" } },
      ).toString(),
    ) as { name: string; volumes: Record<string, { name: string }> };
    assert.equal(rendered.name, "cli-project");
    assert.equal(rendered.volumes["postgres-data"]?.name, "qm_postgres-data");
    assert.equal(rendered.volumes["core-data"]?.name, "qm_core-data");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("external production database mode excludes bundled PostgreSQL and preserves the provider URL", () => {
  const directory = mkdtempSync("/tmp/qm-production-external-db-");
  try {
    const envFile = join(directory, ".env.production");
    const databaseUrl = "postgresql://vendor:p%40ss@db.provider.test:5432/qm?sslmode=require";
    writeFileSync(
      envFile,
      readFileSync(".env.production.example", "utf8")
        .replace("QM_DATABASE_MODE=bundled", "QM_DATABASE_MODE=external")
        .replace("DATABASE_URL=", `DATABASE_URL=${databaseUrl}`),
    );
    const rendered = JSON.parse(
      execFileSync("docker", [
        "compose",
        "--project-name",
        "external-db",
        "--env-file",
        envFile,
        "--env-file",
        "images.production.env",
        "-f",
        "compose.production.yaml",
        "config",
        "--format",
        "json",
      ]).toString(),
    ) as { services: Record<string, { environment?: Record<string, string> }> };
    assert.equal(rendered.services.postgres, undefined);
    assert.equal(rendered.services.core?.environment?.DATABASE_URL, databaseUrl);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a quoted bundled password survives Compose interpolation as a literal value", () => {
  const directory = mkdtempSync("/tmp/qm-production-password-");
  try {
    const envFile = join(directory, ".env.production");
    const password = "p$word#1@";
    writeFileSync(
      envFile,
      readFileSync(".env.production.example", "utf8").replace(
        /^POSTGRES_PASSWORD=.*$/m,
        `POSTGRES_PASSWORD='${password}'`,
      ),
    );
    const rendered = JSON.parse(
      execFileSync("docker", [
        "compose",
        "--project-name",
        "quoted-password",
        "--env-file",
        envFile,
        "--env-file",
        "images.production.env",
        "--profile",
        "bundled-postgres",
        "-f",
        "compose.production.yaml",
        "config",
        "--format",
        "json",
      ]).toString(),
    ) as { services: Record<string, { environment?: Record<string, string> }> };
    const canonicalPassword = password.replaceAll("$", () => "$$");
    assert.equal(rendered.services.postgres?.environment?.POSTGRES_PASSWORD, canonicalPassword);
    assert.equal(rendered.services.core?.environment?.POSTGRES_PASSWORD, canonicalPassword);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the source-build stack delegates bundled database URL construction to core", () => {
  const compose = readFileSync("docker-compose.yaml", "utf8");
  const core = serviceBlock(compose, "core");

  assert.doesNotMatch(core, /DATABASE_URL:\s*postgresql:/);
  assert.match(core, /QM_DATABASE_MODE: bundled/);
  assert.match(core, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
});

test("production initialization replaces every fail-closed value and generates the Docker socket group", () => {
  const script = readFileSync("scripts/init-production-env.sh", "utf8");

  assert.match(script, /QM_DOCKER_SOCKET_PATH:-\/var\/run\/docker\.sock/);
  assert.match(script, /mktemp "\$target_dir\/\.env\.production\.tmp\.XXXXXX"/);
  assert.match(script, /mv "\$work_file" "\$target"/);
  assert.match(script, /openssl rand -hex 32/);
  for (const name of generatedValues) assert.match(script, new RegExp(`\\b${name}\\b`));
  assert.match(script, /AUTH_SIGNING_JWK/);
  assert.match(script, /openssl ecparam -name prime256v1 -genkey/);
  assert.match(script, /QM_RELEASE_TAG/);
  assert.doesNotMatch(script, /images\.production\.env|QM_[A-Z_]+_IMAGE/);
  assert.doesNotMatch(script, /\bnode\b|generateKeyPairSync/);
});

test("production initialization executes with a source tag and a rendered release template", async () => {
  const directory = mkdtempSync("/tmp/qm-production-init-");
  const socket = join(directory, "docker.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  try {
    const sourceTarget = join(directory, "source.env.production");
    execFileSync("bash", ["scripts/init-production-env.sh", sourceTarget, "prod-v1.2.3"], {
      env: { ...process.env, QM_DOCKER_SOCKET_PATH: socket },
      stdio: "pipe",
    });
    assert.equal(statSync(sourceTarget).mode & 0o777, 0o600);
    assert.match(readFileSync(sourceTarget, "utf8"), /^QM_RELEASE_TAG=prod-v1\.2\.3$/m);

    const releaseRoot = join(directory, "release");
    mkdirSync(join(releaseRoot, "scripts"), { recursive: true });
    copyFileSync("scripts/init-production-env.sh", join(releaseRoot, "scripts/init-production-env.sh"));
    writeFileSync(
      join(releaseRoot, "default.env.production.example"),
      readFileSync(".env.production.example", "utf8").replace(
        "QM_RELEASE_TAG=prod-v0.0.0",
        "QM_RELEASE_TAG=prod-v1.2.3",
      ),
    );
    const releaseTarget = join(directory, "release.env.production");
    execFileSync("bash", [join(releaseRoot, "scripts/init-production-env.sh"), releaseTarget], {
      env: { ...process.env, QM_DOCKER_SOCKET_PATH: socket },
      stdio: "pipe",
    });
    assert.equal(statSync(releaseTarget).mode & 0o777, 0o600);
    assert.match(readFileSync(releaseTarget, "utf8"), /^QM_RELEASE_TAG=prod-v1\.2\.3$/m);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the pull-only deployment assets are all checked in", () => {
  for (const path of [
    ".env.production.example",
    "images.production.env",
    "compose.production.yaml",
    "scripts/init-production-env.sh",
    "scripts/deploy-production-release.sh",
    "scripts/production-preflight.ts",
    "deploy/edge/Dockerfile",
  ]) {
    assert.equal(existsSync(path), true, `${path} is required for an image-only deployment`);
  }
});

test("the documented bootstrap verifies release scripts before installing them", () => {
  for (const path of ["README.md", "README.zh-CN.md"]) {
    const readme = readFileSync(path, "utf8");
    assert.match(readme, /curl -fsSLO [^\n]*\/init-production-env\.sh"/);
    assert.match(readme, /curl -fsSLO [^\n]*\/deploy-production-release\.sh"/);
    assert.match(readme, /sha256sum -c SHA256SUMS[\s\S]*install -m 700 init-production-env\.sh/);
    assert.doesNotMatch(readme, /curl [^\n]*-o scripts\/(?:init|deploy)-production/);
  }
});
