// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Keep the user's already-working Gmail forwarding intact when an Email
 * Routing rule is moved from "forward" to "Worker".
 *
 * Forward first. If local storage fails, Cloudflare can retry the handler;
 * the user already has the message in Gmail even during an inbox outage.
 * Retries can produce a duplicate at the verified forwarding destination.
 */
export async function forwardThenStoreInbound(
  message: { forward?: (destination: string) => Promise<void> },
  destination: string | undefined,
  store: () => Promise<void>,
): Promise<void> {
  const to = destination?.trim().toLowerCase();
  if (to) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new Error("Invalid verified inbound forwarding destination");
    }
    if (typeof message.forward !== "function") {
      throw new Error("Cloudflare Email Worker forwarding is unavailable");
    }
    await message.forward(to);
  }
  await store();
}
