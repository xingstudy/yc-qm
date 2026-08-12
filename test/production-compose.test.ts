import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const imageNames = ["CORE", "WEB_UI", "ADMIN", "PORTAL", "AUTH", "EDGE", "SANDBOX"] as const;
const requiredProductionValues = [
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
  const start = compose.indexOf(`  ${service}:\n`);
  assert.notEqual(start, -1, `${service} must be declared`);
  const afterStart = start + `  ${service}:\n`.length;
  const nextService = compose.slice(afterStart).search(/^ {2}[a-z][a-z-]*:\n/m);
  return nextService === -1 ? compose.slice(afterStart) : compose.slice(afterStart, afterStart + nextService);
}

test("the production example is a complete fail-closed template without organization-specific values", () => {
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
  assert.doesNotMatch(readFileSync(".env.production.example", "utf8"), /qfpay|aiagents|lijixing/i);
});

test("the image manifest pins every pull-only first-party image to Docker Hub", () => {
  const values = envValues("images.production.env");
  const refs: string[] = [];

  for (const name of imageNames) {
    const ref = values.get(`QM_${name}_IMAGE`);
    assert.ok(ref, `QM_${name}_IMAGE is required`);
    assert.match(ref!, /^docker\.io\/xingstudy\/qm-[a-z-]+@sha256:[0-9a-f]{64}$/);
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
  for (const name of imageNames) {
    assert.match(compose, new RegExp(`\\$\\{QM_${name}_IMAGE:[^}]+\\}`));
  }
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

test("production initialization replaces every fail-closed value and generates the Docker socket group", () => {
  const script = readFileSync("scripts/init-production-env.sh", "utf8");

  assert.match(script, /stat -c %g \/var\/run\/docker\.sock/);
  assert.match(script, /mktemp "\$target_dir\/\.env\.production\.tmp\.XXXXXX"/);
  assert.match(script, /mv "\$work_file" "\$target"/);
  assert.match(script, /openssl rand -hex 32/);
  for (const name of generatedValues) assert.match(script, new RegExp(`\\b${name}\\b`));
  assert.match(script, /AUTH_SIGNING_JWK/);
  assert.match(script, /openssl ecparam -name prime256v1 -genkey/);
  assert.doesNotMatch(script, /\bnode\b|generateKeyPairSync/);
});

test("the pull-only deployment assets are all checked in", () => {
  for (const path of [
    ".env.production.example",
    "images.production.env",
    "compose.production.yaml",
    "scripts/init-production-env.sh",
    "scripts/production-preflight.ts",
    "deploy/edge/Dockerfile",
  ]) {
    assert.equal(existsSync(path), true, `${path} is required for an image-only deployment`);
  }
});
