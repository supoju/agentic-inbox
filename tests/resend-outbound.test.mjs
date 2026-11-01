import test from "node:test";
import assert from "node:assert/strict";
import {
  sendEmail,
  toResendAttachmentContent,
} from "../workers/email-sender.ts";

const sample = {
  from: { name: "Project Support", email: "support@example.com" },
  to: ["recipient@example.net"],
  subject: "Test message",
  html: '<p>Hello <img src="cid:inline-logo" /></p>',
  text: "Hello",
  replyTo: "replies@example.com",
  headers: { "In-Reply-To": "<original@example.net>", References: "<original@example.net>" },
  attachments: [
    {
      filename: "logo.png",
      content: "AP8=",
      type: "image/png",
      disposition: "inline",
      contentId: "inline-logo",
    },
  ],
};

test("Resend selection preserves sender, recipients, threading and inline images", async () => {
  let requests = 0;
  const fetcher = async (url, init) => {
    requests++;
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer resend-test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.from, "Project Support <support@example.com>");
    assert.deepEqual(body.to, ["recipient@example.net"]);
    assert.equal(body.reply_to, "replies@example.com");
    assert.equal(body.headers["In-Reply-To"], "<original@example.net>");
    assert.equal(body.headers.References, "<original@example.net>");
    assert.equal(body.attachments[0].content, "AP8=");
    assert.equal(body.attachments[0].content_id, "inline-logo");
    assert.equal(body.attachments[0].content_type, "image/png");
    return Response.json({ id: "resend-provider-id" });
  };
  const cloudflareBinding = { send: async () => { throw new Error("Cloudflare binding must not run"); } };
  const result = await sendEmail(
    { OUTBOUND_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "resend-test-key", EMAIL: cloudflareBinding },
    sample,
    fetcher,
  );
  assert.deepEqual(result, { providerId: "resend-provider-id" });
  assert.equal(result.messageId, undefined, "API resource ID must not be mistaken for MIME Message-ID");
  assert.equal(requests, 1);
});

test("Resend selection fails closed when the secret is absent", async () => {
  let sent = false;
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "resend", EMAIL: { send: async () => { sent = true; } } },
      sample,
      async () => { sent = true; throw new Error("unexpected fetch"); },
    ),
    /missing RESEND_API_KEY/,
  );
  assert.equal(sent, false, "never fall back to Cloudflare");
});

test("Resend preserves byte-for-byte binary attachment content as base64", () => {
  assert.equal(toResendAttachmentContent(new Uint8Array([0, 255])), "AP8=");
  const offsetView = new Uint8Array([99, 0, 255, 99]).subarray(1, 3);
  assert.equal(toResendAttachmentContent(offsetView), "AP8=");
});

test("Resend API rejections surface an error and never report success", async () => {
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "resend-test-key" },
      sample,
      async () => Response.json({ name: "rate_limit_exceeded", message: "Rate limit exceeded" }, { status: 429 }),
    ),
    /Resend API error 429: Rate limit exceeded/,
  );
});

test("Resend HTTP success without an email ID is not treated as delivered", async () => {
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "resend-test-key" },
      sample,
      async () => Response.json({}),
    ),
    /without returning an email ID/,
  );
});

test("Cloudflare binding remains a backwards-compatible explicit transport", async () => {
  let payload;
  const result = await sendEmail(
    {
      OUTBOUND_EMAIL_PROVIDER: "cloudflare",
      EMAIL: { send: async (message) => { payload = message; return { messageId: "<sent@example.com>" }; } },
    },
    sample,
  );
  assert.equal(result.messageId, "<sent@example.com>");
  assert.deepEqual(Array.from(payload.attachments[0].content), [0, 255]);
  assert.equal(payload.attachments[0].contentId, "inline-logo");
});

test("Unknown transports are rejected without fallback", async () => {
  await assert.rejects(
    sendEmail({ OUTBOUND_EMAIL_PROVIDER: "smtp" }, sample),
    /Unsupported outbound email provider: smtp/,
  );
});
