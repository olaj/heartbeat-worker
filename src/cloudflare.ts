import { humanDuration } from "./duration";
import type { Env } from "./env";
import { post, slackEscape } from "./slack";

const MAX_TEXT_IN_SLACK = 1000;

/**
 * The parts of a Cloudflare Notifications webhook we read. See
 * https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/
 * Every field is optional: the dashboard's test message carries only `text`.
 */
export interface CloudflareNotification {
  name?: unknown;
  text?: unknown;
  ts?: unknown;
  alert_type?: unknown;
  alert_event?: unknown;
  data?: Record<string, unknown>;
}

export interface HealthEvent {
  /** Cloudflare's health check id, or the name when there is none. */
  id: string;
  name: string;
  healthy: boolean;
  /** When the status changed, in ms. */
  at: number;
  /** A short reason for a failure, or null. */
  reason: string | null;
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * The status codes Cloudflare puts in the notification text ("Expected codes:
 * [200]", "Received code: 503") read better than its generic reason ("Response
 * code mismatch error"), so they win when both are there.
 */
function failureReason(text: string | null, reason: string | null): string | null {
  const expected = text && /Expected codes?:\s*\[?([^\]\n]*)\]?/i.exec(text)?.[1]?.trim();
  const received = text && /Received code:\s*(\S+)/i.exec(text)?.[1];
  if (expected && received) return `got ${received}, expected ${expected.split(/[\s,]+/).join(" or ")}`;
  return reason;
}

/**
 * Reads a health check status change. Null for any other notification, or a
 * health check one whose status we cannot tell, so the caller can pass it on
 * as it is rather than lose it.
 */
export function readHealthEvent(payload: CloudflareNotification, now: number): HealthEvent | null {
  const data = payload.data ?? {};
  const name = str(data.health_check_name);
  if (payload.alert_type !== "health_check_status_notification" || !name) return readHealthEventFromText(payload, now);

  const status = (str(data.new_health_status) ?? str(data.new_status))?.toLowerCase();
  let healthy: boolean;
  if (status === "healthy") healthy = true;
  else if (status === "unhealthy") healthy = false;
  else if (payload.alert_event === "ALERT_STATE_EVENT_END") healthy = true;
  else if (payload.alert_event === "ALERT_STATE_EVENT_START") healthy = false;
  else return null;

  const changed = Date.parse(str(data.status_change_time) ?? "");
  const at = Number.isFinite(changed) ? changed : typeof payload.ts === "number" ? payload.ts * 1000 : now;
  return {
    id: str(data.health_check_id) ?? name,
    name,
    healthy,
    at,
    reason: healthy ? null : failureReason(str(payload.text), str(data.reason)),
  };
}

/** The value after "<label>:" on a line of the notification text. */
const field = (text: string, label: string) =>
  new RegExp(`^\\s*${label}\\s*:[ \\t]*(.*?)\\s*$`, "im").exec(text)?.[1] || null;

/**
 * Real health check notifications can arrive with only their text filled in,
 * unlike the documented schema:
 *
 *   Health Check Name: heartbeat-worker
 *   Health Check ID: 4a2acdc932d0d8c3f44672af79bd03fa
 *   Time : 2026-10-23 12:42:27 +0000 UTC
 *   Status: Unhealthy
 *   Failure reason: Response code mismatch error
 */
function readHealthEventFromText(payload: CloudflareNotification, now: number): HealthEvent | null {
  const text = str(payload.text);
  if (!text) return null;
  const name = field(text, "Health Check Name");
  const status = field(text, "Status")?.toLowerCase();
  if (!name || (status !== "healthy" && status !== "unhealthy")) return null;
  const healthy = status === "healthy";

  // "2026-10-23 12:42:27 +0000 UTC" → "2026-10-23T12:42:27+00:00"
  const time = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/.exec(field(text, "Time") ?? "");
  const changed = time ? Date.parse(`${time[1]}T${time[2]}${time[3]}:${time[4]}`) : NaN;
  const at = Number.isFinite(changed) ? changed : typeof payload.ts === "number" ? payload.ts * 1000 : now;
  return {
    id: field(text, "Health Check ID") ?? name,
    name,
    healthy,
    at,
    reason: healthy ? null : failureReason(text, field(text, "Failure reason")),
  };
}

export function downMessage(event: HealthEvent): string {
  const reason = event.reason ? `: ${slackEscape(event.reason)}` : "";
  return `🔴 *${slackEscape(event.name)}* is down${reason}`;
}

export function upMessage(event: HealthEvent, downSince: number): string {
  return `✅ *${slackEscape(event.name)}* is back up after ${humanDuration(event.at - downSince)}`;
}

/** Any notification that is not a health check change, the dashboard's test included. */
export function otherMessage(payload: CloudflareNotification): string {
  const title = `ℹ️ *${slackEscape(str(payload.name) ?? "Cloudflare notification")}*`;
  const text = str(payload.text);
  return text ? `${title}\n${slackEscape(text.slice(0, MAX_TEXT_IN_SLACK))}` : title;
}

/**
 * Handles one Cloudflare notification. A check going down is announced once,
 * and a check coming back is announced only if we announced it going down, so
 * newly created checks reporting "healthy" stay quiet. State changes are
 * claimed in D1 before posting and released if Slack refuses, so a retried
 * webhook posts what the first attempt could not.
 */
export async function receiveNotification(
  env: Env,
  payload: CloudflareNotification,
  now: number,
): Promise<{ posted: boolean; slackRefused: boolean }> {
  const webhook = env.SLACK_WEBHOOK_URL;
  const send = async (text: string) => (webhook ? post(webhook, text) : true);
  const db = env.DB;
  const event = readHealthEvent(payload, now);

  if (!event) {
    // Kept in Workers Logs, so a payload shape we do not read yet can be looked up.
    console.log("passing on a notification as it is", JSON.stringify(payload));
    const ok = await send(otherMessage(payload));
    return { posted: ok && !!webhook, slackRefused: !ok };
  }

  if (!event.healthy) {
    const claim = await db
      .prepare(
        `INSERT INTO health_checks (id, name, down_since, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, down_since = excluded.down_since, updated_at = excluded.updated_at
         WHERE health_checks.down_since IS NULL`,
      )
      .bind(event.id, event.name, event.at, now)
      .run();
    if (claim.meta.changes !== 1) return { posted: false, slackRefused: false };
    if (await send(downMessage(event))) return { posted: !!webhook, slackRefused: false };
    await db.prepare("UPDATE health_checks SET down_since = NULL WHERE id = ? AND down_since = ?").bind(event.id, event.at).run();
    return { posted: false, slackRefused: true };
  }

  const row = await db.prepare("SELECT down_since FROM health_checks WHERE id = ?").bind(event.id).first<{ down_since: number | null }>();
  if (row?.down_since == null) return { posted: false, slackRefused: false };
  const claim = await db
    .prepare("UPDATE health_checks SET down_since = NULL, name = ?, updated_at = ? WHERE id = ? AND down_since = ?")
    .bind(event.name, now, event.id, row.down_since)
    .run();
  if (claim.meta.changes !== 1) return { posted: false, slackRefused: false };
  if (await send(upMessage(event, row.down_since))) return { posted: !!webhook, slackRefused: false };
  await db
    .prepare("UPDATE health_checks SET down_since = ? WHERE id = ? AND down_since IS NULL")
    .bind(row.down_since, event.id)
    .run();
  return { posted: false, slackRefused: true };
}
