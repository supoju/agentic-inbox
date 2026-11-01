import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedAccessEmail, isExplicitlyEnabled } from "../workers/lib/access-policy.ts";

test("allows only explicitly listed authenticated email identities", () => {
  assert.equal(isAllowedAccessEmail("admin@example.com", "admin@example.com"), true);
  assert.equal(isAllowedAccessEmail("ADMIN@Example.com", "other@example.com, admin@example.com"), true);
  assert.equal(isAllowedAccessEmail("outsider@example.com", "admin@example.com"), false);
});

test("fails closed for missing config or missing JWT email", () => {
  assert.equal(isAllowedAccessEmail("admin@example.com", undefined), false);
  assert.equal(isAllowedAccessEmail(undefined, "admin@example.com"), false);
  assert.equal(isAllowedAccessEmail("", "admin@example.com"), false);
  assert.equal(isAllowedAccessEmail({}, "admin@example.com"), false);
});

test("MCP privileged operations require exact explicit opt-in", () => {
  assert.equal(isExplicitlyEnabled(undefined), false);
  assert.equal(isExplicitlyEnabled("false"), false);
  assert.equal(isExplicitlyEnabled("TRUE"), false);
  assert.equal(isExplicitlyEnabled(true), false);
  assert.equal(isExplicitlyEnabled("true"), true);
});
