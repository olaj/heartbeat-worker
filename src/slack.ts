import { formatDuration, humanDuration } from "./duration";
import type { Env } from "./env";
import type { IncidentRow, JobRow } from "./store";

/** Per run, so a long Slack outage drains over a few minutes instead of in one burst. */
const BATCH = 20;
const MAX_DETAIL_IN_SLACK = 500;

/** Escapes the three characters Slack treats as markup in message text. */
export const slackEscape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/**
 * A time Slack shows in each reader's own time zone, such as "today at 14:05".
 * Clients that cannot render it show the UTC fallback.
 */
export function slackDate(ms: number): string {
  const fallback = new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} at {time}|${fallback}>`;
}

// "New incident for X" and "Automatically resolved X incident" copy Better
// Stack's wording, and automated readers of the channel match on them. Keep
// those phrases intact; what comes before and after them is free.
export function openedMessage(incident: IncidentRow, job: JobRow | null): string {
  const title = `🔴 *New incident for ${incident.job}*`;
  if (incident.cause === "failed") {
    const lines = [`${title}: the job reported a failure`];
    if (incident.detail) lines.push("> " + incident.detail.slice(0, MAX_DETAIL_IN_SLACK).replace(/\n/g, "\n> "));
    return lines.join("\n");
  }
  if (!job) return title;
  const since = job.last_ping ? `since ${slackDate(job.last_ping)}` : "yet";
  return `${title}: no ping ${since} (expected every ${formatDuration(job.every_seconds)}, grace ${formatDuration(job.grace_seconds)})`;
}

export function resolvedMessage(incident: IncidentRow): string {
  const lasted = humanDuration((incident.resolved_at ?? incident.opened_at) - incident.opened_at);
  return `✅ *Automatically resolved ${incident.job} incident* after ${lasted}`;
}

/** Posts one message. False if Slack could not be reached or refused it. */
export async function post(webhook: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Posts every incident that has not been announced yet: its opening first,
 * then its resolution. Each post is claimed by flipping its flag before
 * sending, so two overlapping runs never post the same message, and released
 * again if Slack refuses it, so the next run retries. Stops at the first
 * refusal: when Slack is down, hammering it helps nobody.
 */
export async function flushNotifications(env: Env): Promise<void> {
  const webhook = env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT * FROM incidents
       WHERE open_notified = 0 OR (resolved_at IS NOT NULL AND resolve_notified = 0)
       ORDER BY id LIMIT ?`,
    )
    .bind(BATCH)
    .all<IncidentRow>();

  for (const incident of results) {
    if (!incident.open_notified) {
      const claim = await db
        .prepare("UPDATE incidents SET open_notified = 1 WHERE id = ? AND open_notified = 0")
        .bind(incident.id)
        .run();
      if (claim.meta.changes === 1) {
        const job = await db.prepare("SELECT * FROM jobs WHERE name = ?").bind(incident.job).first<JobRow>();
        if (!(await post(webhook, openedMessage(incident, job)))) {
          await db.prepare("UPDATE incidents SET open_notified = 0 WHERE id = ?").bind(incident.id).run();
          return;
        }
      } else {
        // Another run has it. Its resolution, if any, is that run's to post too.
        continue;
      }
    }
    if (incident.resolved_at !== null && !incident.resolve_notified) {
      const claim = await db
        .prepare("UPDATE incidents SET resolve_notified = 1 WHERE id = ? AND resolve_notified = 0")
        .bind(incident.id)
        .run();
      if (claim.meta.changes === 1 && !(await post(webhook, resolvedMessage(incident)))) {
        await db.prepare("UPDATE incidents SET resolve_notified = 0 WHERE id = ?").bind(incident.id).run();
        return;
      }
    }
  }
}
