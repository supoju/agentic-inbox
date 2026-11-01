import test from "node:test";
import assert from "node:assert/strict";
import { sendEmail } from "../workers/email-sender.ts";

const sample = {
  from: { name: "Project Support", email: "support@example.com" },
  to: ["recipient@example.net"],
  cc: "copied@example.net",
  bcc: ["hidden@example.net"],
  subject: "Project update",
  text: "Hello",
  html: '<p>Hello <img src="cid:logo" /></p>',
  replyTo: "support@example.com",
  headers: { "In-Reply-To": "<old@example.net>", References: "<old@example.net>" },
  attachments: [
    { filename: "logo.png", type: "image/png", content: "AP8=", disposition: "inline", contentId: "logo" },
    { filename: "notes.txt", type: "text/plain", content: new Uint8Array([0, 255]), disposition: "attachment" },
  ],
};

test("Mailjet preserves sender, recipients, threading and both attachment kinds", async () => {
  let sent = 0;
  const result = await sendEmail(
    {
      OUTBOUND_EMAIL_PROVIDER: "mailjet",
      MAILJET_API_KEY: "public-key",
      MAILJET_SECRET_KEY: "private-key",
      EMAIL: { send: async () => { throw new Error("Cloudflare must not run"); } },
    },
    sample,
    async (url, init) => {
      sent++;
      assert.equal(url, "https://api.mailjet.com/v3.1/send");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Basic " + btoa("public-key:private-key"));
      const { Messages } = JSON.parse(init.body);
      assert.equal(Messages.length, 1);
      const m = Messages[0];
      assert.deepEqual(m.From, { Email: "support@example.com", Name: "Project Support" });
      assert.deepEqual(m.To, [{ Email: "recipient@example.net" }]);
      assert.deepEqual(m.Cc, [{ Email: "copied@example.net" }]);
      assert.deepEqual(m.Bcc, [{ Email: "hidden@example.net" }]);
      assert.deepEqual(m.ReplyTo, { Email: "support@example.com" });
      assert.deepEqual(m.Headers, sample.headers);
      assert.equal(m.TextPart, "Hello");
      assert.equal(m.HTMLPart, sample.html);
      assert.deepEqual(m.InlinedAttachments[0], {
        ContentType: "image/png", Filename: "logo.png", Base64Content: "AP8=", ContentID: "logo",
      });
      assert.deepEqual(m.Attachments[0], {
        ContentType: "text/plain", Filename: "notes.txt", Base64Content: "AP8=",
      });
      return Response.json({ Messages: [{ Status: "success", To: [{ MessageUUID: "mailjet-uuid", MessageID: 123 }] }] });
    },
  );
  assert.deepEqual(result, { providerId: "mailjet-uuid" });
  assert.equal(result.messageId, undefined, "Mailjet tracking ID is not an RFC Message-ID");
  assert.equal(sent, 1);
});

test("Mailjet rejects missing secrets and never falls back to Cloudflare or Resend", async () => {
  let sent = false;
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "mailjet", MAILJET_API_KEY: "only-public", EMAIL: { send: async () => { sent = true; } } },
      sample,
      async () => { sent = true; throw new Error("unexpected fetch"); },
    ),
    /missing MAILJET_API_KEY or MAILJET_SECRET_KEY/,
  );
  assert.equal(sent, false);
});

test("Mailjet rejects HTTP errors with an actionable provider message", async () => {
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "mailjet", MAILJET_API_KEY: "a", MAILJET_SECRET_KEY: "b" },
      sample,
      async () => Response.json({ ErrorMessage: "Invalid credentials" }, { status: 401 }),
    ),
    /Mailjet API error 401: Invalid credentials/,
  );
});

test("Mailjet rejects per-message validation failures even on HTTP 200", async () => {
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "mailjet", MAILJET_API_KEY: "a", MAILJET_SECRET_KEY: "b" },
      sample,
      async () => Response.json({ Messages: [{ Status: "error", Errors: [{ ErrorMessage: "Sender not validated" }] }] }),
    ),
    /Mailjet API error 200: Sender not validated/,
  );
});

test("Mailjet does not report success when accepted response lacks a tracking ID", async () => {
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "mailjet", MAILJET_API_KEY: "a", MAILJET_SECRET_KEY: "b" },
      sample,
      async () => Response.json({ Messages: [{ Status: "success", To: [{}] }] }),
    ),
    /without returning an email ID/,
  );
});

test("Mailjet declines to send messages without text or HTML bodies", async () => {
  await assert.rejects(
    sendEmail(
      { OUTBOUND_EMAIL_PROVIDER: "mailjet", MAILJET_API_KEY: "a", MAILJET_SECRET_KEY: "b" },
      { from: "support@example.com", to: "user@example.net", subject: "Empty" },
      async () => { throw new Error("unexpected fetch"); },
    ),
    /requires a text or HTML email body/,
  );
});
