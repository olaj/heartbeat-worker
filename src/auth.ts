/**
 * True when the request carries `Authorization: Bearer <expected>`. A missing
 * secret refuses everything, so a deploy that forgot `wrangler secret put` is
 * closed rather than open.
 */
export function hasToken(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const given = new TextEncoder().encode(header.slice("Bearer ".length));
  const wanted = new TextEncoder().encode(expected);
  return given.byteLength === wanted.byteLength && crypto.subtle.timingSafeEqual(given, wanted);
}
