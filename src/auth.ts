/** Compares in constant time. A missing secret matches nothing. */
function matches(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/**
 * True when the request carries `Authorization: Bearer <expected>`. A missing
 * secret refuses everything, so a deploy that forgot `wrangler secret put` is
 * closed rather than open.
 */
export function hasToken(request: Request, expected: string | undefined): boolean {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return matches(header.slice("Bearer ".length), expected);
}

/** True when the request carries the secret Cloudflare Notifications sends in `cf-webhook-auth`. */
export function hasWebhookSecret(request: Request, expected: string | undefined): boolean {
  return matches(request.headers.get("cf-webhook-auth") ?? "", expected);
}
