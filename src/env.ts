export interface Env {
  DB: D1Database;
  /** Lets a job ping or report failure. Never accepted for reading status. */
  PING_TOKEN?: string;
  /** Lets something read /api/status. Never accepted for pinging. */
  READ_TOKEN?: string;
  /** Lets Cloudflare Notifications post to /cloudflare/health, in the `cf-webhook-auth` header. Nothing else. */
  CLOUDFLARE_WEBHOOK_SECRET?: string;
  /** Slack incoming webhook. Without it incidents are recorded but not posted. */
  SLACK_WEBHOOK_URL?: string;
}
