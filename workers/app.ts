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
import { isAllowedAccessEmail } from "./lib/access-policy";
import {
  startGoogleLogin, finishGoogleLogin, isGoogleAdminSession,
  isTrustedBrowserOrigin, logoutGoogleAdmin,
} from "./lib/google-admin-auth";

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

// Public entry points only for the OAuth code exchange. They do not expose mail data.
app.get("/auth/login", async (c) => {
  if (c.env.AUTH_PROVIDER !== "google") return c.text("Not found", 404);
  return startGoogleLogin(c.env);
});
app.get("/auth/callback", async (c) => {
  if (c.env.AUTH_PROVIDER !== "google") return c.text("Not found", 404);
  return finishGoogleLogin(c.req.raw, c.env);
});
app.get("/auth/logout", (c) => {
  if (c.env.AUTH_PROVIDER !== "google") return c.text("Not found", 404);
  return logoutGoogleAdmin();
});

// Protect the entire UI, API, MCP and WebSocket surface in production.
// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

  // Google login is an alternative to Zero Trust billing activation, with the
  // same exact-email administrator allowlist. Missing secrets fail closed.
  if (c.env.AUTH_PROVIDER === "google") {
    if (!(await isGoogleAdminSession(c.req.raw, c.env))) {
      const path = new URL(c.req.url).pathname;
      if (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/mcp/") ||
          path.startsWith("/agents/")) {
        return c.text("Administrator login required", 401);
      }
      return c.redirect("/auth/login", 302);
    }
    if (!isTrustedBrowserOrigin(c.req.raw, c.env.ADMIN_ORIGIN)) {
      return c.text("Cross-origin state-changing request rejected", 403);
    }
    return next();
  }
  if (c.env.AUTH_PROVIDER && c.env.AUTH_PROVIDER !== "cloudflare") {
    return c.text("Unsupported authentication provider", 503);
  }

	const { POLICY_AUD, TEAM_DOMAIN, ADMIN_ACCESS_EMAILS } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN || !ADMIN_ACCESS_EMAILS?.trim()) {
		return c.text(
			"Cloudflare Access requires POLICY_AUD, TEAM_DOMAIN and ADMIN_ACCESS_EMAILS in production.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		const { payload } = await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
		if (!isAllowedAccessEmail(payload.email, ADMIN_ACCESS_EMAILS)) {
			return c.text("Access identity is not an authorized inbox administrator", 403);
		}
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model: allowlisted Access identities can operate all mailboxes.
	// The application does not provide per-mailbox role separation.
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
