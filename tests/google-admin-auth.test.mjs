import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import {
  startGoogleLogin, finishGoogleLogin, verifyGoogleAdminIdentity,
  isGoogleAdminSession, isTrustedBrowserOrigin,
} from "../workers/lib/google-admin-auth.ts";

const env = {
  ADMIN_ORIGIN: "https://inbox.zecview.com",
  ADMIN_ACCESS_EMAILS: "syaoyong@gmail.com",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  SESSION_SIGNING_KEY: "a".repeat(64),
};

function cookiesFrom(response) {
  return response.headers.getSetCookie();
}
function cookieValue(response, name) {
  const found = cookiesFrom(response).find(c => c.startsWith(name + "="));
  return found?.split(";")[0];
}

test("Google login issues state + nonce + PKCE challenge without exposing secrets", async () => {
  const response = await startGoogleLogin(env);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get("Location"));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), "https://inbox.zecview.com/auth/callback");
  assert.equal(url.searchParams.get("scope"), "openid email");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("nonce"));
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("code_challenge"));
  const stateCookie = cookiesFrom(response).find(c => c.startsWith("__Host-inbox_oauth="));
  assert.match(stateCookie, /Secure; HttpOnly; SameSite=Lax/);
  assert.ok(!url.toString().includes(env.GOOGLE_OAUTH_CLIENT_SECRET));
});

test("Google login and callback produce a signed host-only session for exact Gmail administrator", async () => {
  const started = await startGoogleLogin(env);
  const state = new URL(started.headers.get("Location")).searchParams.get("state");
  const oauthCookie = cookieValue(started, "__Host-inbox_oauth");
  let exchanges = 0;
  const callback = await finishGoogleLogin(
    new Request("https://inbox.zecview.com/auth/callback?code=test-code&state=" + state, {
      headers: { Cookie: oauthCookie },
    }),
    env,
    async (url, init) => {
      exchanges++;
      assert.equal(url, "https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("code"), "test-code");
      assert.equal(body.get("redirect_uri"), env.ADMIN_ORIGIN + "/auth/callback");
      assert.ok(body.get("code_verifier"));
      assert.equal(body.get("client_secret"), env.GOOGLE_OAUTH_CLIENT_SECRET);
      return Response.json({ id_token: "test-signed-id-token" });
    },
    async (token, clientId, nonce, allowed) => {
      assert.equal(token, "test-signed-id-token");
      assert.equal(clientId, env.GOOGLE_OAUTH_CLIENT_ID);
      assert.equal(allowed, env.ADMIN_ACCESS_EMAILS);
      assert.ok(nonce);
      return { email: "syaoyong@gmail.com", sub: "google-account-id" };
    },
  );
  assert.equal(exchanges, 1);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("Location"), env.ADMIN_ORIGIN + "/");
  const sessionCookie = cookieValue(callback, "__Host-inbox_session");
  assert.ok(sessionCookie);
  assert.equal(await isGoogleAdminSession(new Request(env.ADMIN_ORIGIN + "/api/v1/mailboxes", {
    headers: { Cookie: sessionCookie },
  }), env), true);
  assert.equal(await isGoogleAdminSession(new Request(env.ADMIN_ORIGIN + "/api/v1/mailboxes"), env), false);
  assert.equal(await isGoogleAdminSession(new Request("https://other.example.com", {
    headers: { Cookie: sessionCookie },
  }), env), false);
  assert.equal(await isGoogleAdminSession(new Request(env.ADMIN_ORIGIN, {
    headers: { Cookie: sessionCookie },
  }), { ...env, ADMIN_ACCESS_EMAILS: "someoneelse@gmail.com" }), false);
  assert.equal(await isGoogleAdminSession(new Request(env.ADMIN_ORIGIN, {
    headers: { Cookie: sessionCookie },
  }), { ...env, SESSION_SIGNING_KEY: "b".repeat(64) }), false);
});

test("OAuth callback blocks missing, forged and expired state before token exchange", async () => {
  let called = false;
  const fakeFetch = async () => { called = true; throw new Error("unexpected"); };
  const missing = await finishGoogleLogin(
    new Request(env.ADMIN_ORIGIN + "/auth/callback?code=foo&state=bad"), env, fakeFetch,
  );
  assert.equal(missing.status, 403);
  const started = await startGoogleLogin(env);
  const state = new URL(started.headers.get("Location")).searchParams.get("state");
  const forged = await finishGoogleLogin(
    new Request(env.ADMIN_ORIGIN + "/auth/callback?code=foo&state=" + state + "forged", {
      headers: { Cookie: cookieValue(started, "__Host-inbox_oauth") },
    }), env, fakeFetch,
  );
  assert.equal(forged.status, 403);
  const oldCookie = cookieValue(started, "__Host-inbox_oauth").replace(/\.[0-9]+$/, "." + (Date.now() - 700_000));
  const expired = await finishGoogleLogin(
    new Request(env.ADMIN_ORIGIN + "/auth/callback?code=foo&state=" + state, {
      headers: { Cookie: oldCookie },
    }), env, fakeFetch,
  );
  assert.equal(expired.status, 403);
  assert.equal(called, false);
});

test("Google ID token must be signed for correct audience, nonce, verified email and allowlist", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const build = async (email, nonce = "fresh-nonce", verified = true, audience = env.GOOGLE_OAUTH_CLIENT_ID) =>
    new SignJWT({ email, email_verified: verified, nonce })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(audience)
      .setSubject("google-subject-123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  const valid = await build("syaoyong@gmail.com");
  assert.deepEqual(
    await verifyGoogleAdminIdentity(valid, env.GOOGLE_OAUTH_CLIENT_ID, "fresh-nonce", env.ADMIN_ACCESS_EMAILS, publicKey),
    { email: "syaoyong@gmail.com", sub: "google-subject-123" },
  );
  for (const token of [
    await build("attacker@gmail.com"),
    await build("syaoyong@gmail.com", "wrong-nonce"),
    await build("syaoyong@gmail.com", "fresh-nonce", false),
    await build("syaoyong@gmail.com", "fresh-nonce", true, "different-client"),
  ]) {
    await assert.rejects(verifyGoogleAdminIdentity(
      token, env.GOOGLE_OAUTH_CLIENT_ID, "fresh-nonce", env.ADMIN_ACCESS_EMAILS, publicKey,
    ));
  }
});

test("browser-origin policy protects API state changes and WebSocket upgrades", () => {
  const trusted = env.ADMIN_ORIGIN;
  const req = (method, origin, upgrade) => new Request(trusted + "/api/v1/mailboxes", {
    method,
    headers: { Origin: origin, ...(upgrade ? { Upgrade: upgrade } : {}) },
  });
  assert.equal(isTrustedBrowserOrigin(req("POST", trusted), trusted), true);
  assert.equal(isTrustedBrowserOrigin(req("POST", "https://evil.example.com"), trusted), false);
  assert.equal(isTrustedBrowserOrigin(req("POST", "https://www.zecview.com"), trusted), false);
  assert.equal(isTrustedBrowserOrigin(req("GET", "https://evil.example.com", "websocket"), trusted), false);
  assert.equal(isTrustedBrowserOrigin(req("GET", "https://evil.example.com"), trusted), true);
});

test("missing Google credentials fail closed, not open", async () => {
  assert.equal((await startGoogleLogin({ ...env, GOOGLE_OAUTH_CLIENT_SECRET: "" })).status, 503);
  assert.equal(await isGoogleAdminSession(new Request(env.ADMIN_ORIGIN), {
    ...env, SESSION_SIGNING_KEY: "weak",
  }), false);
});
