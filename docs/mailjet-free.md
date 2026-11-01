# Mailjet Free outbound transport (isolated integration)

This branch adds an **optional** Mailjet Send API v3.1 adapter to the existing
Agentic Inbox outbound transport. It does not alter incoming Cloudflare Email
Routing, the admin Google OAuth session, or the R2 mailbox data.

## Requirements

- A Mailjet account on the **Free** plan. As published on 2026-11-01,
  Mailjet offers up to 6,000 emails/month, 200/day, API/SMTP, and no
  credit card required for Free.
- Each sending domain/address must be validated as a Mailjet sender.
  Mailjet documents up to 100 sender domains or individual sender addresses
  per API key. Confirm the actual account allowance before bulk onboarding.
- Configure SPF/DKIM authentication for each domain using Mailjet's supplied
  DNS records. **Do not remove or replace Cloudflare Email Routing MX rules**.
  If an SPF TXT record already exists, merge authorized mechanisms into a
  single SPF record; do not create two SPF TXT records for the same hostname.
- Sending must comply with Mailjet's anti-spam requirements. An arbitrary
  destination *technical capability* does not authorize unsolicited mail.

## Set up Worker secrets

Add both values as **encrypted Cloudflare Worker Secrets** in the isolated
environment. Never commit them to GitHub or print them to build logs:

- `MAILJET_API_KEY` — Mailjet public API key (still stored as a Worker Secret).
- `MAILJET_SECRET_KEY` — Mailjet private API key.

Set `OUTBOUND_EMAIL_PROVIDER=mailjet` in the isolated Worker's environment
variables only after validating both secrets. The current production default
`resend` remains unchanged until end-to-end tests pass.

## Supported sending features

- Multiple validated sender domains and sender addresses
- To, Cc, Bcc; From display name; Reply-To
- Plain text and HTML bodies
- In-Reply-To and References custom headers for conversation threading
- Regular and inline attachments through base64
- No implicit fallback to Cloudflare or Resend when credentials are absent
- Provider acceptance errors surfaced to the compose UI
- API resource IDs kept separate from RFC Message-ID values

## Verification checklist

1. Confirm Mailjet has approved the Free account for transactional sends.
2. Validate one **non-production** sender domain and verify its DNS
   authentication in Mailjet.
3. Send from that domain to an external inbox that the user controls.
4. Inspect the recipient's SPF/DKIM/DMARC authentication results.
5. Test a genuine reply, CC/BCC, and an inline/regular attachment.
6. Verify a second sender domain and then a larger domain count before
   treating Mailjet as a solution for 10+ domains.
7. Only after successful testing, consider a separate production deployment
   with a rollback version retained.

The existing live Worker `agentic-inbox-test` and
`https://inbox.zecview.com` must not be modified during these tests.

## References

- https://www.mailjet.com/pricing/
- https://documentation.mailjet.com/hc/en-us/articles/360043050493-How-many-senders-can-be-added-to-my-account
- https://dev.mailjet.com/docs/email-api/send-api-v31/send-basic-email
- https://dev.mailjet.com/docs/email-api/send-api-v31/send-attached-files
- https://dev.mailjet.com/docs/email-api/send-api-v31/add-email-headers
