/**
 * D1 errors that come from Cloudflare's side rather than from the query.
 * During a D1 incident most calls fail with "internal error" and some with
 * the others, while a retry a moment later often succeeds.
 */
const TRANSIENT = [
  "internal error",
  "Network connection lost",
  "storage caused object to be reset",
  "reset because its code was updated",
  "Replica disconnected from primary",
  "transient issue on remote node",
  "SQLITE_NOMEM",
];

/** Short enough to stay well inside a caller's or health check's timeout. */
const DELAYS_MS = [250, 1000];

export function isTransientD1Error(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("D1_ERROR") && TRANSIENT.some((t) => message.includes(t));
}

/**
 * Runs `work` again when D1 fails transiently. Only for work that is safe to
 * repeat: every write it makes must be idempotent, and it must not post to
 * Slack.
 */
export async function retryD1<T>(work: () => Promise<T>, delays: readonly number[] = DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      if (attempt >= delays.length || !isTransientD1Error(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
