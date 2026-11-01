// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	/** Google OAuth credentials and random session signing key (all Worker Secrets). */
	GOOGLE_OAUTH_CLIENT_ID?: string;
	GOOGLE_OAUTH_CLIENT_SECRET?: string;
	SESSION_SIGNING_KEY?: string;
	/** Resend sending-only API key (Worker Secret); never commit the value. */
	RESEND_API_KEY?: string;
	/** Mailjet v3.1 API credentials; both must be configured as Worker Secrets. */
	MAILJET_API_KEY?: string;
	MAILJET_SECRET_KEY?: string;
	/** Existing Gmail destination verified in Cloudflare Email Routing. */
	INBOUND_FORWARD_TO?: string;
	/** Read-only token (Zone:Read + Email Routing Rules:Read) for the sync UI. */
	CLOUDFLARE_SYNC_API_TOKEN?: string;
	CLOUDFLARE_SYNC_ACCOUNT_ID?: string;
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Comma-separated Cloudflare Access identities allowed to administer every mailbox. */
	ADMIN_ACCESS_EMAILS?: string;
	/** Explicit opt-in for MCP send_email and send_reply; no second approval occurs. */
	MCP_ALLOW_SEND?: string;
	/** Explicit opt-in for MCP permanent deletion. */
	MCP_ALLOW_DELETE?: string;
}
