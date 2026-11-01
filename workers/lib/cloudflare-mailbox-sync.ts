// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Read-only Cloudflare Email Routing inventory.
 *
 * The API token is only used server-side. It needs Zone:Read and
 * Email Routing Rules:Read for the account's zones; never return the token.
 * This module deliberately has no Cloudflare mutation endpoints.
 */

export interface CloudflareRoutedMailbox {
  email: string;
  domain: string;
  ruleId: string;
  action: "forward" | "worker";
  target: string;
}

export interface CloudflareMailboxInventory {
  domains: string[];
  mailboxes: CloudflareRoutedMailbox[];
}

export interface CloudflareSyncCredentials {
  CLOUDFLARE_SYNC_API_TOKEN?: string;
  CLOUDFLARE_SYNC_ACCOUNT_ID?: string;
}

type CloudflareResponse<T> = {
  success: boolean;
  result: T;
  result_info?: { total_pages?: number };
};

type Zone = { id: string; name: string; status?: string; account?: { id: string } };
type RoutingRule = {
  id?: string;
  enabled?: boolean;
  actions?: Array<{ type?: string; value?: string[] }>;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
};

const API_ORIGIN = "https://api.cloudflare.com";
const MAX_PAGES = 20;

async function getPages<T>(
  path: string,
  token: string,
  fetcher: typeof fetch,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(path, API_ORIGIN);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const response = await fetcher(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("Cloudflare mailbox inventory request failed (HTTP " + response.status + ")");
    const data = (await response.json()) as CloudflareResponse<T[]>;
    if (!data.success || !Array.isArray(data.result)) throw new Error("Invalid Cloudflare mailbox inventory response");
    all.push(...data.result);
    if (!data.result_info?.total_pages || page >= data.result_info.total_pages) return all;
  }
  throw new Error("Cloudflare mailbox inventory pagination limit exceeded");
}

export async function discoverCloudflareMailboxes(
  credentials: CloudflareSyncCredentials,
  fetcher: typeof fetch = fetch,
): Promise<CloudflareMailboxInventory> {
  const token = credentials.CLOUDFLARE_SYNC_API_TOKEN?.trim();
  const accountId = credentials.CLOUDFLARE_SYNC_ACCOUNT_ID?.trim();
  if (!token || !accountId || !/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new Error("Cloudflare mailbox sync is not configured");
  }

  const zones = (await getPages<Zone>(
    "/client/v4/zones?account.id=" + encodeURIComponent(accountId),
    token,
    fetcher,
  )).filter((zone) =>
    zone.status === "active" &&
    zone.account?.id === accountId &&
    /^[a-z0-9.-]+$/i.test(zone.name) &&
    /^[0-9a-f]{32}$/i.test(zone.id),
  );
  const mailboxMap = new Map<string, CloudflareRoutedMailbox>();

  // Every result is an *existing, enabled* routing rule. We do not guess
  // aliases or include catch-all and drop rules.
  await Promise.all(zones.map(async (zone) => {
    const rules = await getPages<RoutingRule>(
      "/client/v4/zones/" + zone.id + "/email/routing/rules",
      token,
      fetcher,
    );
    for (const rule of rules) {
      if (rule.enabled !== true || !rule.id) continue;
      const matcher = rule.matchers?.find((m) => m.type === "literal" && m.field === "to");
      const email = matcher?.value?.trim().toLowerCase() ?? "";
      if (!email.endsWith("@" + zone.name.toLowerCase())) continue;
      if (!/^[^\s@]+@[a-z0-9.-]+$/i.test(email)) continue;
      const action = rule.actions?.find((a) => a.type === "forward" || a.type === "worker");
      if (!action || !Array.isArray(action.value) || action.value.length !== 1) continue;
      const target = action.value[0];
      if (!target) continue;
      mailboxMap.set(email, {
        email,
        domain: zone.name.toLowerCase(),
        ruleId: rule.id,
        action: action.type as "forward" | "worker",
        target,
      });
    }
  }));

  return {
    domains: zones.map((zone) => zone.name.toLowerCase()).sort(),
    mailboxes: [...mailboxMap.values()].sort((a, b) => a.email.localeCompare(b.email)),
  };
}
