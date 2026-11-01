# Isolated Cloudflare test deployment

This configuration is for the owner's first Agentic Inbox validation, **not** a production mailbox migration.

## Resources

- Worker: `agentic-inbox-test` (must be created separately from the existing website Worker)
- Private R2 bucket: `agentic-inbox-test` (created in the owner's Cloudflare account)
- Web UI hostname: `inbox.zecview.com` (attach only after Google administrator login is configured and tested)
- Allowed mailbox domain: `zecview.com`
- Suggested dedicated inbound address: `agentic-test@zecview.com`. Create an exact-match Email Routing rule to this Worker **after** deployment.

The original `zecview.com` apex and `www.zecview.com` Worker routes remain untouched. The existing `support@zecview.com` forwarding rule and the catch-all policy must not be changed.

The `inbox.zecview.com` DNS A record is currently a documentation-only placeholder; replace it with the Worker Custom Domain only when the app is ready and Access is enforced. DNS is **not** managed by this PR.

## Runtime secrets (Cloudflare Worker Settings)

- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`: Google Web OAuth credentials
- `SESSION_SIGNING_KEY`: high-entropy cookie-signing secret
- `ADMIN_ACCESS_EMAILS`: exact allowed Gmail identity; **never commit any secret value**

MCP sending and deletion are disabled unless explicitly enabled through `MCP_ALLOW_SEND` or `MCP_ALLOW_DELETE`. Keep both unset in this test.

## Outbound testing

The original Cloudflare Email Service binding requires Workers Paid for arbitrary external recipients. This test branch selects Resend Free for outbound; verify the sending domain and use a sending-only API key stored as `RESEND_API_KEY` Worker Secret. The first real send must target an external address under the operator's control. Do not reveal recipient personal addresses or API keys in Git.

## Release sequence

1. Review and incorporate hardening PRs #1, #2, #3.
2. Ensure the R2 bucket exists and Google administrator login secrets are configured without activating Zero Trust.
3. Deploy the tested code to a new Worker without changing existing application routes.
4. Set runtime secrets and verify Google login denies anonymous/non-admin callers and unsafe cross-origin requests.
5. Attach the custom domain, replacing only the documented placeholder record.
6. Create the dedicated inbound rule and validate receive / reply / attachment behavior.
7. Send one non-sensitive test message to a recipient you control and check Resend's sending activity log.

The GitHub Actions deploy workflow is manual-only. The first deployment requires appropriately scoped Cloudflare credentials and a deliberate branch selection.
