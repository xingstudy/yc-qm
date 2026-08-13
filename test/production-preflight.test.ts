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
    QM_BIND_ADDRESS: "127.0.0.1",
    PORTAL_XFF_TRUSTED_HOPS: "2",
    ORG_ID: "acme",
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
  env.QM_CORE_IMAGE = `docker.io/lijixing/qm-core@sha256:${"0".repeat(64)}`;
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /CORE_SIGNING_SECRET must be replaced/);
  assert.match(text, /PORTAL_PUBLIC_URL must not use example\.com/);
  assert.match(text, /QM_CORE_IMAGE must not use a sentinel digest/);
  assert.doesNotMatch(text, new RegExp(secret));
});

test("the central preflight rejects reused secrets and a mismatched Docker socket group", () => {
  const env = validEnv();
  env.PORTAL_SESSION_SECRET = env.CORE_SIGNING_SECRET;
  const text = productionPreflightProblems(env, 1000).join(" | ");

  assert.match(text, /CORE_SIGNING_SECRET must differ from PORTAL_SESSION_SECRET/);
  assert.match(text, /DOCKER_GID must match/);
});

test("the central preflight keeps the HTTP edge loopback-only and validates admin grants", () => {
  const env = validEnv();
  env.QM_BIND_ADDRESS = "0.0.0.0";
  env.PORTAL_XFF_TRUSTED_HOPS = "3";
  env.ADMIN_GRANTS = "admin@example.test:not_admin";
  const text = productionPreflightProblems(env, 989).join(" | ");

  assert.match(text, /QM_BIND_ADDRESS must be 127\.0\.0\.1/);
  assert.match(text, /PORTAL_XFF_TRUSTED_HOPS must be 2/);
  assert.match(text, /ADMIN_GRANTS must contain at least one principal:org_admin entry/);
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
