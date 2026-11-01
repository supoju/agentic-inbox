// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from "../../shared/email-limits";

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
	body?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1),
]);

export const ErrorResponseSchema = z.object({
	error: z.string(),
});

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([
			z.string().email(),
			z.object({ email: z.string().email(), name: z.string() }),
		]),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(), // base64 encoded
					filename: z.string(),
					type: z.string(),
					disposition: z.enum(["attachment", "inline"]),
					contentId: z.string().optional(),
				}),
			)
			.optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	})
	.superRefine((data, ctx) => {
		const attachments = data.attachments ?? [];
		if (attachments.length > MAX_ATTACHMENT_COUNT) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["attachments"],
				message: `Too many attachments (maximum ${MAX_ATTACHMENT_COUNT})`,
			});
		}
		let totalBytes = 0;
		attachments.forEach((attachment, index) => {
			const content = attachment.content;
			// The HTTP API contract is standard, padded base64 (from FileReader).
			if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["attachments", index, "content"],
					message: "Attachment must contain valid base64 data",
				});
				return;
			}
			const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
			const bytes = content.length / 4 * 3 - padding;
			totalBytes += bytes;
			if (bytes > MAX_ATTACHMENT_BYTES) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["attachments", index, "content"],
					message: "Attachment exceeds the 18 MiB limit",
				});
			}
		});
		if (totalBytes > MAX_ATTACHMENT_BYTES) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["attachments"],
				message: "Combined attachments exceed the 18 MiB limit",
			});
		}
	});

export const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});
