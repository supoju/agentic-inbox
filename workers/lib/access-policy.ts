// Defense in depth for a single-operator multi-mailbox deployment.
// Cloudflare Access validates the token; this policy additionally restricts its identity.
export function isAllowedAccessEmail(identity: unknown, allowedEmails: string | undefined): boolean {
  if (typeof identity !== "string" || !identity.trim() || !allowedEmails?.trim()) return false;
  const email = identity.trim().toLowerCase();
  return allowedEmails.split(",").some((entry) => entry.trim().toLowerCase() === email);
}

// Deliberately strict: an unset or ambiguous environment flag grants no permission.
export function isExplicitlyEnabled(value: unknown): boolean {
  return value === "true";
}
