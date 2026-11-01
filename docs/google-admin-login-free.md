# Free single-administrator Google login (no Zero Trust checkout)

This optional login path is for the owner's `inbox.zecview.com` administration
interface. It is **not** an email forwarding destination and it does **not**
replace Cloudflare Email Routing or Resend sending.

The operator declined Cloudflare Zero Trust Free checkout's potential-overage
billing authorization. This branch therefore supports Google OpenID Connect
directly in the Worker, without requiring a Cloudflare Access application or
Zero Trust subscription. This is **draft code only**, not a production claim
or an authorization to create Google/Cloudflare resources.

## Security boundaries

- `AUTH_PROVIDER=google` in `wrangler.jsonc` protects every UI, API, MCP and
  Agent WebSocket request. Anonymous API/MCP requests get 401; unauthenticated
  browser navigation is redirected to Google login.
- Login uses OAuth2 authorization code + PKCE, a one-time random state, ID-token
  signature/audience/issuer/expiration/nonce verification and `email_verified`.
  The signed-in address must exactly match `ADMIN_ACCESS_EMAILS`. The Google
  user identifier is `sub`; no trust is placed in client-supplied email alone.
- Sessions are signed with `SESSION_SIGNING_KEY`, stored in host-only,
  `Secure`, `HttpOnly`, `SameSite=Lax` cookies, and expire after 8 hours.
  State-changing requests and WebSocket upgrades also check browser origin.
- Missing credentials, an incorrect origin or an unknown provider **deny all
  protected routes**. The previous `AUTH_PROVIDER=cloudflare` path is retained
  for users with Cloudflare Access configured.
- One Google account is allowed to operate **all** mailboxes. This is not a
  per-mailbox login/permission system. Do not grant other users access unless
  you intentionally accept that scope.
- Until a security review and live OAuth login test succeed, keep the
  `inbox.zecview.com` custom domain disconnected and the Worker private.
  Do not bypass authentication to unblock a deployment.

## Setup after review (user must approve account and DNS actions)

1. In Google Cloud Console, configure an OAuth consent screen and a **Web
   application** OAuth client. Set the **exact** authorized redirect URI to:
   `https://inbox.zecview.com/auth/callback`.
   If the consent screen is in testing, list `syaoyong@gmail.com` as a test
   user. Only OpenID/email scopes are required. **If Google asks you to enable
   billing or authorize charges, pause and get explicit operator approval; do
   not accept financial terms automatically.**
2. On isolated Cloudflare Worker `agentic-inbox-test`, set these as encrypted
   Worker Secrets (do not put their values in Git or chat):

   - `GOOGLE_OAUTH_CLIENT_ID` — the web OAuth client identifier
   - `GOOGLE_OAUTH_CLIENT_SECRET` — that client's secret
   - `ADMIN_ACCESS_EMAILS` — exact allowed Google identity, currently
     `syaoyong@gmail.com`
   - `SESSION_SIGNING_KEY` — at least 32 cryptographically random bytes;
     e.g. generate locally with `openssl rand -hex 32`

3. The test `wrangler.jsonc` already selects `AUTH_PROVIDER=google` and sets
   `ADMIN_ORIGIN=https://inbox.zecview.com`. Do not change the canonical
   origin unless the Google redirect URI is updated to match.
4. Run CI tests and deploy the isolated Worker through the manual workflow.
   Attach only the approved `inbox.zecview.com` Worker custom domain after
   verifying that all secrets are installed and the login path fails closed.
5. Verify Google login permits only the specified Gmail account; check API,
   MCP and WebSocket access before and after login, cross-origin POST/upgrade
   denial, session expiry and logout. Then proceed with inbound routing and
   one non-sensitive Resend test message to a recipient you control.

## Limitations

- A stolen session cookie remains usable until its short expiry or a rotation
  of `SESSION_SIGNING_KEY`. Google account logout alone does not revoke the
  Worker session; rotation invalidates all sessions.
- Using Google authentication makes Google an additional availability and
  identity dependency; it does not imply a Google Workspace subscription.
- There is no separate MCP OAuth handshake: remote AI clients must authenticate
  explicitly if enabled, and its send/delete tools remain disabled by default.
- This is a separate reviewed security change; it does not accept any checkout,
  billing overages, paid plan, domain-MX changes or live deployment.
