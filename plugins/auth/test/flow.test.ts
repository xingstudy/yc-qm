import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import { WECOM_LOGIN_SCRIPT } from "../src/pages.ts";
import {
  authorizeQuery,
  basicAuth,
  CLIENT_ID,
  CLIENT_SECRET,
  hiddenRequestToken,
  ISSUER,
  linkFrom,
  memoryClaimStore,
  memoryContinuations,
  pkcePair,
  REDIRECT_URI,
  refusingClaimStore,
  startHarness,
  type Harness,
} from "./helpers.ts";

const form = (entries: Record<string, string>): { method: string; headers: Record<string, string>; body: string } => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(entries).toString(),
});

async function requestLink(
  h: Harness,
  over: Record<string, string> = {},
): Promise<{ verifier: string; state: string }> {
  const { email, clientIp, ...params } = over;
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge, ...params });
  const page = await fetch(`${h.base}/authorize?${query}`);
  assert.equal(page.status, 200, "authorize should render the email form");
  const request = hiddenRequestToken(await page.text());
  const submit = form({ request, email: email ?? "admin@example.com" });
  const submitted = await fetch(`${h.base}/authorize`, {
    ...submit,
    headers: { ...submit.headers, ...(clientIp ? { "x-qm-client-ip": clientIp } : {}) },
  });
  assert.equal(submitted.status, 200);
  await h.settle();
  return { verifier, state: query.get("state")! };
}

async function submitEmail(h: Harness, email: string): Promise<Response> {
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  assert.equal(page.status, 200);
  const request = hiddenRequestToken(await page.text());
  return fetch(`${h.base}/authorize`, form({ request, email }));
}

function localLink(h: Harness, link: string): string {
  const url = new URL(link);
  return `${h.base}/verify${url.search}`;
}

function tokenOf(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
}

async function openLink(h: Harness, link: string): Promise<Response> {
  const confirm = await fetch(localLink(h, link));
  if (confirm.status !== 200) return confirm;
  return fetch(`${h.base}/verify`, { ...form({ token: tokenOf(link) }), redirect: "manual" });
}

async function redeem(h: Harness): Promise<string> {
  const response = await fetch(`${h.base}/verify`, {
    ...form({ token: tokenOf(linkFrom(h.mailer)) }),
    redirect: "manual",
  });
  assert.equal(response.status, 302, await response.text());
  return response.headers.get("location")!;
}

async function exchange(
  h: Harness,
  code: string,
  verifier: string,
  over: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${h.base}/token`, {
    ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier, ...over }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: over.authorization ?? basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
  });
}

async function verifyIdTokenLikePortal(h: Harness, idToken: string, nonce: string): Promise<Record<string, unknown>> {
  const jwks = (await (await fetch(`${h.base}/.well-known/jwks.json`)).json()) as { keys: JWK[] };
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: ISSUER,
    audience: CLIENT_ID,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
  });
  assert.equal(payload.nonce, nonce);
  assert.equal(payload.azp, CLIENT_ID);
  return payload as Record<string, unknown>;
}

test("the WeCom initializer passes the sealed login request to the official component", () => {
  const mount: { dataset: Record<string, string> } = {
    dataset: {
      appid: "wwcorp",
      agentid: "1000002",
      redirectUri: "https://agent.example.test/idp/directory/callback",
      state: "sealed-state",
    },
  };
  const captured: { options?: Record<string, unknown> } = {};
  runInNewContext(WECOM_LOGIN_SCRIPT, {
    document: { documentElement: { lang: "en" }, getElementById: () => mount },
    window: {
      ww: {
        createWWLoginPanel(value: Record<string, unknown>) {
          captured.options = value;
        },
      },
    },
  });
  const options = captured.options;
  assert.ok(options);
  assert.equal(options.el, mount);
  const params = options.params as Record<string, unknown>;
  assert.equal(params.login_type, "CorpApp");
  assert.equal(params.appid, mount.dataset.appid);
  assert.equal(params.agentid, mount.dataset.agentid);
  assert.equal(params.redirect_uri, mount.dataset.redirectUri);
  assert.equal(params.state, mount.dataset.state);
  assert.equal(params.redirect_type, "top");
  assert.equal(params.panel_size, "small");
  const check = options.onCheckWeComLogin as (result: { isWeComLogin: boolean }) => void;
  check({ isWeComLogin: true });
  assert.equal(mount.dataset.clientLoggedIn, "1");
});

test("the whole authorization-code flow the portal drives succeeds", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());

  const { verifier, state } = await requestLink(h);
  assert.equal(h.mailer.sent.length, 1);
  assert.equal(h.mailer.sent[0]!.to, "admin@example.com");

  const location = new URL(await redeem(h));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), state);
  const code = location.searchParams.get("code")!;

  const tokens = await exchange(h, code, verifier);
  assert.equal(tokens.status, 200);
  const body = (await tokens.json()) as {
    id_token: string;
    access_token: string;
    token_type: string;
    expires_in: number;
  };
  assert.equal(body.token_type, "Bearer");
  assert.equal(decodeProtectedHeader(body.id_token).alg, "ES256");

  const claims = await verifyIdTokenLikePortal(h, body.id_token, "nonce-value");
  assert.equal(claims.email, "admin@example.com");
  assert.equal(claims.email_verified, true);

  const info = await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(info.status, 200);
  const userinfo = (await info.json()) as { sub: string; email: string; email_verified: boolean };
  assert.equal(userinfo.sub, claims.sub, "userinfo sub must equal the id_token sub — the portal rejects a mismatch");
  assert.equal(userinfo.email, "admin@example.com");
  assert.equal(userinfo.email_verified, true);
});

test("WeCom web sign-in issues the same OIDC code using the member email", async (t) => {
  const sourceId = "source-wecom";
  let loginOptionsCalls = 0;
  const h = await startHarness({
    directorySources: {
      async loginOptions(state) {
        loginOptionsCalls++;
        return [
          {
            sourceId,
            provider: "wecom",
            displayName: "WeCom",
            authorizeUrl: `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=wwcorp&agentid=1000002&redirect_uri=${encodeURIComponent("https://verified.example.test/corp/wecom")}&state=${encodeURIComponent(state)}`,
          },
        ];
      },
      async resolveCode(receivedSourceId, code) {
        assert.equal(receivedSourceId, sourceId);
        assert.equal(code, "wecom-code");
        return {
          authorizationRequired: false,
          identity: {
            sourceId,
            provider: "wecom",
            externalTenantId: "wwcorp",
            externalSubjectId: "wecom-user",
            displayName: "企业管理员",
            corporateEmail: "admin@example.com",
            corporateEmailVerified: false,
            personalEmail: null,
            employeeNumber: null,
            mobile: null,
            status: "active",
            proof: "test-proof",
          },
        };
      },
    },
  });
  t.after(() => h.close());

  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Sign in with WeCom/);
  const request = hiddenRequestToken(html);

  const login = await fetch(
    `${h.base}/directory/login?request=${encodeURIComponent(request)}&source=${encodeURIComponent(sourceId)}`,
    { redirect: "manual" },
  );
  assert.equal(login.status, 200);
  const loginPage = await login.text();
  assert.match(loginPage, /id="wecom-login"/);
  assert.match(loginPage, /data-appid="wwcorp"/);
  assert.match(loginPage, /data-agentid="1000002"/);
  assert.match(loginPage, /data-redirect-uri="https:\/\/verified\.example\.test\/corp\/wecom"/);
  assert.match(loginPage, /Use QR sign-in instead/);
  assert.match(login.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(login.headers.get("content-security-policy") ?? "", /frame-src https:\/\/login\.work\.weixin\.qq\.com/);
  const directoryState = loginPage.match(/data-state="([^"]+)"/)?.[1];
  assert.ok(directoryState);
  const callsAfterLogin = loginOptionsCalls;
  const claimsAfterLogin = h.claims.calls.length;
  const loginReplay = await fetch(
    `${h.base}/directory/login?request=${encodeURIComponent(request)}&source=${encodeURIComponent(sourceId)}`,
    { redirect: "manual" },
  );
  assert.equal(loginReplay.status, 400);
  assert.equal(loginOptionsCalls, callsAfterLogin);
  assert.equal(h.claims.calls.length, claimsAfterLogin + 1);
  assert.equal(h.claims.calls.at(-1)?.length, 1);
  assert.notEqual(directoryState, request);

  const sdk = await fetch(`${h.base}/wecom-jssdk.js`);
  assert.equal(sdk.status, 200);
  assert.match(sdk.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await sdk.text(), /createWWLoginPanel/);
  const initializer = await fetch(`${h.base}/wecom-login.js`);
  assert.equal(initializer.status, 200);
  const initializerScript = await initializer.text();
  assert.match(initializerScript, /createWWLoginPanel/);
  assert.match(initializerScript, /onCheckWeComLogin/);

  const callback = await fetch(
    `${h.base}/directory/callback?code=wecom-code&state=${encodeURIComponent(directoryState)}`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 302, await callback.text());
  const claimsAfterCallback = h.claims.calls.length;
  const replay = await fetch(
    `${h.base}/directory/callback?code=wecom-code&state=${encodeURIComponent(directoryState)}`,
    { redirect: "manual" },
  );
  assert.equal(replay.status, 400);
  assert.equal(h.claims.calls.length, claimsAfterCallback + 1);
  assert.equal(h.claims.calls.at(-1)?.length, 1);
  assert.equal(
    h.claims.calls.every((ids) => ids.length <= 64),
    true,
  );
  const location = new URL(callback.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), query.get("state"));

  const tokens = await exchange(h, location.searchParams.get("code")!, verifier);
  assert.equal(tokens.status, 200);
  const body = (await tokens.json()) as { id_token: string; access_token: string };
  const claims = await verifyIdTokenLikePortal(h, body.id_token, "nonce-value");
  assert.equal(claims.email, "admin@example.com");
  assert.equal(claims.email_verified, false);
  assert.equal(claims.qm_principal, "directory:source-wecom:wwcorp:wecom-user");
  assert.equal(claims.qm_principal_verified, true);
  assert.equal(claims.name, "企业管理员");
  const info = await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(info.status, 200);
  const userinfo = (await info.json()) as {
    email: string;
    email_verified: boolean;
    qm_principal: string;
    name: string;
    qm_external_identity: { sourceId: string; externalSubjectId: string };
  };
  assert.equal(userinfo.email, "admin@example.com");
  assert.equal(userinfo.email_verified, false);
  assert.equal(userinfo.qm_principal, "directory:source-wecom:wwcorp:wecom-user");
  assert.equal(userinfo.name, "企业管理员");
  assert.equal(userinfo.qm_external_identity.sourceId, sourceId);
  assert.equal(userinfo.qm_external_identity.externalSubjectId, "wecom-user");
});

test("WeCom web login stays on the QR flow without HTTPS or inside the WeCom client", async (t) => {
  const sourceId = "source-wecom-fallback";
  for (const variant of [
    {
      env: {
        AUTH_ISSUER: "http://localhost:8088/idp",
        AUTH_REDIRECT_URI: "http://localhost:8088/auth/callback",
      },
      headers: {},
    },
    { env: {}, headers: { "user-agent": "wxwork/5.0.10" } },
  ]) {
    const h = await startHarness({
      env: variant.env,
      directorySources: {
        async loginOptions(state) {
          return [
            {
              sourceId,
              provider: "wecom",
              displayName: "WeCom",
              authorizeUrl: `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=wwcorp&agentid=1000002&redirect_uri=${encodeURIComponent("https://verified.example.test/corp/wecom")}&state=${encodeURIComponent(state)}`,
            },
          ];
        },
        async resolveCode() {
          throw new Error("callback not expected");
        },
      },
    });
    t.after(() => h.close());
    const query = authorizeQuery({ redirect_uri: h.cfg.redirectUri });
    const page = await fetch(`${h.base}/authorize?${query}`);
    const request = hiddenRequestToken(await page.text());
    const login = await fetch(
      `${h.base}/directory/login?request=${encodeURIComponent(request)}&source=${encodeURIComponent(sourceId)}`,
      { redirect: "manual", headers: variant.headers },
    );
    assert.equal(login.status, 302);
    assert.equal(new URL(login.headers.get("location")!).pathname, "/wwopen/sso/qrConnect");
  }
});

test("an already-bound WeCom QR member signs in without profile authorization when no email is returned", async (t) => {
  const sourceId = "source-no-email";
  const h = await startHarness({
    directorySources: {
      async loginOptions(state) {
        return [
          {
            sourceId,
            provider: "wecom",
            displayName: "WeCom",
            authorizeUrl: `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=${encodeURIComponent(state)}`,
          },
        ];
      },
      async resolveCode() {
        return {
          authorizationRequired: false,
          identity: {
            sourceId,
            provider: "wecom",
            externalTenantId: "wwcorp",
            externalSubjectId: "wecom-user",
            displayName: "无邮箱成员",
            corporateEmail: null,
            corporateEmailVerified: false,
            personalEmail: null,
            employeeNumber: null,
            mobile: null,
            status: "active",
            proof: "test-proof",
          },
        };
      },
    },
  });
  t.after(() => h.close());

  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`);
  assert.equal(page.status, 200);
  const request = hiddenRequestToken(await page.text());
  const login = await fetch(
    `${h.base}/directory/login?request=${encodeURIComponent(request)}&source=${encodeURIComponent(sourceId)}`,
    { redirect: "manual" },
  );
  const directoryState = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(
    `${h.base}/directory/callback?code=wecom-code&state=${encodeURIComponent(directoryState)}`,
    {
      redirect: "manual",
    },
  );
  assert.equal(callback.status, 302, await callback.text());
  const location = new URL(callback.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);

  const tokens = await exchange(h, location.searchParams.get("code")!, verifier);
  assert.equal(tokens.status, 200);
  const body = (await tokens.json()) as { id_token: string; access_token: string };
  const claims = await verifyIdTokenLikePortal(h, body.id_token, "nonce-value");
  assert.equal(claims.qm_principal, "directory:source-no-email:wwcorp:wecom-user");
  assert.equal(claims.qm_principal_verified, true);
  assert.equal(claims.name, "无邮箱成员");
  assert.equal(claims.email, undefined);
  const info = await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } });
  assert.equal(info.status, 200);
  const userinfo = (await info.json()) as {
    email?: string;
    qm_principal: string;
    qm_principal_verified: boolean;
    name: string;
  };
  assert.equal(userinfo.email, undefined);
  assert.equal(userinfo.qm_principal, "directory:source-no-email:wwcorp:wecom-user");
  assert.equal(userinfo.qm_principal_verified, true);
  assert.equal(userinfo.name, "无邮箱成员");
});

const WECOM_CLIENT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/7.0 wxwork/4.1.20";

test("an unbound WeCom QR member authorizes private profile access before OIDC completion", async (t) => {
  const sourceId = "source-private-profile";
  let profileResolutionCalls = 0;
  const h = await startHarness({
    directorySources: {
      async loginOptions(state) {
        return [
          {
            sourceId,
            provider: "wecom",
            displayName: "WeCom",
            authorizeUrl: `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=${encodeURIComponent(state)}`,
          },
        ];
      },
      async resolveCode() {
        return {
          authorizationRequired: true,
          identity: {
            sourceId,
            provider: "wecom",
            externalTenantId: "wwcorp",
            externalSubjectId: "wecom-user",
            displayName: "待授权成员",
            corporateEmail: null,
            corporateEmailVerified: false,
            personalEmail: null,
            employeeNumber: null,
            mobile: null,
            status: "active",
            proof: "initial-proof",
          },
        };
      },
      async profileAuthorizationUrl(receivedSourceId, state) {
        assert.equal(receivedSourceId, sourceId);
        const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
        url.searchParams.set("appid", "wwcorp");
        url.searchParams.set("scope", "snsapi_privateinfo");
        url.searchParams.set("state", state);
        url.hash = "wechat_redirect";
        return { authorizeUrl: url.toString(), promptDelivered: false };
      },
      async resolveProfileAuthorizationCode(receivedSourceId, code, expected) {
        profileResolutionCalls++;
        assert.equal(receivedSourceId, sourceId);
        assert.equal(code, "profile-code");
        assert.deepEqual(expected, {
          provider: "wecom",
          externalTenantId: "wwcorp",
          externalSubjectId: "wecom-user",
        });
        return {
          sourceId,
          provider: "wecom",
          externalTenantId: "wwcorp",
          externalSubjectId: "wecom-user",
          displayName: "已授权成员",
          corporateEmail: "member@example.com",
          corporateEmailVerified: true,
          personalEmail: null,
          employeeNumber: null,
          mobile: null,
          status: "active",
          proof: "profile-proof",
        };
      },
    },
  });
  t.after(() => h.close());

  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`);
  const request = hiddenRequestToken(await page.text());
  const login = await fetch(
    `${h.base}/directory/login?request=${encodeURIComponent(request)}&source=${encodeURIComponent(sourceId)}`,
    { redirect: "manual" },
  );
  const qrState = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const qrCallback = await fetch(`${h.base}/directory/callback?code=wecom-code&state=${encodeURIComponent(qrState)}`, {
    redirect: "manual",
    headers: { "user-agent": WECOM_CLIENT_UA },
  });
  assert.equal(qrCallback.status, 302, await qrCallback.text());
  const privateAuthorization = new URL(qrCallback.headers.get("location")!);
  assert.equal(privateAuthorization.origin, "https://open.weixin.qq.com");
  assert.equal(privateAuthorization.searchParams.get("scope"), "snsapi_privateinfo");
  assert.notEqual(privateAuthorization.searchParams.get("state"), qrState);
  assert.match(privateAuthorization.searchParams.get("state")!, /^[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(privateAuthorization.searchParams.get("state")!) <= 128);
  assert.equal(profileResolutionCalls, 0);

  const profileCallback = await fetch(
    `${h.base}/directory/callback?code=profile-code&state=${encodeURIComponent(privateAuthorization.searchParams.get("state")!)}`,
    { redirect: "manual", headers: { "user-agent": WECOM_CLIENT_UA } },
  );
  assert.equal(profileCallback.status, 302, await profileCallback.text());
  assert.equal(profileResolutionCalls, 1);
  const profileReplay = await fetch(
    `${h.base}/directory/callback?code=profile-code&state=${encodeURIComponent(privateAuthorization.searchParams.get("state")!)}`,
    { redirect: "manual", headers: { "user-agent": WECOM_CLIENT_UA } },
  );
  assert.equal(profileReplay.status, 400);
  assert.equal(profileResolutionCalls, 1);
  const location = new URL(profileCallback.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), query.get("state"));

  const tokens = await exchange(h, location.searchParams.get("code")!, verifier);
  assert.equal(tokens.status, 200);
  const body = (await tokens.json()) as { id_token: string };
  const claims = await verifyIdTokenLikePortal(h, body.id_token, "nonce-value");
  assert.equal(claims.email, "member@example.com");
  assert.equal(claims.email_verified, true);
  assert.equal(claims.qm_principal, `directory:${sourceId}:wwcorp:wecom-user`);
});

function handoffDirectorySources(
  sourceId: string,
  state: { profileCalls: number; prompt: boolean; fail?: boolean; assertContinuationStored?: () => void },
) {
  const identity = {
    sourceId,
    provider: "wecom",
    externalTenantId: "wwcorp",
    externalSubjectId: "wecom-user",
    displayName: "待授权成员",
    corporateEmail: null,
    corporateEmailVerified: false,
    personalEmail: null,
    employeeNumber: null,
    mobile: null,
    status: "active" as const,
    proof: "initial-proof",
  };
  return {
    async loginOptions(loginState: string) {
      return [
        {
          sourceId,
          provider: "wecom",
          displayName: "WeCom",
          authorizeUrl: `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=${encodeURIComponent(loginState)}`,
        },
      ];
    },
    async resolveCode() {
      return { authorizationRequired: true, identity };
    },
    async profileAuthorizationUrl(_sourceId: string, profileState: string, notify?: { externalSubjectId: string }) {
      state.assertContinuationStored?.();
      assert.equal(notify?.externalSubjectId, "wecom-user");
      const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
      url.searchParams.set("scope", "snsapi_privateinfo");
      url.searchParams.set("state", profileState);
      url.hash = "wechat_redirect";
      return { authorizeUrl: url.toString(), promptDelivered: state.prompt };
    },
    async resolveProfileAuthorizationCode() {
      state.profileCalls++;
      if (state.fail) throw new Error("wecom_profile_login_user_mismatch");
      return {
        ...identity,
        corporateEmail: "member@example.com",
        corporateEmailVerified: true,
        proof: "profile-proof",
      };
    },
  };
}

async function startHandoff(h: Harness, sourceId: string) {
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`);
  const request = hiddenRequestToken(await page.text());
  const login = await fetch(
    `${h.base}/directory/login?request=${encodeURIComponent(request)}&source=${encodeURIComponent(sourceId)}`,
    { redirect: "manual" },
  );
  const qrState = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(`${h.base}/directory/callback?code=wecom-code&state=${encodeURIComponent(qrState)}`, {
    redirect: "manual",
  });
  return { verifier, query, callback };
}

test("an unbound WeCom member on a desktop browser hands the consent step to the WeCom client", async (t) => {
  const sourceId = "source-handoff";
  let continuationStored = false;
  const state = {
    profileCalls: 0,
    prompt: true,
    assertContinuationStored: () => assert.equal(continuationStored, true),
  };
  const continuations = memoryContinuations(Date.now);
  const h = await startHarness({
    directorySources: handoffDirectorySources(sourceId, state),
    directoryContinuations: {
      ...continuations,
      async create(...args) {
        const created = await continuations.create(...args);
        if (created === "created") continuationStored = true;
        return created;
      },
    },
  });
  t.after(() => h.close());

  const { verifier, query, callback } = await startHandoff(h, sourceId);
  assert.equal(callback.status, 302, await callback.text());
  const handoffUrl = new URL(callback.headers.get("location")!);
  assert.equal(
    `${handoffUrl.origin}${handoffUrl.pathname}`,
    `${ISSUER}/directory/handoff`,
    "the desktop must return to the configured issuer instead of staying on the callback bridge",
  );
  assert.ok(handoffUrl.searchParams.get("h"));

  const poll = `${h.base}/directory/handoff?h=${encodeURIComponent(handoffUrl.searchParams.get("h")!)}`;
  const waiting = await fetch(poll, { redirect: "manual" });
  assert.equal(waiting.status, 200);
  const waitingHtml = await waiting.text();
  assert.match(waitingHtml, /<svg /, "the waiting page carries an inline QR code");
  assert.doesNotMatch(waitingHtml, /<img /, "a data: image would be blocked by the page CSP");
  assert.match(waiting.headers.get("content-security-policy")!, /script-src 'sha256-/);
  assert.equal(state.profileCalls, 0, "polling must not consume the WeCom authorization");
  assert.equal((await fetch(poll, { redirect: "manual" })).status, 200, "polling again keeps waiting");

  const profileState = new URL(
    /https:\/\/open\.weixin\.qq\.com[^"]*/.exec(waitingHtml)![0].replace(/&amp;/g, "&"),
  ).searchParams.get("state")!;
  const inClient = await fetch(
    `${h.base}/directory/callback?code=profile-code&state=${encodeURIComponent(profileState)}`,
    { redirect: "manual", headers: { "user-agent": WECOM_CLIENT_UA } },
  );
  assert.equal(inClient.status, 200, "the WeCom client sees a completion page, not a redirect");
  assert.equal(inClient.headers.get("location"), null, "redirecting the phone would strand the desktop");
  assert.equal(state.profileCalls, 1);

  const done = await fetch(poll, { redirect: "manual" });
  assert.equal(done.status, 302);
  const location = new URL(done.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
  assert.equal(location.searchParams.get("state"), query.get("state"));

  assert.equal((await fetch(poll, { redirect: "manual" })).status, 200, "a second claim cannot mint a second code");
  const tokens = await exchange(h, location.searchParams.get("code")!, verifier);
  assert.equal(tokens.status, 200);
  const claims = await verifyIdTokenLikePortal(
    h,
    ((await tokens.json()) as { id_token: string }).id_token,
    "nonce-value",
  );
  assert.equal(claims.email, "member@example.com");
  assert.equal(claims.email_verified, true);
});

test("a refused WeCom consent stops the waiting desktop instead of spinning", async (t) => {
  const sourceId = "source-handoff-refused";
  const state = { profileCalls: 0, prompt: false, fail: true };
  const h = await startHarness({ directorySources: handoffDirectorySources(sourceId, state) });
  t.after(() => h.close());

  const { callback } = await startHandoff(h, sourceId);
  const poll = `${h.base}/directory/handoff?h=${encodeURIComponent(new URL(callback.headers.get("location")!, h.base).searchParams.get("h")!)}`;
  const waitingHtml = await (await fetch(poll, { redirect: "manual" })).text();
  const profileState = new URL(
    /https:\/\/open\.weixin\.qq\.com[^"]*/.exec(waitingHtml)![0].replace(/&amp;/g, "&"),
  ).searchParams.get("state")!;

  const inClient = await fetch(
    `${h.base}/directory/callback?code=profile-code&state=${encodeURIComponent(profileState)}`,
    { redirect: "manual", headers: { "user-agent": WECOM_CLIENT_UA } },
  );
  assert.equal(inClient.status, 502);
  const stopped = await fetch(poll, { redirect: "manual" });
  assert.equal(stopped.status, 403, "the desktop is told it failed rather than waiting forever");
  assert.equal(stopped.headers.get("location"), null);
});

test("an expired handoff token stops the desktop poll", async (t) => {
  const sourceId = "source-handoff-expired";
  const state = { profileCalls: 0, prompt: false };
  const h = await startHarness({ directorySources: handoffDirectorySources(sourceId, state) });
  t.after(() => h.close());

  const { callback } = await startHandoff(h, sourceId);
  const poll = `${h.base}/directory/handoff?h=${encodeURIComponent(new URL(callback.headers.get("location")!, h.base).searchParams.get("h")!)}`;
  h.now.ms += (h.cfg.requestTtlS + 60) * 1000;
  const expired = await fetch(poll, { redirect: "manual" });
  assert.equal(expired.status, 400);
});

test("a replayed magic link is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const link = linkFrom(h.mailer);
  assert.equal((await fetch(localLink(h, link))).status, 200, "opening the link only offers to finish sign-in");
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "a mail scanner following the link must not spend it",
  );
  assert.equal((await openLink(h, link)).status, 302);
  const replay = await openLink(h, link);
  assert.equal(replay.status, 400);
  const stale = await replay.text();
  assert.match(stale, /no longer works/);
  assert.match(stale, /href="https:\/\/agent\.example\.test\/auth\/login"/);
});

test("a replayed authorization code is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  assert.equal((await exchange(h, code, verifier)).status, 200);
  const replay = await exchange(h, code, verifier);
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: "invalid_grant" });
});

test("an expired magic link is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const link = linkFrom(h.mailer);
  h.now.ms += (h.cfg.linkTtlS + 60) * 1000;
  const late = await openLink(h, link);
  assert.equal(late.status, 400);
  assert.match(await late.text(), /href="https:\/\/agent\.example\.test\/auth\/login"/);
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "an expired link must not consume a claim",
  );
});

test("an expired authorization code is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  h.now.ms += (h.cfg.codeTtlS + 60) * 1000;
  assert.equal((await exchange(h, code, verifier)).status, 400);
});

test("a mismatched PKCE verifier is refused and the code is still burned", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const wrong = await exchange(h, code, pkcePair().verifier);
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: "invalid_grant" });
  assert.equal(
    (await exchange(h, code, verifier)).status,
    400,
    "a code offered with a bad verifier must not be reusable",
  );
});

test("a missing PKCE verifier is refused", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const response = await fetch(`${h.base}/token`, {
    ...form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(CLIENT_ID, CLIENT_SECRET),
    },
  });
  assert.equal(response.status, 400);
});

test("authorize refuses plain PKCE, an unknown client, and a foreign redirect_uri", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ code_challenge_method: "plain" }, /PKCE with S256/],
    [{ client_id: "someone-else" }, /unknown application/],
    [{ redirect_uri: "https://evil.example.com/auth/callback" }, /not registered/],
    [{ response_type: "token" }, /authorization-code flow/],
    [{ scope: "email" }, /openid scope/],
    [{ state: "" }, /missing its state/],
    [{ nonce: "" }, /missing its nonce/],
  ];
  for (const [over, expected] of cases) {
    const response = await fetch(`${h.base}/authorize?${authorizeQuery(over)}`);
    assert.equal(response.status, 400, JSON.stringify(over));
    assert.match(await response.text(), expected, JSON.stringify(over));
  }
});

test("the token endpoint refuses a wrong client secret and a wrong redirect_uri", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;

  const badSecret = await exchange(h, code, verifier, { authorization: basicAuth(CLIENT_ID, "not-the-secret") });
  assert.equal(badSecret.status, 401);
  assert.deepEqual(await badSecret.json(), { error: "invalid_client" });

  const noCredentials = await fetch(
    `${h.base}/token`,
    form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  );
  assert.equal(noCredentials.status, 401);

  const badRedirect = await exchange(h, code, verifier, { redirect_uri: "https://evil.example.com/auth/callback" });
  assert.equal(badRedirect.status, 400);

  assert.equal(
    (await exchange(h, code, verifier)).status,
    200,
    "rejected attempts must not burn the code before it is honoured",
  );
});

test("a tampered id_token signature does not verify", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const body = (await (await exchange(h, code, verifier)).json()) as { id_token: string };
  const [header, payload, signature] = body.id_token.split(".");
  const flipped = `${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
  await assert.rejects(() => verifyIdTokenLikePortal(h, `${header}.${payload}.${flipped}`, "nonce-value"));

  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
  const forged = `${header}.${Buffer.from(JSON.stringify({ ...decoded, email: "attacker@example.com" })).toString("base64url")}.${signature}`;
  await assert.rejects(() => verifyIdTokenLikePortal(h, forged, "nonce-value"));
});

test("a tampered authorization code does not open", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const parts = code.split(".");
  assert.equal(parts.length, 5);
  assert.doesNotMatch(code, /admin@example\.com/);
  const ciphertext = parts[3]!;
  parts[3] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
  const forged = parts.join(".");
  assert.equal((await exchange(h, forged, verifier)).status, 400);
});

test("an address outside the allowlist is never emailed and never redeemed", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const submitted = await submitEmail(h, "stranger@example.org");
  assert.equal(submitted.status, 403);
  assert.match(await submitted.text(), /This address can&#39;t sign in/);
  await h.settle();
  assert.equal(h.mailer.sent.length, 0, "a disallowed address must not receive a link");
  assert.equal(h.claims.calls.length, 0, "a disallowed address must not consume rate-limit slots");

  const permitted = await startHarness({ env: { AUTH_ALLOWED_EMAILS: "stranger@example.org" } });
  t.after(() => permitted.close());
  await requestLink(permitted, { email: "stranger@example.org" });
  const link = linkFrom(permitted.mailer);

  const narrowed = await startHarness({ env: { AUTH_ALLOWED_EMAILS: "admin@example.com" } });
  t.after(() => narrowed.close());
  const refused = await openLink(narrowed, link);
  assert.notEqual(refused.status, 302, "a link minted for an address that is no longer allowed must not redeem");
});

test("a permitted address still receives the confirmation page", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const submitted = await submitEmail(h, "admin@example.com");
  assert.equal(submitted.status, 200);
  assert.match(await submitted.text(), /Check your email/);
  await h.settle();
  assert.equal(h.mailer.sent.length, 1);
});

test("an email domain allowlist admits the domain and nothing else", async (t) => {
  const h = await startHarness({ env: { AUTH_ALLOWED_EMAILS: undefined, AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } });
  t.after(() => h.close());
  await requestLink(h, { email: "anyone@example.com" });
  assert.equal(h.mailer.sent.length, 1);
  const rejected = await submitEmail(h, "anyone@notexample.com");
  assert.equal(rejected.status, 403);
  assert.equal(h.mailer.sent.length, 1, "a lookalike domain must not be admitted");
});

test("link sends are rate limited per mailbox and per client address", async (t) => {
  const h = await startHarness({ env: { AUTH_SEND_LIMIT_PER_EMAIL: "2", AUTH_SEND_LIMIT_PER_IP: "50" } });
  t.after(() => h.close());
  for (let attempt = 0; attempt < 4; attempt++) await requestLink(h);
  assert.equal(h.mailer.sent.length, 2, "the third and fourth link for one mailbox must be dropped");
  h.now.ms += (h.cfg.sendWindowS + 1) * 1000;
  await requestLink(h);
  assert.equal(h.mailer.sent.length, 3, "a fresh window lets sending resume");

  const perIp = await startHarness({
    env: { AUTH_SEND_LIMIT_PER_IP: "1", AUTH_ALLOWED_EMAIL_DOMAIN: "example.com", AUTH_ALLOWED_EMAILS: undefined },
  });
  t.after(() => perIp.close());
  await requestLink(perIp, { email: "one@example.com" });
  await requestLink(perIp, { email: "two@example.com" });
  assert.equal(perIp.mailer.sent.length, 1, "a single client address cannot fan out across mailboxes");
});

test("rate-limit slot ids are unguessable to another holder of the core signing secret", async (t) => {
  const claims = memoryClaimStore();
  const h = await startHarness({ claims });
  t.after(() => h.close());
  await requestLink(h);
  const ids = claims.calls.flat();
  assert.ok(
    ids.some((id) => id.startsWith("rate:")),
    "rate limiting goes through the durable claim store",
  );
  for (const id of ids) {
    assert.ok(!id.includes("admin@example.com"), id);
    assert.ok(
      !id.includes(createHash("sha256").update("admin@example.com").digest("base64url").slice(0, 22)),
      "a plain digest of the address would be computable offline",
    );
  }
});

test("the broker fails closed when core cannot record a single-use claim", async (t) => {
  const claims = { ...refusingClaimStore(), calls: [] as string[][] };
  const h = await startHarness({ claims });
  t.after(() => h.close());
  const { verifier: _verifier } = await requestLink(h);
  assert.equal(h.mailer.sent.length, 0, "with no durable rate-limit slot the send is suppressed");

  const permissive = await startHarness();
  t.after(() => permissive.close());
  await requestLink(permissive);
  const link = linkFrom(permissive.mailer);
  const failing = await startHarness({ claims: { ...refusingClaimStore(), calls: [] } });
  t.after(() => failing.close());
  const response = await openLink(failing, link);
  assert.notEqual(response.status, 302, "an unrecordable link claim must not mint a code");
});

test("the sign-in link is single-use across broker instances that share the claim store", async (t) => {
  const claims = memoryClaimStore();
  const first = await startHarness({ claims });
  const second = await startHarness({
    claims,
    env: { AUTH_SIGNING_JWK: first.cfg.signingJwk ? JSON.stringify(first.cfg.signingJwk) : undefined },
  });
  t.after(() => first.close());
  t.after(() => second.close());
  await requestLink(first);
  const link = linkFrom(first.mailer);
  assert.equal((await openLink(first, link)).status, 302);
  assert.equal((await openLink(second, link)).status, 400, "a second instance must see the link as spent");
});

test("discovery, JWKS, and health answer without credentials", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.deepEqual(await (await fetch(`${h.base}/healthz`)).json(), { ok: true });
  const jwks = (await (await fetch(`${h.base}/.well-known/jwks.json`)).json()) as {
    keys: Array<Record<string, unknown>>;
  };
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0]!.d, undefined, "the private component must never be published");
  assert.equal(jwks.keys[0]!.alg, "ES256");
  const discovery = (await (await fetch(`${h.base}/.well-known/openid-configuration`)).json()) as Record<
    string,
    unknown
  >;
  assert.equal(discovery.issuer, ISSUER);
  assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
});

test("sign-in pages never cache and never leak a referrer", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
  await requestLink(h);
  const redirect = await fetch(`${h.base}/verify`, {
    ...form({ token: tokenOf(linkFrom(h.mailer)) }),
    redirect: "manual",
  });
  assert.equal(redirect.headers.get("cache-control"), "no-store");
  assert.equal(redirect.headers.get("referrer-policy"), "no-referrer");
});

test("userinfo refuses a missing, malformed, or expired access token", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.equal((await fetch(`${h.base}/userinfo`)).status, 401);
  assert.equal((await fetch(`${h.base}/userinfo`, { headers: { authorization: "Bearer nope" } })).status, 401);
  const { verifier } = await requestLink(h);
  const code = new URL(await redeem(h)).searchParams.get("code")!;
  const body = (await (await exchange(h, code, verifier)).json()) as { access_token: string };
  h.now.ms += (h.cfg.accessTtlS + 60) * 1000;
  assert.equal(
    (await fetch(`${h.base}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } })).status,
    401,
  );
});

test("a stale sign-in form is refused rather than silently reissued", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const page = await fetch(`${h.base}/authorize?${authorizeQuery()}`);
  const request = hiddenRequestToken(await page.text());
  h.now.ms += (h.cfg.requestTtlS + 60) * 1000;
  const submitted = await fetch(`${h.base}/authorize`, form({ request, email: "admin@example.com" }));
  assert.equal(submitted.status, 400);
  assert.match(await submitted.text(), /expired/);
});

test("the sign-in link never puts its token anywhere a server or proxy logs it", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const link = new URL(linkFrom(h.mailer));

  assert.equal(link.search, "", "no query string — the request target is what lands in an access log");
  assert.match(link.hash, /^#token=/, "the token rides in the fragment, which browsers never send to a server");
  const token = tokenOf(link.href);
  assert.ok(token.length > 0);

  const confirm = await fetch(`${h.base}/verify`);
  assert.equal(confirm.status, 200, "the query-less URL a scanner or proxy sees still renders the confirmation");
  const page = await confirm.text();
  assert.ok(!page.includes(token), "the page the server renders cannot contain a token it was never sent");
  assert.match(page, /location\.hash/, "the browser moves the token from the fragment into the form");
  assert.match(page, /history\.replaceState/, "and drops it out of the address bar and history entry");
  assert.match(page, /sessionStorage\.removeItem/, "submitting immediately removes the browser's temporary copy");
  assert.match(page, /once: true/, "a double click cannot submit the same confirmation twice");
  assert.match(page, /Continue as/, "the browser shows the signed link identity before it enables confirmation");
  assert.match(confirm.headers.get("content-security-policy") ?? "", /script-src 'sha256-/);
  assert.match(confirm.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "and none of that spends the link",
  );

  const preview = await fetch(`${h.base}/verify`, { ...form({ token, preview: "1" }), redirect: "manual" });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { email: "admin@example.com" });
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "showing the destination account must not spend the link",
  );

  const spent = await fetch(`${h.base}/verify`, { ...form({ token }), redirect: "manual" });
  assert.equal(spent.status, 302);
  const replay = await fetch(`${h.base}/verify`, { ...form({ token }), redirect: "manual" });
  assert.equal(replay.status, 400, "a token recovered after the fact is already spent");
});

test("a confirmation page reached without a fragment cannot mint anything", async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await requestLink(h);
  const empty = await fetch(`${h.base}/verify`, { ...form({ token: "" }), redirect: "manual" });
  assert.equal(empty.status, 400);
  assert.equal(
    h.claims.calls.some((ids) => ids[0]?.startsWith("link:")),
    false,
    "an empty confirmation must not spend the outstanding link",
  );
});

test("the per-mailbox send limit holds when the client address changes", async (t) => {
  const h = await startHarness({ env: { AUTH_SEND_LIMIT_PER_EMAIL: "2", AUTH_SEND_LIMIT_PER_IP: "50" } });
  t.after(() => h.close());
  for (const clientIp of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
    await requestLink(h, { clientIp });
  }
  assert.equal(h.mailer.sent.length, 2, "rotating the source address must not reset a per-mailbox budget");
});

test("a live brandName accessor overrides the env default on pages and emails", async (t) => {
  let live = "";
  const h = await startHarness({ brandName: () => live || "qm" });
  t.after(() => h.close());

  const { challenge } = pkcePair();
  const query = authorizeQuery({ code_challenge: challenge });
  const before = await (await fetch(`${h.base}/authorize?${query}`)).text();
  assert.match(before, /Sign in to qm/);

  live = "straylight";
  const after = await (
    await fetch(`${h.base}/authorize?${authorizeQuery({ code_challenge: pkcePair().challenge })}`)
  ).text();
  assert.match(after, /Sign in to straylight/);
  assert.doesNotMatch(after, /Sign in to qm/);

  await requestLink(h);
  assert.match(h.mailer.sent[0]!.subject, /straylight/);
});
