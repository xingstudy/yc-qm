import { createECDH, createPrivateKey, randomBytes, type JsonWebKey } from "node:crypto";
import { statSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import {
  isExampleDomain,
  isExampleEmail,
  isExampleJwk,
  isProductionPlaceholder,
} from "../plugins/chassis/src/production-placeholders.ts";
import { sleep } from "../src/util/async.ts";
import { databaseUrlFromEnv } from "../src/util/postgres-url.ts";

const imageNames = [
  "QM_CORE_IMAGE",
  "QM_WEB_UI_IMAGE",
  "QM_ADMIN_IMAGE",
  "QM_PORTAL_IMAGE",
  "QM_AUTH_IMAGE",
  "QM_EDGE_IMAGE",
  "QM_SANDBOX_IMAGE",
] as const;

export function productionPreflightProblems(
  env: NodeJS.ProcessEnv,
  socketGid: number | undefined = dockerSocketGid(),
): string[] {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (isProductionPlaceholder(value)) problems.push(`${name} must be replaced with a deployment value`);
    return value?.trim() ?? "";
  };
  const strong = (name: string): string => {
    const value = required(name);
    if (value && value.length < 32) problems.push(`${name} must be at least 32 characters`);
    return value;
  };
  const absoluteUrl = (name: string, https: boolean): URL | undefined => {
    const value = required(name);
    if (!value) return undefined;
    try {
      const url = new URL(value);
      if (https && url.protocol !== "https:") problems.push(`${name} must use https`);
      if (isExampleDomain(url.hostname)) problems.push(`${name} must not use example.com`);
      return url;
    } catch {
      problems.push(`${name} must be an absolute URL`);
      return undefined;
    }
  };
  const list = (name: string): string[] =>
    (env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

  if (env.NODE_ENV !== "production") problems.push("NODE_ENV must be production");
  if (env.PORTAL_LOCAL_AUTH_BYPASS !== "0") problems.push("PORTAL_LOCAL_AUTH_BYPASS must be 0");
  if (env.SANDBOX_BACKEND !== "local") problems.push("SANDBOX_BACKEND must be local for this Compose stack");
  const edgeProxyMode = required("QM_EDGE_PROXY_MODE") || "same-host";
  const bindAddress = required("QM_BIND_ADDRESS") || "127.0.0.1";
  if (edgeProxyMode !== "same-host" && edgeProxyMode !== "remote-proxy") {
    problems.push("QM_EDGE_PROXY_MODE must be same-host or remote-proxy");
  } else if (edgeProxyMode === "same-host" && bindAddress !== "127.0.0.1") {
    problems.push("QM_BIND_ADDRESS must be 127.0.0.1 in same-host proxy mode");
  } else if (edgeProxyMode === "remote-proxy" && (isIP(bindAddress) !== 4 || bindAddress.startsWith("127."))) {
    problems.push("QM_BIND_ADDRESS must be a non-loopback IPv4 address in remote-proxy mode");
  }
  if (required("PORTAL_XFF_TRUSTED_HOPS") !== "2") {
    problems.push("PORTAL_XFF_TRUSTED_HOPS must be 2 for one external TLS proxy and the bundled edge");
  }

  const composeProject = required("QM_COMPOSE_PROJECT");
  if (composeProject && !/^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) {
    problems.push("QM_COMPOSE_PROJECT must use lowercase letters, digits, hyphens, or underscores");
  }
  const releaseTag = required("QM_RELEASE_TAG");
  if (releaseTag && !/^prod-v[0-9]+\.[0-9]+\.[0-9]+$/.test(releaseTag)) {
    problems.push("QM_RELEASE_TAG must use prod-vMAJOR.MINOR.PATCH");
  }
  if (releaseTag === "prod-v0.0.0") problems.push("QM_RELEASE_TAG must not use the example release");
  const databaseMode = required("QM_DATABASE_MODE") || "bundled";
  if (databaseMode !== "bundled" && databaseMode !== "external") {
    problems.push("QM_DATABASE_MODE must be bundled or external");
  }
  const volumeNames = databaseMode === "bundled" ? ["QM_POSTGRES_VOLUME", "QM_CORE_VOLUME"] : ["QM_CORE_VOLUME"];
  for (const name of volumeNames) {
    const value = required(name);
    if (value && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
      problems.push(`${name} must be a literal Docker volume name`);
    }
  }

  required("ORG_ID");
  if (databaseMode === "bundled") {
    if (env.DATABASE_URL?.trim()) problems.push("DATABASE_URL must be empty for bundled PostgreSQL");
    const postgresPassword = required("POSTGRES_PASSWORD");
    if (postgresPassword && postgresPassword.length < 8) {
      problems.push("POSTGRES_PASSWORD must be at least 8 characters for bundled PostgreSQL");
    }
    if (postgresPassword && !databaseUrlFromEnv(env)) {
      problems.push("bundled PostgreSQL settings must form a valid DATABASE_URL");
    }
    const postgresDatabase = env.POSTGRES_DB?.trim() || "qm";
    if (!/^[A-Za-z0-9_.-]+$/.test(postgresDatabase)) {
      problems.push("POSTGRES_DB must use letters, digits, dots, underscores, or hyphens for bundled PostgreSQL");
    }
  } else if (databaseMode === "external") {
    const databaseTransport = required("QM_DATABASE_TRANSPORT");
    if (databaseTransport !== "tls" && databaseTransport !== "private-network") {
      problems.push("QM_DATABASE_TRANSPORT must be tls or private-network for external PostgreSQL");
    }
    const databaseUrl = absoluteUrl("DATABASE_URL", false);
    if (databaseUrl && databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
      problems.push("DATABASE_URL must use postgres or postgresql");
    }
  }

  const independentSecrets = [
    "CORE_SIGNING_SECRET",
    "CAPABILITY_SECRET",
    "PORTAL_IDENTITY_SECRET",
    "PORTAL_SESSION_SECRET",
    "CONNECTOR_SECRET_KEY",
    "SKILL_SIGNING_SECRET",
    "AUTH_TOKEN_SECRET",
  ] as const;
  const secretValues = independentSecrets.map((name) => [name, strong(name)] as const);
  for (let i = 0; i < secretValues.length; i++) {
    for (let j = i + 1; j < secretValues.length; j++) {
      if (secretValues[i]![1] && secretValues[i]![1] === secretValues[j]![1]) {
        problems.push(`${secretValues[i]![0]} must differ from ${secretValues[j]![0]}`);
      }
    }
  }

  const authClientSecret = strong("AUTH_CLIENT_SECRET");
  const oidcClientSecret = strong("OIDC_CLIENT_SECRET");
  if (authClientSecret && oidcClientSecret && authClientSecret !== oidcClientSecret) {
    problems.push("AUTH_CLIENT_SECRET and OIDC_CLIENT_SECRET must match for the built-in broker");
  }
  if (secretValues.some(([, value]) => value && value === authClientSecret)) {
    problems.push("AUTH_CLIENT_SECRET must differ from signing, encryption, session, and token secrets");
  }

  const publicUrl = absoluteUrl("PORTAL_PUBLIC_URL", true);
  const issuer = absoluteUrl("AUTH_ISSUER", true);
  const redirect = absoluteUrl("AUTH_REDIRECT_URI", true);
  const oidcIssuer = absoluteUrl("OIDC_ISSUER", true);
  const oidcAuth = absoluteUrl("OIDC_AUTH_ENDPOINT", true);
  if (publicUrl) {
    const expectedIssuer = `${publicUrl.origin}/idp`;
    if (issuer?.href.replace(/\/$/, "") !== expectedIssuer)
      problems.push("AUTH_ISSUER must be PORTAL_PUBLIC_URL plus /idp");
    if (oidcIssuer?.href.replace(/\/$/, "") !== expectedIssuer)
      problems.push("OIDC_ISSUER must be PORTAL_PUBLIC_URL plus /idp");
    if (oidcAuth?.href.replace(/\/$/, "") !== `${expectedIssuer}/authorize`) {
      problems.push("OIDC_AUTH_ENDPOINT must be PORTAL_PUBLIC_URL plus /idp/authorize");
    }
    if (redirect?.href.replace(/\/$/, "") !== `${publicUrl.origin}/auth/callback`) {
      problems.push("AUTH_REDIRECT_URI must be PORTAL_PUBLIC_URL plus /auth/callback");
    }
  }

  if (required("OIDC_TOKEN_ENDPOINT") !== "http://qm-auth.internal:8080/token") {
    problems.push("OIDC_TOKEN_ENDPOINT must be http://qm-auth.internal:8080/token");
  }
  if (required("OIDC_USERINFO_ENDPOINT") !== "http://qm-auth.internal:8080/userinfo") {
    problems.push("OIDC_USERINFO_ENDPOINT must be http://qm-auth.internal:8080/userinfo");
  }
  if (required("OIDC_JWKS_URI") !== "http://qm-auth.internal:8080/.well-known/jwks.json") {
    problems.push("OIDC_JWKS_URI must be http://qm-auth.internal:8080/.well-known/jwks.json");
  }
  if (required("AUTH_BROKER_UPSTREAM") !== "http://qm-auth.internal:8080") {
    problems.push("AUTH_BROKER_UPSTREAM must be http://qm-auth.internal:8080");
  }
  if (required("AUTH_BROKER_PREFIX") !== "/idp") problems.push("AUTH_BROKER_PREFIX must be /idp");
  if (required("AUTH_CLIENT_ID") !== "qm-portal") problems.push("AUTH_CLIENT_ID must be qm-portal");
  if (required("OIDC_CLIENT_ID") !== "qm-portal") problems.push("OIDC_CLIENT_ID must be qm-portal");
  if (required("OIDC_PRINCIPAL_CLAIM") !== "email") problems.push("OIDC_PRINCIPAL_CLAIM must be email");

  const allowedDomain = env.AUTH_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase() ?? "";
  const allowedEmails = list("AUTH_ALLOWED_EMAILS");
  const oidcAllowedDomain = env.OIDC_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase() ?? "";
  const oidcAllowedEmails = list("OIDC_ALLOWED_EMAILS");
  const expectedTeamId = env.PORTAL_EXPECTED_TEAM_ID?.trim() ?? "";
  if (!allowedDomain && !allowedEmails.length) {
    problems.push("AUTH_ALLOWED_EMAIL_DOMAIN or AUTH_ALLOWED_EMAILS must define the broker trust boundary");
  }
  if (!oidcAllowedDomain && !oidcAllowedEmails.length && !expectedTeamId) {
    problems.push(
      "OIDC_ALLOWED_EMAIL_DOMAIN, OIDC_ALLOWED_EMAILS, or PORTAL_EXPECTED_TEAM_ID must define the portal trust boundary",
    );
  }
  if (isExampleDomain(allowedDomain)) problems.push("AUTH_ALLOWED_EMAIL_DOMAIN must not use example.com");
  if (isExampleDomain(oidcAllowedDomain)) problems.push("OIDC_ALLOWED_EMAIL_DOMAIN must not use example.com");
  if (allowedEmails.some(isExampleEmail)) problems.push("AUTH_ALLOWED_EMAILS must not use example.com");
  if (oidcAllowedEmails.some(isExampleEmail)) problems.push("OIDC_ALLOWED_EMAILS must not use example.com");
  if (isProductionPlaceholder(expectedTeamId) && env.PORTAL_EXPECTED_TEAM_ID !== undefined && expectedTeamId) {
    problems.push("PORTAL_EXPECTED_TEAM_ID must not be a placeholder");
  }
  if (allowedDomain && oidcAllowedDomain && allowedDomain !== oidcAllowedDomain) {
    problems.push("AUTH_ALLOWED_EMAIL_DOMAIN and OIDC_ALLOWED_EMAIL_DOMAIN must match");
  }
  const emailFrom = required("AUTH_EMAIL_FROM").replace(/^.*<|>.*$/g, "");
  if (isExampleEmail(emailFrom)) problems.push("AUTH_EMAIL_FROM must not use example.com");
  const adminGrants = required("ADMIN_GRANTS")
    .split(",")
    .map((grant) => grant.trim())
    .filter(Boolean);
  const adminPrincipals = adminGrants.flatMap((grant) => {
    const separator = grant.lastIndexOf(":");
    const principal = grant.slice(0, separator).trim();
    const role = grant.slice(separator + 1).trim();
    return principal && role === "org_admin" ? [principal] : [];
  });
  if (!adminPrincipals.length) problems.push("ADMIN_GRANTS must contain at least one principal:org_admin entry");
  if (adminPrincipals.some(isExampleEmail)) problems.push("ADMIN_GRANTS must not use example.com");
  const emailAllowed = (email: string, domain: string, emails: string[]): boolean => {
    const candidate = email.trim().toLowerCase();
    const candidateDomain = candidate.slice(candidate.lastIndexOf("@") + 1);
    return (
      emails.map((value) => value.toLowerCase()).includes(candidate) || Boolean(domain && candidateDomain === domain)
    );
  };
  if (
    adminPrincipals.length &&
    !adminPrincipals.some(
      (principal) =>
        emailAllowed(principal, allowedDomain, allowedEmails) &&
        emailAllowed(principal, oidcAllowedDomain, oidcAllowedEmails),
    )
  ) {
    problems.push("ADMIN_GRANTS must include an email allowed by both broker and portal identity boundaries");
  }

  if (env.AUTH_EMAIL_TRANSPORT === "smtp") {
    for (const name of ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"] as const) required(name);
    if (isExampleDomain(env.SMTP_HOST)) problems.push("SMTP_HOST must not use example.com");
    if (isExampleEmail(env.SMTP_USERNAME)) problems.push("SMTP_USERNAME must not use example.com");
    if (env.SMTP_TLS !== "implicit" && env.SMTP_TLS !== "starttls")
      problems.push("SMTP_TLS must be implicit or starttls");
  } else if (env.AUTH_EMAIL_TRANSPORT === "resend") {
    required("RESEND_API_KEY");
  } else {
    problems.push("AUTH_EMAIL_TRANSPORT must be smtp or resend");
  }

  const jwkRaw = required("AUTH_SIGNING_JWK");
  if (jwkRaw) {
    try {
      const jwk = JSON.parse(jwkRaw) as Record<string, unknown>;
      if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || isExampleJwk(jwk)) {
        problems.push("AUTH_SIGNING_JWK must be a non-example P-256 private JWK");
      } else {
        const key = createPrivateKey({ key: jwk as JsonWebKey, format: "jwk" });
        if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
          problems.push("AUTH_SIGNING_JWK must be a non-example P-256 private JWK");
        } else {
          const ecdh = createECDH("prime256v1");
          ecdh.setPrivateKey(Buffer.from(jwk.d, "base64url"));
          const publicPoint = ecdh.getPublicKey(undefined, "uncompressed");
          const x = publicPoint.subarray(1, 33).toString("base64url");
          const y = publicPoint.subarray(33, 65).toString("base64url");
          if (jwk.x !== x || jwk.y !== y) {
            problems.push("AUTH_SIGNING_JWK public coordinates must match its private key");
          }
        }
      }
    } catch {
      problems.push("AUTH_SIGNING_JWK must be a valid P-256 private JWK");
    }
  }

  const dockerGid = Number(required("DOCKER_GID"));
  if (!Number.isSafeInteger(dockerGid) || dockerGid < 0) problems.push("DOCKER_GID must be a non-negative integer");
  else if (socketGid === undefined) problems.push("/var/run/docker.sock must be mounted for the local sandbox backend");
  else if (socketGid !== dockerGid) problems.push("DOCKER_GID must match /var/run/docker.sock");

  for (const name of imageNames) {
    const value = required(name);
    if (value && !/^docker\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$/.test(value)) {
      problems.push(`${name} must be a Docker Hub image pinned by sha256 digest`);
    }
    if (/sha256:(.)\1{63}$/.test(value)) problems.push(`${name} must not use a sentinel digest`);
  }

  return problems;
}

function dockerSocketGid(): number | undefined {
  try {
    return statSync("/var/run/docker.sock").gid;
  } catch {
    return undefined;
  }
}

export async function productionDatabaseProblem(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const databaseUrl = databaseUrlFromEnv(env);
  if (!databaseUrl) return "database configuration did not produce a connection URL";
  const pg = (await import("pg")).default;
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await sleep(delay);
    const client = new pg.Client({
      application_name: "qm-production-preflight",
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
    });
    let lockKey = "";
    let lockAcquired = false;
    try {
      await client.connect();
      await client.query("SELECT 1");
      lockKey = randomBytes(8).readBigInt64BE().toString();
      const acquired = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [lockKey],
      );
      if (acquired.rows[0]?.acquired !== true) return "database does not provide required session features";
      lockAcquired = true;
      const released = await client.query<{ released: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS released", [
        lockKey,
      ]);
      if (released.rows[0]?.released !== true) return "database does not provide required session features";
      lockAcquired = false;
      const channel = `qm_preflight_${randomBytes(8).toString("hex")}`;
      await client.query(`LISTEN ${channel}`);
      await client.query(`UNLISTEN ${channel}`);
      if (env.QM_DATABASE_MODE === "external" && env.QM_DATABASE_TRANSPORT === "tls") {
        const tls = await client.query<{ ssl: boolean }>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
        if (tls.rows[0]?.ssl !== true) return "database connection did not establish required TLS";
      }
      return undefined;
    } catch {
      if (lockAcquired) return "database does not provide required session features";
    } finally {
      if (lockAcquired) await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }
  return "database is unreachable or rejected the configured credentials";
}

async function runProductionPreflight(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const problems = productionPreflightProblems(env);
  if (!problems.length) {
    const databaseProblem = await productionDatabaseProblem(env);
    if (databaseProblem) problems.push(databaseProblem);
  }
  if (problems.length) {
    for (const problem of problems) console.error(`[production-preflight] ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("[production-preflight] configuration accepted");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runProductionPreflight().catch(() => {
    console.error("[production-preflight] database verification failed");
    process.exitCode = 1;
  });
}
