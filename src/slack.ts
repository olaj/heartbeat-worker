import { formatDuration, humanDuration } from "./duration";
import type { Env } from "./env";
import type { IncidentRow, JobRow } from "./store";

/** Per run, so a long Slack outage drains over a few minutes instead of in one burst. */
const BATCH = 20;
const MAX_DETAIL_IN_SLACK = 500;

// The first line of each message copies Better Stack's wording, so anything
// that reads #bad-notifications today keeps working.
export function openedMessage(incident: IncidentRow, job: JobRow | null): string {
  const lines = [`*New incident for ${incident.job}*`];
  if (incident.cause === "failed") {
    lines.push("The job reported a failure.");
    if (incident.detail) lines.push("> " + incident.detail.slice(0, MAX_DETAIL_IN_SLACK).replace(/\n/g, "\n> "));
  } else if (job) {
    const since = job.last_ping ? `since ${new Date(job.last_ping).toISOString()}` : "yet";
    lines.push(
      `No ping ${since}. Expected every ${formatDuration(job.every_seconds)}, grace ${formatDuration(job.grace_seconds)}.`,
    );
  }
  return lines.join("\n");
}

export function resolvedMessage(incident: IncidentRow): string {
  const lasted = humanDuration((incident.resolved_at ?? incident.opened_at) - incident.opened_at);
  return `*Automatically resolved ${incident.job} incident*\nLasted ${lasted}.`;
}

async function post(webhook: string, text: string): Promise<boolean> {
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
