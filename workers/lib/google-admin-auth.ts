// Single-administrator Google OpenID Connect login for deployments that cannot
// enable Cloudflare Access. All protected routes still deny anonymous requests.
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { isAllowedAccessEmail } from "./access-policy";

export interface GoogleAdminEnv {
  ADMIN_ORIGIN?: string;
  ADMIN_ACCESS_EMAILS?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SESSION_SIGNING_KEY?: string;
}

const OAUTH_COOKIE = "__Host-inbox_oauth";
const SESSION_COOKIE = "__Host-inbox_session";
const SESSION_AUDIENCE = "agentic-inbox-admin";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const AUTH_MAX_AGE_SECONDS = 600;
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function config(env: GoogleAdminEnv) {
  const origin = env.ADMIN_ORIGIN;
  if (!origin || !env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET ||
      !env.ADMIN_ACCESS_EMAILS?.trim() || !env.SESSION_SIGNING_KEY ||
      new TextEncoder().encode(env.SESSION_SIGNING_KEY).length < 32) {
    throw new Error("Google login is not configured");
  }
  let url: URL;
  try { url = new URL(origin); }
  catch { throw new Error("Invalid Google admin origin"); }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new Error("Google admin origin must be a canonical HTTPS origin");
  }
  return {
    origin,
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    allowlist: env.ADMIN_ACCESS_EMAILS,
    sessionKey: new TextEncoder().encode(env.SESSION_SIGNING_KEY),
  };
}

function hexRandom(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), n => n.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | undefined {
  return request.headers.get("Cookie")?.split(";").map(entry => entry.trim())
    .find(entry => entry.startsWith(name + "="))?.slice(name.length + 1);
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

function denyAuth(message: string, status: number, clearTemporaryCookie = false): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (clearTemporaryCookie) headers.append("Set-Cookie", cookie(OAUTH_COOKIE, "", 0));
  return new Response(message, { status, headers });
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Begin an OAuth2 authorization-code flow with state, nonce and PKCE. */
export async function startGoogleLogin(env: GoogleAdminEnv): Promise<Response> {
  let cfg: ReturnType<typeof config>;
  try { cfg = config(env); }
  catch { return denyAuth("Google administrator login is not configured", 503); }

  const state = hexRandom(32);
  const nonce = hexRandom(32);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.origin + "/auth/callback",
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  const oauthCookie = [state, nonce, verifier, String(Date.now())].join(".");
  return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString(), [
    cookie(OAUTH_COOKIE, oauthCookie, AUTH_MAX_AGE_SECONDS),
  ]);
}

/** Check a Google ID token's cryptographic identity and the exact admin allowlist. */
export async function verifyGoogleAdminIdentity(
  idToken: string,
  clientId: string,
  nonce: string,
  allowedEmails: string,
  keySet: Parameters<typeof jwtVerify>[1] = GOOGLE_JWKS,
): Promise<{ email: string; sub: string }> {
  const { payload } = await jwtVerify(idToken, keySet, {
    issuer: ["accounts.google.com", "https://accounts.google.com"],
    audience: clientId,
    algorithms: ["RS256"],
  });
  if (payload.nonce !== nonce || payload.email_verified !== true ||
      !isAllowedAccessEmail(payload.email, allowedEmails) ||
      typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("Google identity is not an authorized administrator");
  }
  return { email: (payload.email as string).trim().toLowerCase(), sub: payload.sub };
}

/** Exchange a one-time code, verify Google and issue an 8-hour HttpOnly session. */
export async function finishGoogleLogin(
  request: Request,
  env: GoogleAdminEnv,
  fetcher: typeof fetch = fetch,
  verifyIdentity: typeof verifyGoogleAdminIdentity = verifyGoogleAdminIdentity,
): Promise<Response> {
  let cfg: ReturnType<typeof config>;
  try { cfg = config(env); }
  catch { return denyAuth("Google administrator login is not configured", 503, true); }

  const currentUrl = new URL(request.url);
  if (currentUrl.origin !== cfg.origin) return denyAuth("Incorrect login origin", 403, true);
  const [state, nonce, verifier, issuedText] = (readCookie(request, OAUTH_COOKIE) || "").split(".");
  const now = Date.now();
  const issued = Number(issuedText);
  if (!state || !nonce || !verifier || !/^[0-9]+$/.test(issuedText || "") ||
      issued > now || now - issued > AUTH_MAX_AGE_SECONDS * 1000 ||
      currentUrl.searchParams.get("state") !== state ||
      !currentUrl.searchParams.get("code")) {
    return denyAuth("Invalid or expired login state", 403, true);
  }

  try {
    const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: currentUrl.searchParams.get("code")!,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.origin + "/auth/callback",
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) throw new Error("Google token endpoint rejected the code");
    const tokens = await tokenResponse.json() as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new Error("Missing Google ID token");
    const identity = await verifyIdentity(tokens.id_token, cfg.clientId, nonce, cfg.allowlist);
    const session = await new SignJWT({ email: identity.email, gsub: identity.sub })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(cfg.origin)
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(SESSION_MAX_AGE_SECONDS + "s")
      .sign(cfg.sessionKey);
    return redirect(cfg.origin + "/", [
      cookie(OAUTH_COOKIE, "", 0),
      cookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SECONDS),
    ]);
  } catch {
    // Never expose OAuth codes, Google tokens or account details in responses or logs.
    return denyAuth("Login failed or administrator not authorized", 403, true);
  }
}

export async function isGoogleAdminSession(request: Request, env: GoogleAdminEnv): Promise<boolean> {
  let cfg: ReturnType<typeof config>;
  try { cfg = config(env); }
  catch { return false; }
  if (new URL(request.url).origin !== cfg.origin) return false;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, cfg.sessionKey, {
      issuer: cfg.origin,
      audience: SESSION_AUDIENCE,
      algorithms: ["HS256"],
    });
    return typeof payload.gsub === "string" && !!payload.gsub &&
      isAllowedAccessEmail(payload.email, cfg.allowlist);
  } catch { return false; }
}

/** Block CSRF and WebSocket hijacking from same-site sibling domains too. */
export function isTrustedBrowserOrigin(request: Request, expectedOrigin: string): boolean {
  const method = request.method.toUpperCase();
  const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method) && !websocket) return true;
  const origin = request.headers.get("Origin");
  if (origin) return origin === expectedOrigin;
  // Browsers identify cross-origin requests even if they omit Origin.
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

export function logoutGoogleAdmin(): Response {
  return redirect("/auth/login", [cookie(SESSION_COOKIE, "", 0), cookie(OAUTH_COOKIE, "", 0)]);
}
