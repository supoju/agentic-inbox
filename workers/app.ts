// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Isolated Free-plan probe only. This branch is never routed to production email.
// The deployed Worker requires a Cloudflare secret; no addresses or credentials
// are committed. One attempt is recorded before sending to prevent repeat abuse.
const evalProbePath = "/__free_email_probe_20261101";
app.get(evalProbePath, (c) => c.html([
  '<!doctype html><html><meta charset="utf-8"><title>Free Email Probe</title>',
  '<body><h1>Isolated Cloudflare Email Sending probe</h1>',
  '<form method="post">',
  '<label>Test key <input type="password" name="key" required></label>',
  '<label>Sender <input type="email" name="from" required></label>',
  '<label>Recipient <input type="email" name="to" required></label>',
  '<button type="submit">Send one test email</button></form></body></html>',
].join("")));
app.post(evalProbePath, async (c) => {
  const data = await c.req.parseBody();
  const key = typeof data.key === "string" ? data.key : "";
  const secret = (c.env as Env & { EVAL_PROBE_SECRET?: string }).EVAL_PROBE_SECRET;
  if (!secret || key !== secret) return c.text("Forbidden", 403);
  const from = typeof data.from === "string" ? data.from.trim() : "";
  const to = typeof data.to === "string" ? data.to.trim() : "";
  if (!/^[^@\s]+@zecview\.com$/.test(from) || !/^[^@\s]+\+[^@\s]+@gmail\.com$/.test(to)) {
    return c.text("Only a zecview.com sender and Gmail plus-address recipient are allowed", 400);
  }
  const marker = "probe/native-cloudflare-email-20261101-v1";
  if (await c.env.BUCKET.head(marker)) return c.text("Probe already attempted", 409);
  await c.env.BUCKET.put(marker, new Date().toISOString());
  try {
    const result = await c.env.EMAIL.send({
      from,
      to,
      subject: "Cloudflare Workers Free native email probe 20261101",
      text: "Controlled single-send test from the isolated upstream Worker.",
    });
    return c.json({ outcome: "accepted", messageId: result.messageId });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return c.json({ outcome: "rejected", code: e.code || "", message: (e.message || "unknown error").slice(0, 300) }, 502);
  }
});


// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		// Service bindings never get an Access JWT or cf-ray. Public edge always has cf-ray.
		const isServiceBinding = !c.req.header("cf-ray");
		const path = new URL(c.req.url).pathname;
		const isSendApi =
			c.req.method === "POST" &&
			/^\/api\/v1\/mailboxes\/[^/]+\/emails$/.test(path);
		if (isServiceBinding && isSendApi) {
			return next();
		}
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", async (c) => {
	const res = await requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
	const contentType = res.headers.get("content-type") || "";
	if (!contentType.includes("text/html")) return res;
	const headers = new Headers(res.headers);
	headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
