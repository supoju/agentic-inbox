// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Comma-separated Cloudflare Access identities allowed to administer every mailbox. */
	ADMIN_ACCESS_EMAILS?: string;
	/** Explicit opt-in for MCP send_email and send_reply; no second approval occurs. */
	MCP_ALLOW_SEND?: string;
	/** Explicit opt-in for MCP permanent deletion. */
	MCP_ALLOW_DELETE?: string;
}
