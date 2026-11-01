<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

> **Security hardening in progress (supoju fork).** Production deployment is not recommended until the first security pull requests have been reviewed and verified. Configure your own email domains and Cloudflare Access before sending real email. Pushes to main do **not** automatically deploy.

> **No Zero Trust checkout:** The [Google administrator login option](docs/google-admin-login-free.md) protects `inbox.zecview.com` for `syaoyong@gmail.com` without activating a Cloudflare Zero Trust subscription. This is an unmerged test branch; OAuth client credentials and a live login review are still required.

> **Workers Free outgoing mail:** Cloudflare Email Service cannot send to arbitrary recipients on Workers Free, even though the composer can address them. An [optional Resend Free transport](docs/resend-free-outbound.md) is implemented on this branch for legitimate external recipients. It requires its own verified sending domain and Worker Secret. **No live sending or public login is enabled until those credentials and a reviewed authentication alternative are in place.**

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)


Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## How to setup

**Important**: Clicking the 'Deploy to Cloudflare' button is only one part of the setup. You must follow the **After deploying** steps as well. For a full step-by-step guide with screenshots, refer to this comment: 
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### To set up

1. Review the configuration and deploy this fork manually after tests pass. Set your own **DOMAINS** value in `wrangler.jsonc` (the example configuration intentionally starts empty). Run `npm run deploy` after configuring Cloudflare resources and Access. Do not use the upstream project's one-click deployment button; it deploys a different repository.

2. **Configure Cloudflare Access** -- Enable [one-click Cloudflare Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on your Worker under Settings > Domains & Routes. The modal will show your `POLICY_AUD` and `TEAM_DOMAIN` values. `TEAM_DOMAIN` can be either your Access team URL or the full `.../cdn-cgi/access/certs` URL. **You must set these as secrets for your Worker.**
3. **Set up Email Routing** -- In the Cloudflare dashboard, go to your domain > Email Routing and create a catch-all rule that forwards to this Worker
4. **Enable Email Service** -- The worker needs the `send_email` binding to send outbound emails. See [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
5. **Create a mailbox** -- Visit your deployed app and create a mailbox for any address on your domain (e.g. `hello@example.com`)

### Troubleshooting Access

1. If you see `Invalid or expired Access token`, that usually means `POLICY_AUD` or `TEAM_DOMAIN` secrets are incorrect.
   * Resolution: [turn Access off and back on for the Worker to get the Access modal again](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then reset your Worker secrets to the latest `POLICY_AUD` and `TEAM_DOMAIN` values shown there.
2. If you see `Cloudflare Access must be configured in production`, this application is intentionally enforcing Cloudflare Access so your inbox is not exposed to anyone on the internet.
   * Resolution: enable Access using [one-click Cloudflare Access for Workers](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then set the `POLICY_AUD` and `TEAM_DOMAIN` Worker secrets from the modal values.

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** — Side panel with 9 email tools for reading, searching, drafting, and sending
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Administrator identity and MCP permissions

This is designed for a **single operator or one trusted administrator group**. Every allowlisted identity can read and manage **all** mailboxes. There is no per-mailbox role separation.

In addition to `POLICY_AUD` and `TEAM_DOMAIN`, production requires the Worker secret `ADMIN_ACCESS_EMAILS` containing the exact Cloudflare Access login email(s), separated by commas. Configure it with `wrangler secret put ADMIN_ACCESS_EMAILS` on your own account; never commit the value to Git. A missing value fails closed. Cloudflare service-token identities without an email claim are not accepted by this interface.

MCP's `send_email`, `send_reply`, and `delete_email` tools are **disabled by default**. This prevents an external Agent from directly sending or permanently deleting mail merely because its instructions say to. To explicitly opt in, set `MCP_ALLOW_SEND=true` and/or `MCP_ALLOW_DELETE=true` in the Worker environment. Enabling send does **not** add a human-approval step. Reading, draft management and reversible folder actions remain available through MCP to authorized users.

## Attachment behavior in this fork

- Uploaded images are sent with their original bytes. The previous automatic EXIF/ICC stripping has been removed because it could change orientation, color, or animation.
- JPEG, PNG, GIF, and WebP can appear inline in the composer. Other file types are attached normally.
- Removing an inline image attachment also removes its editor image. Sending is blocked if an unlinked base64 image remains in the body.
- **Draft limitation:** the current drafts API cannot persist MIME attachments. Saving a draft with files or inline images is blocked with a clear warning, rather than silently losing them.

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, Workers AI (`@cf/moonshotai/kimi-k2.5`), `react-markdown` + `remark-gfm`
- **Auth:** Cloudflare Access JWT or Google OpenID Connect single-admin session (select one; required outside local development)

## Getting Started

```bash
npm install
npm run dev
```

### Configuration

1. Set your domain in `wrangler.jsonc`
2. Create an R2 bucket named `agentic-inbox`: `wrangler r2 bucket create agentic-inbox`

### Deploy

After code review, successful checks, and domain/Access configuration, deploy manually:

```bash
npm run deploy
```

The GitHub Actions deployment workflow is manual-only (`workflow_dispatch`); a push to `main` does not deploy. Outbound attachments are limited to 18 MiB of raw data in total because Cloudflare Email Service limits each full encoded message to 25 MiB.

For internal Worker-to-Worker sending, use an explicitly authenticated service integration. A missing `cf-ray` header is not accepted as proof of trusted service origin.

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled (for the agent)
- A configured authentication provider: [Google OIDC single-admin option](docs/google-admin-login-free.md) or [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (production requires one, not both)

Any user who passes the shared Cloudflare Access policy can access all mailboxes in this app by design. This includes the MCP server at `/mcp` -- external AI tools (Claude Code, Cursor, etc.) connected via MCP can operate on any mailbox by passing a `mailboxId` parameter. There is no per-mailbox authorization; the Cloudflare Access policy is the single trust boundary.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │  9 email tools  │
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).
