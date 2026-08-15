import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { productionPreflightProblems } from "../scripts/production-preflight.ts";

function validEnv(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const digest = (name: string): string =>
    `docker.io/lijixing/qm-${name}@sha256:${Buffer.from(name).toString("hex").padEnd(64, "a").slice(0, 64)}`;
  return {
    NODE_ENV: "production",
    PORTAL_LOCAL_AUTH_BYPASS: "0",
    SANDBOX_BACKEND: "local",
    QM_EDGE_PROXY_MODE: "same-host",
    QM_BIND_ADDRESS: "127.0.0.1",
    QM_COMPOSE_PROJECT: "qm",
    QM_RELEASE_TAG: "prod-v1.2.3",
    QM_POSTGRES_VOLUME: "qm_postgres-data",
    QM_CORE_VOLUME: "qm_core-data",
    PORTAL_XFF_TRUSTED_HOPS: "2",
    ORG_ID: "acme",
    QM_DATABASE_MODE: "bundled",
    POSTGRES_PASSWORD: "01".repeat(32),
    CORE_SIGNING_SECRET: "02".repeat(32),
    CAPABILITY_SECRET: "03".repeat(32),
    PORTAL_IDENTITY_SECRET: "04".repeat(32),
    PORTAL_SESSION_SECRET: "05".repeat(32),
    CONNECTOR_SECRET_KEY: "06".repeat(32),
    SKILL_SIGNING_SECRET: "07".repeat(32),
    AUTH_TOKEN_SECRET: "08".repeat(32),
    AUTH_CLIENT_SECRET: "09".repeat(32),
    OIDC_CLIENT_SECRET: "09".repeat(32),
    PORTAL_PUBLIC_URL: "https://qm.example.test",
    AUTH_ISSUER: "https://qm.example.test/idp",
    AUTH_REDIRECT_URI: "https://qm.example.test/auth/callback",
    OIDC_ISSUER: "https://qm.example.test/idp",
    OIDC_AUTH_ENDPOINT: "https://qm.example.test/idp/authorize",
    OIDC_TOKEN_ENDPOINT: "http://qm-auth.internal:8080/token",
    OIDC_USERINFO_ENDPOINT: "http://qm-auth.internal:8080/userinfo",
    OIDC_JWKS_URI: "http://qm-auth.internal:8080/.well-known/jwks.json",
    AUTH_BROKER_UPSTREAM: "http://qm-auth.internal:8080",
    AUTH_BROKER_PREFIX: "/idp",
    AUTH_CLIENT_ID: "qm-portal",
    OIDC_CLIENT_ID: "qm-portal",
    OIDC_PRINCIPAL_CLAIM: "email",
    AUTH_ALLOWED_EMAIL_DOMAIN: "example.test",
    OIDC_ALLOWED_EMAIL_DOMAIN: "example.test",
    AUTH_EMAIL_FROM: "noreply@example.test",
    ADMIN_GRANTS: "admin@example.test:org_admin",
    AUTH_EMAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_USERNAME: "noreply@example.test",
    SMTP_PASSWORD: "mail-password",
    SMTP_TLS: "implicit",
    AUTH_SIGNING_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
    DOCKER_GID: "989",
    QM_CORE_IMAGE: digest("core"),
    QM_WEB_UI_IMAGE: digest("web-ui"),
    QM_ADMIN_IMAGE: digest("admin"),
    QM_PORTAL_IMAGE: digest("portal"),
    QM_AUTH_IMAGE: digest("auth"),
    QM_EDGE_IMAGE: digest("edge"),
    QM_SANDBOX_IMAGE: digest("sandbox-local"),
  };
}

test("a complete generated production configuration passes the central preflight", () => {
  assert.deepEqual(productionPreflightProblems(validEnv(), 989), []);
});

test("the checked-in production example fails closed without echoing secret values", () => {
  const env = validEnv();
  const secret = "qm-example-secret-do-not-deploy";
  env.CORE_SIGNING_SECRET = secret;
  env.PORTAL_PUBLIC_URL = "https://qm.example.com";
  env.QM_RELEASE_TAG = "prod-v0.0.0";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /CORE_SIGNING_SECRET must be replaced/);
  assert.match(text, /PORTAL_PUBLIC_URL must not use example\.com/);
  assert.match(text, /QM_RELEASE_TAG must not use the example release/);
  assert.doesNotMatch(text, new RegExp(secret));
});

test("the central preflight validates the release tag and stable Compose project", () => {
  const env = validEnv();
  env.QM_RELEASE_TAG = "latest";
  env.QM_COMPOSE_PROJECT = "QM Production";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /QM_RELEASE_TAG must use prod-vMAJOR\.MINOR\.PATCH/);
  assert.match(text, /QM_COMPOSE_PROJECT must use lowercase letters/);
});

test("the central preflight validates literal volume names and the verified image lock", () => {
  const env = validEnv();
  env.QM_POSTGRES_VOLUME = "bad/volume";
  env.QM_CORE_IMAGE = `docker.io/lijixing/qm-core@sha256:${"0".repeat(64)}`;
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /QM_POSTGRES_VOLUME must be a literal Docker volume name/);
  assert.match(text, /QM_CORE_IMAGE must not use a sentinel digest/);
});

test("the central preflight rejects reused secrets and a mismatched Docker socket group", () => {
  const env = validEnv();
  env.PORTAL_SESSION_SECRET = env.CORE_SIGNING_SECRET;
  const text = productionPreflightProblems(env, 1000).join(" | ");

  assert.match(text, /CORE_SIGNING_SECRET must differ from PORTAL_SESSION_SECRET/);
  assert.match(text, /DOCKER_GID must match/);
});

test("the central preflight accepts a remote proxy binding and validates admin grants", () => {
  const env = validEnv();
  env.QM_EDGE_PROXY_MODE = "remote-proxy";
  env.QM_BIND_ADDRESS = "0.0.0.0";
  env.ADMIN_GRANTS = "admin@example.test:not_admin";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.doesNotMatch(text, /QM_BIND_ADDRESS/);
  assert.doesNotMatch(text, /PORTAL_XFF_TRUSTED_HOPS/);
  assert.match(text, /ADMIN_GRANTS must contain at least one principal:org_admin entry/);
});

test("the central preflight rejects loopback remote bindings and proxy hop drift", () => {
  const env = validEnv();
  env.QM_EDGE_PROXY_MODE = "remote-proxy";
  env.QM_BIND_ADDRESS = "127.0.0.2";
  env.PORTAL_XFF_TRUSTED_HOPS = "3";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /non-loopback IPv4/);
  assert.match(text, /PORTAL_XFF_TRUSTED_HOPS must be 2/);
});

test("the central preflight keeps same-host edge binding on loopback", () => {
  const env = validEnv();
  env.QM_BIND_ADDRESS = "0.0.0.0";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /QM_BIND_ADDRESS must be 127\.0\.0\.1 in same-host proxy mode/);
});

test("bundled PostgreSQL accepts provider-style passwords with an eight-character minimum", () => {
  const env = validEnv();
  env.POSTGRES_PASSWORD = "p@ssword";
  assert.deepEqual(productionPreflightProblems(env, 989), []);

  env.POSTGRES_PASSWORD = "short7";
  assert.match(productionPreflightProblems(env, 989).join(" | "), /at least 8 characters/);

  env.POSTGRES_PASSWORD = "p@ssword";
  env.DATABASE_URL = "postgresql://external.db.test/qm";
  assert.match(productionPreflightProblems(env, 989).join(" | "), /DATABASE_URL must be empty/);

  delete env.DATABASE_URL;
  env.POSTGRES_DB = "qm/data";
  assert.match(productionPreflightProblems(env, 989).join(" | "), /POSTGRES_DB must use/);
});

test("external PostgreSQL uses its URL without inspecting the provider password", () => {
  const env = validEnv();
  env.QM_DATABASE_MODE = "external";
  env.QM_DATABASE_TRANSPORT = "private-network";
  env.DATABASE_URL = "postgresql://vendor:p%40ss@db.provider.example.test:5432/qm?sslmode=require";
  delete env.POSTGRES_PASSWORD;
  delete env.QM_POSTGRES_VOLUME;
  assert.deepEqual(productionPreflightProblems(env, 989), []);

  env.DATABASE_URL = "https://db.provider.example.test/qm";
  assert.match(productionPreflightProblems(env, 989).join(" | "), /DATABASE_URL must use postgres or postgresql/);

  env.DATABASE_URL = "postgresql://vendor:p%40ss@db.provider.example.test:5432/qm";
  delete env.QM_DATABASE_TRANSPORT;
  assert.match(productionPreflightProblems(env, 989).join(" | "), /QM_DATABASE_TRANSPORT must be/);
});

test("the central preflight rejects example subdomains and malformed private JWKs", () => {
  const env = validEnv();
  env.AUTH_ALLOWED_EMAILS = "admin@sub.example.com";
  env.AUTH_ALLOWED_EMAIL_DOMAIN = "";
  env.AUTH_SIGNING_JWK = JSON.stringify({ kty: "EC", crv: "P-256", d: "invalid" });
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /AUTH_ALLOWED_EMAILS must not use example\.com/);
  assert.match(text, /AUTH_SIGNING_JWK must be a valid P-256 private JWK/);
});

test("the central preflight fixes private OIDC endpoints to the built-in broker", () => {
  const env = validEnv();
  env.OIDC_TOKEN_ENDPOINT = "https://identity.example.test/token";
  env.OIDC_USERINFO_ENDPOINT = "https://identity.example.test/userinfo";
  env.OIDC_JWKS_URI = "https://identity.example.test/jwks";
  env.OIDC_PRINCIPAL_CLAIM = "sub";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /OIDC_TOKEN_ENDPOINT must be http:\/\/qm-auth\.internal:8080\/token/);
  assert.match(text, /OIDC_USERINFO_ENDPOINT must be http:\/\/qm-auth\.internal:8080\/userinfo/);
  assert.match(text, /OIDC_JWKS_URI must be http:\/\/qm-auth\.internal:8080\/\.well-known\/jwks\.json/);
  assert.match(text, /OIDC_PRINCIPAL_CLAIM must be email/);
});

test("the central preflight requires a reachable initial administrator", () => {
  const env = validEnv();
  env.ADMIN_GRANTS = "admin@elsewhere.test:org_admin";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /ADMIN_GRANTS must include an email allowed by both broker and portal identity boundaries/);
});

test("the central preflight rejects mismatched JWK public coordinates", () => {
  const env = validEnv();
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const mismatched = JSON.parse(env.AUTH_SIGNING_JWK!) as Record<string, unknown>;
  const other = privateKey.export({ format: "jwk" });
  mismatched.x = other.x;
  mismatched.y = other.y;
  env.AUTH_SIGNING_JWK = JSON.stringify(mismatched);
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /AUTH_SIGNING_JWK public coordinates must match its private key/);
});
