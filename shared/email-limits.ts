// Shared outgoing email attachment limits.
// Cloudflare Email Service limits the entire encoded message to 25 MiB.
// Base64 and MIME headers add overhead, so conservatively allow 18 MiB of raw attachments.
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;
