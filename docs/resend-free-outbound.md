# Resend Free outbound for Agentic Inbox

This branch adds an optional Resend HTTPS sending transport while retaining
Cloudflare Email Routing and all existing mailbox storage/UI features.

## Why

Cloudflare Workers Free can receive email and send to *verified* routing
destinations, but Cloudflare Email Service requires Workers Paid for outbound
email to arbitrary recipients. The original Cloudflare, security00 and supoju
forks all use `env.EMAIL.send()`; the previous hardening did not remove a
Free-plan bypass.

Resend Free currently lists 3,000 emails/month, 100/day and three verified
domains. It can send from different local parts of a verified domain through
the HTTPS Email API. It is a separate provider with its own restrictions and
acceptable-use policy. It must not be used for unsolicited cold outreach.

## What this code changes

- `OUTBOUND_EMAIL_PROVIDER=resend` selects the HTTPS API for compose, reply,
  forward and (when separately opted in) MCP send tools.
- The previous Cloudflare binding implementation is retained as
  `OUTBOUND_EMAIL_PROVIDER=cloudflare`.
- There is **no automatic provider fallback**. If Resend is selected but
  `RESEND_API_KEY` is absent, every send fails before any network request.
- Attachments remain Base64 for the Resend API; Cloudflare's binding still
  receives decoded raw bytes. Inline images keep their `content_id`.
- Resend's returned API resource ID is not confused with the message's
  RFC 5322 Message-ID. A successful API request means Resend accepted it,
  not that the destination inbox received it.
- **Known threading limitation:** the send response returns only a Resend API ID,
  not the delivered message's RFC `Message-ID`. Until the app correlates the
  actual ID via a verified Resend `email.sent` webhook, replies to a message
  initiated by this app may fail to group with the saved Sent item. Do not
  mistake the app's generated placeholder for the actual outbound header.
  A domain-scoped **sending-only** key cannot retrieve Sent message metadata;
  do not broaden key permissions solely to work around this limitation.
- Outbound plaintext/HTML and attachments are sent to Resend, not only
  Cloudflare. Do not use this provider for content you cannot disclose to it.

## Before any live deployment

1. Create a **Resend Free** account after reviewing its acceptable-use rules.
   Register the sending domain (for example `zecview.com`) with **sending
   only** enabled. Review the exact SPF/DKIM/return-path DNS records offered
   by Resend before making changes. **Do not replace the existing root MX
   records, Cloudflare Email Routing or existing forwarding rules.**
2. Create a Resend **sending-only** API key. If the account supports
   domain-scoped keys, limit it to the verified domain.
3. Add `RESEND_API_KEY` as an encrypted **Cloudflare Worker Secret** on the
   isolated `agentic-inbox-test` Worker. Never commit it or publish it in
   GitHub Actions logs. The checked-in Wrangler config explicitly sets
   `OUTBOUND_EMAIL_PROVIDER` to `resend`.
4. **Do not deploy a public inbox yet.** This hardened fork currently requires
   Cloudflare Access and is fail-closed without `POLICY_AUD`, `TEAM_DOMAIN`
   and `ADMIN_ACCESS_EMAILS`. The operator declined Zero Trust Free's
   potential usage-overage billing authorization. A separate, reviewed
   authentication method must be implemented and tested first. Do not
   disable the existing JWT middleware simply to make the page accessible.
5. Once the private login is working, validate a normal outbound message,
   a reply with threading headers, a forwarded message and an inline image
   sent to a **non-Cloudflare-verified test recipient** under your control.
   Check the recipient mailbox and provider delivery logs; do not infer
   successful delivery solely from a 200 response.
6. Keep AI/MCP send/delete controls disabled until the administrator
   explicitly opts in. Monitor provider quotas and failures.

## Source documentation

- Cloudflare Email Service pricing:
  https://developers.cloudflare.com/email-service/platform/pricing/
- Resend Free limits: https://resend.com/pricing
- Resend Email API: https://resend.com/docs/api-reference/emails/send-email
- Resend Cloudflare Workers integration:
  https://resend.com/docs/send-with-cloudflare-workers
- Resend AUP: https://resend.com/legal/acceptable-use
