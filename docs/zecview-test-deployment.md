# Isolated Cloudflare test deployment

This configuration is for the owner's first Agentic Inbox validation, **not** a production mailbox migration.

## Resources

- Worker: `agentic-inbox-test` (must be created separately from the existing website Worker)
- Private R2 bucket: `agentic-inbox-test` (created in the owner's Cloudflare account)
- Web UI hostname: `inbox.zecview.com` (attach only after Cloudflare Access is configured)
- Allowed mailbox domain: `zecview.com`
- Suggested dedicated inbound address: `agentic-test@zecview.com`. Create an exact-match Email Routing rule to this Worker **after** deployment.

The original `zecview.com` apex and `www.zecview.com` Worker routes remain untouched. The existing `support@zecview.com` forwarding rule and the catch-all policy must not be changed.

The `inbox.zecview.com` DNS A record is currently a documentation-only placeholder; replace it with the Worker Custom Domain only when the app is ready and Access is enforced. DNS is **not** managed by this PR.

## Runtime secrets (Cloudflare Worker Settings)

- `POLICY_AUD`: Cloudflare Access application audience
- `TEAM_DOMAIN`: Cloudflare Access issuer/team domain
- `ADMIN_ACCESS_EMAILS`: authorized administrator identity; **never commit its value**

MCP sending and deletion are disabled unless explicitly enabled through `MCP_ALLOW_SEND` or `MCP_ALLOW_DELETE`. Keep both unset in this test.

## Outbound testing

Sending to arbitrary recipients requires Workers Paid. On Workers Free, the Email Service binding may send only to addresses already verified as Email Routing destination addresses. Verify the test recipient through Cloudflare's confirmation email first; keep any personal recipient addresses out of this public repository.

## Release sequence

1. Review and incorporate hardening PRs #1, #2, #3.
2. Ensure the R2 bucket exists and Cloudflare Access is enabled.
3. Deploy the tested code to a new Worker without changing existing application routes.
4. Set runtime secrets and verify Access denies non-admin callers.
5. Attach the custom domain, replacing only the documented placeholder record.
6. Create the dedicated inbound rule and validate receive / reply / attachment behavior.
7. Send one non-sensitive test message to the verified recipient and check the Cloudflare email activity log.

The GitHub Actions deploy workflow is manual-only. The first deployment requires appropriately scoped Cloudflare credentials and a deliberate branch selection.
