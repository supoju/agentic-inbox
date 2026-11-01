import test from "node:test";
import assert from "node:assert/strict";
import { discoverCloudflareMailboxes } from "../workers/lib/cloudflare-mailbox-sync.ts";
import { forwardThenStoreInbound } from "../workers/lib/inbound-forward.ts";

const ACCOUNT = "a".repeat(32);
const ZONE_ONE = "1".repeat(32);
const ZONE_TWO = "2".repeat(32);

function fakeCloudflareFetch(url, options) {
  assert.equal(options.headers.Authorization, "Bearer read-only-test-token");
  const u = new URL(url);
  const page = Number(u.searchParams.get("page"));
  if (u.pathname === "/client/v4/zones") {
    assert.equal(u.searchParams.get("account.id"), ACCOUNT);
    return Promise.resolve(Response.json({
      success: true,
      result: page === 1
        ? [{ id: ZONE_ONE, name: "one.example", status: "active", account: { id: ACCOUNT } }]
        : [{ id: ZONE_TWO, name: "two.example", status: "active", account: { id: ACCOUNT } }],
      result_info: { total_pages: 2 },
    }));
  }
  if (u.pathname.endsWith("/" + ZONE_ONE + "/email/routing/rules")) {
    return Promise.resolve(Response.json({
      success: true,
      result: [
        { id: "rule1", enabled: true, matchers: [{ type: "literal", field: "to", value: "Support@ONE.EXAMPLE" }], actions: [{ type: "forward", value: ["owner@example.net"] }] },
        { id: "rule2", enabled: false, matchers: [{ type: "literal", field: "to", value: "disabled@one.example" }], actions: [{ type: "forward", value: ["owner@example.net"] }] },
        { id: "all", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["owner@example.net"] }] },
        { id: "drop", enabled: true, matchers: [{ type: "literal", field: "to", value: "spam@one.example" }], actions: [{ type: "drop" }] },
      ],
    }));
  }
  if (u.pathname.endsWith("/" + ZONE_TWO + "/email/routing/rules")) {
    return Promise.resolve(Response.json({
      success: true,
      result: [
        { id: "worker", enabled: true, matchers: [{ type: "literal", field: "to", value: "hello@two.example" }], actions: [{ type: "worker", value: ["inbox-worker"] }] },
        { id: "foreign", enabled: true, matchers: [{ type: "literal", field: "to", value: "nope@other.example" }], actions: [{ type: "forward", value: ["owner@example.net"] }] },
      ],
    }));
  }
  throw new Error("Unexpected mocked endpoint: " + u.pathname);
}

test("Cloudflare sync discovers only enabled literal mailboxes and preserves existing route destinations", async () => {
  const got = await discoverCloudflareMailboxes({
    CLOUDFLARE_SYNC_API_TOKEN: "read-only-test-token",
    CLOUDFLARE_SYNC_ACCOUNT_ID: ACCOUNT,
  }, fakeCloudflareFetch);
  assert.deepEqual(got.domains, ["one.example", "two.example"]);
  assert.deepEqual(got.mailboxes, [
    { email: "support@one.example", domain: "one.example", ruleId: "rule1", action: "forward", target: "owner@example.net" },
    { email: "hello@two.example", domain: "two.example", ruleId: "worker", action: "worker", target: "inbox-worker" },
  ].sort((a,b)=>a.email.localeCompare(b.email)));
});

test("Cloudflare sync fails closed without the read-only token or on API rejection", async () => {
  await assert.rejects(discoverCloudflareMailboxes({ CLOUDFLARE_SYNC_ACCOUNT_ID: ACCOUNT }), /not configured/);
  await assert.rejects(discoverCloudflareMailboxes({
    CLOUDFLARE_SYNC_API_TOKEN: "read-only-test-token",
    CLOUDFLARE_SYNC_ACCOUNT_ID: ACCOUNT,
  }, async () => new Response("Denied", { status: 403 })), /HTTP 403/);
});

test("Gmail forwarding completes before local storage, including when storage fails", async () => {
  const calls = [];
  const message = { forward: async address => { calls.push("forward:" + address); } };
  await forwardThenStoreInbound(message, "Owner@Example.NET", async () => { calls.push("store"); });
  assert.deepEqual(calls, ["forward:owner@example.net", "store"]);
  await assert.rejects(forwardThenStoreInbound(message, "owner@example.net", async () => { throw new Error("store unavailable"); }), /store unavailable/);
  assert.deepEqual(calls, ["forward:owner@example.net", "store", "forward:owner@example.net"]);
});

test("Forwarding failure prevents silent success; missing forwarding configuration just stores", async () => {
  let stored = 0;
  await assert.rejects(forwardThenStoreInbound(
    { forward: async () => { throw new Error("relay rejected"); } }, "owner@example.net",
    async () => { stored++; },
  ), /relay rejected/);
  assert.equal(stored, 0);
  await forwardThenStoreInbound({}, undefined, async () => { stored++; });
  assert.equal(stored, 1);
  await assert.rejects(forwardThenStoreInbound({}, "owner@example.net", async () => {}), /unavailable/);
});
