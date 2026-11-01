// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Cloudflare Email Service binding.
 *
 * Uses the `send_email` Worker binding (`env.EMAIL.send()`) to send emails.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *
 * Attachment content note (Workers binding ≠ REST API):
 * - Workers binding: `content` must be raw bytes (`ArrayBuffer` / `ArrayBufferView`).
 *   A string is treated as UTF-8 text, NOT base64 — so base64 from the UI must be decoded
 *   before `binding.send()`. Official example:
 *   https://developers.cloudflare.com/email-service/examples/email-sending/email-attachments/
 * - REST API: expects base64 strings. Do not pass binding-decoded bytes back into REST.
 * Callers (compose / reply / forward) still send base64 strings over the HTTP API;
 * `storeAttachments` decodes for R2 separately. This module is the single decode-for-send exit.
 */

export type AttachmentContent = string | ArrayBuffer | ArrayBufferView;

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		/** Base64 string from the HTTP API, or raw bytes if already decoded. */
		content: AttachmentContent;
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

/**
 * Decode attachment content for the Workers Email binding.
 * Strings are treated as base64 (API/UI contract). Binary is passed through.
 * Does not strip a `data:*;base64,` prefix — callers must send pure base64.
 */
export function toBindingAttachmentContent(content: AttachmentContent): ArrayBuffer | ArrayBufferView {
	if (typeof content === "string") {
		const binaryStr = atob(content);
		return Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
	}
	return content;
}

/**
 * Keep outbound transports explicit. Selecting Resend without a key is an error;
 * never silently fall back to Cloudflare's verified-recipient-only Free transport.
 */
export interface EmailTransportEnv {
	EMAIL?: SendEmail;
	OUTBOUND_EMAIL_PROVIDER?: string;
	RESEND_API_KEY?: string;
	MAILJET_API_KEY?: string;
	MAILJET_SECRET_KEY?: string;
}

export interface EmailDeliveryResult {
	/** Provider's RFC Message-ID, when it actually returns one. */
	messageId?: string;
	/** Resend's API resource ID is NOT a MIME Message-ID. */
	providerId?: string;
}

/** Resend's REST API needs base64; Cloudflare's binding needs decoded bytes. */
export function toResendAttachmentContent(content: AttachmentContent): string {
	if (typeof content === "string") return content;
	const bytes = content instanceof ArrayBuffer
		? new Uint8Array(content)
		: new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
	}
	return btoa(chunks.join(""));
}

function formatAddress(address: string | { email: string; name: string }): string {
	if (typeof address === "string") return address;
	const name = address.name.replace(/[<>\r\n]/g, " ").trim();
	return name ? `${name} <${address.email}>` : address.email;
}

/**
 * Sends through Resend's HTTPS API. No third-party SDK or outbound network call
 * is needed at build time. The fetch argument exists only for isolated tests.
 */
export async function sendViaResend(
	apiKey: string | undefined,
	params: SendEmailParams,
	fetcher: typeof fetch = fetch,
): Promise<EmailDeliveryResult> {
	if (!apiKey?.trim()) {
		throw new Error("Resend sending is not configured: missing RESEND_API_KEY Worker secret");
	}

	const body: Record<string, unknown> = {
		from: formatAddress(params.from),
		to: params.to,
		subject: params.subject,
	};
	if (params.html !== undefined) body.html = params.html;
	if (params.text !== undefined) body.text = params.text;
	if (params.cc) body.cc = params.cc;
	if (params.bcc) body.bcc = params.bcc;
	if (params.replyTo) body.reply_to = formatAddress(params.replyTo);
	if (params.headers && Object.keys(params.headers).length) body.headers = params.headers;
	if (params.attachments?.length) {
		body.attachments = params.attachments.map((att) => ({
			filename: att.filename,
			content: toResendAttachmentContent(att.content),
			content_type: att.type,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	const response = await fetcher("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const payload = await response.json().catch(() => null) as
		| { id?: unknown; message?: unknown; name?: unknown }
		| null;
	if (!response.ok) {
		const reason = typeof payload?.message === "string"
			? payload.message.slice(0, 300)
			: typeof payload?.name === "string"
				? payload.name.slice(0, 100)
				: "provider rejected the request";
		throw new Error(`Resend API error ${response.status}: ${reason}`);
	}
	if (typeof payload?.id !== "string" || !payload.id) {
		throw new Error("Resend accepted the request without returning an email ID");
	}
	return { providerId: payload.id };
}


/** Mailjet v3.1 uses email objects and returns provider tracking IDs, not RFC Message-IDs. */
function mailjetAddress(address: string | { email: string; name: string }): { Email: string; Name?: string } {
	if (typeof address === "string") return { Email: address };
	const name = address.name.replace(/[<>\r\n]/g, " ").trim();
	return name ? { Email: address.email, Name: name } : { Email: address.email };
}

function mailjetRecipients(addresses: string | string[]): { Email: string }[] {
	return (Array.isArray(addresses) ? addresses : [addresses]).map((email) => ({ Email: email }));
}

/**
 * Send via Mailjet's HTTPS API without an SMTP socket or an SDK.
 * Fail closed if either key is absent or Mailjet reports a per-message error.
 */
export async function sendViaMailjet(
	apiKey: string | undefined,
	secretKey: string | undefined,
	params: SendEmailParams,
	fetcher: typeof fetch = fetch,
): Promise<EmailDeliveryResult> {
	if (!apiKey?.trim() || !secretKey?.trim()) {
		throw new Error("Mailjet sending is not configured: missing MAILJET_API_KEY or MAILJET_SECRET_KEY Worker secret");
	}
	if (!params.text && !params.html) {
		throw new Error("Mailjet requires a text or HTML email body");
	}
	const message: Record<string, unknown> = {
		From: mailjetAddress(params.from),
		To: mailjetRecipients(params.to),
		Subject: params.subject,
	};
	if (params.text !== undefined) message.TextPart = params.text;
	if (params.html !== undefined) message.HTMLPart = params.html;
	if (params.cc) message.Cc = mailjetRecipients(params.cc);
	if (params.bcc) message.Bcc = mailjetRecipients(params.bcc);
	if (params.replyTo) message.ReplyTo = mailjetAddress(params.replyTo);
	if (params.headers && Object.keys(params.headers).length) message.Headers = params.headers;

	if (params.attachments?.length) {
		const regular: Record<string, unknown>[] = [];
		const inline: Record<string, unknown>[] = [];
		for (const attachment of params.attachments) {
			const item: Record<string, unknown> = {
				ContentType: attachment.type,
				Filename: attachment.filename,
				Base64Content: toResendAttachmentContent(attachment.content),
			};
			if (attachment.disposition === "inline") {
				if (attachment.contentId) item.ContentID = attachment.contentId;
				inline.push(item);
			} else {
				regular.push(item);
			}
		}
		if (regular.length) message.Attachments = regular;
		if (inline.length) message.InlinedAttachments = inline;
	}

	const response = await fetcher("https://api.mailjet.com/v3.1/send", {
		method: "POST",
		headers: {
			Authorization: "Basic " + btoa(apiKey + ":" + secretKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ Messages: [message] }),
	});
	const payload = await response.json().catch(() => null) as
		| {
			Messages?: Array<{
				Status?: unknown;
				To?: Array<{ MessageUUID?: unknown; MessageID?: unknown }>;
				Errors?: Array<{ ErrorMessage?: unknown }>;
			}>;
			ErrorMessage?: unknown;
		}
		| null;
	const result = payload?.Messages?.[0];
	if (!response.ok || result?.Status !== "success") {
		const rawReason = result?.Errors?.[0]?.ErrorMessage ?? payload?.ErrorMessage;
		const reason = typeof rawReason === "string"
			? rawReason.slice(0, 300)
			: "provider rejected the request";
		throw new Error("Mailjet API error " + response.status + ": " + reason);
	}
	const recipient = result.To?.[0];
	const providerId = typeof recipient?.MessageUUID === "string" && recipient.MessageUUID
		? recipient.MessageUUID
		: (typeof recipient?.MessageID === "number" || typeof recipient?.MessageID === "string")
			? String(recipient.MessageID)
			: "";
	if (!providerId) {
		throw new Error("Mailjet accepted the request without returning an email ID");
	}
	return { providerId };
}

/** Send via the provider selected in the Worker configuration. */
export async function sendEmail(
	env: EmailTransportEnv,
	params: SendEmailParams,
	fetcher: typeof fetch = fetch,
): Promise<EmailDeliveryResult> {
	const provider = (env.OUTBOUND_EMAIL_PROVIDER ?? "cloudflare").trim().toLowerCase();
	if (provider === "resend") {
		return sendViaResend(env.RESEND_API_KEY, params, fetcher);
	}
	if (provider === "mailjet") {
		return sendViaMailjet(env.MAILJET_API_KEY, env.MAILJET_SECRET_KEY, params, fetcher);
	}
	if (provider !== "cloudflare") {
		throw new Error(`Unsupported outbound email provider: ${provider}`);
	}
	if (!env.EMAIL) {
		throw new Error("Cloudflare Email Service binding is missing");
	}
	const message: Record<string, unknown> = {
		to: params.to,
		from: params.from,
		subject: params.subject,
	};
	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.replyTo = params.replyTo;
	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}
	if (params.attachments?.length) {
		message.attachments = params.attachments.map((att) => ({
			content: toBindingAttachmentContent(att.content),
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}
	const result = await env.EMAIL.send(message as any);
	return { messageId: result.messageId };
}

/**
 * Build a JSON error response for a failed send. Used by the HTTP routes, which
 * send synchronously so the UI sees real delivery failures (previously sends were
 * deferred via waitUntil and failures were only logged, so the UI showed "sent").
 */
export function sendFailure(
	c: { json: (body: unknown, status: 502) => Response },
	e: unknown,
): Response {
	const err = e as { message?: string; code?: string };
	const code = err?.code || "";
	let message = err?.message || String(e);
	// Surface Email Sending domain-onboarding failures clearly for operators.
	if (
		!message.startsWith("Resend API error") &&
		!message.startsWith("Mailjet API error") &&
		(code === "E_SENDER_NOT_VERIFIED" ||
			code === "E_SENDER_DOMAIN_NOT_AVAILABLE" ||
			/not verified|not available for sending|not onboarded/i.test(message))
	) {
		message =
			`${message} — onboard this domain under Cloudflare Email Service → Email Sending ` +
			`(adds cf-bounce SPF/DKIM), then retry.`;
	}
	console.error("Email delivery failed:", code, message);
	return c.json({ error: `Email delivery failed: ${message}`, ...(code ? { code } : {}) }, 502);
}
