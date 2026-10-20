import { formatDuration, humanDuration } from "./duration";
import { deadline, lastCheck, type IncidentRow, type JobRow } from "./store";

const INCIDENT_WINDOW_MS = 14 * 86400 * 1000;

export type JobState = "up" | "late" | "failed" | "paused" | "waiting";

export interface Status {
  now: string;
  lastCheck: string | null;
  jobs: {
    name: string;
    state: JobState;
    every: string;
    grace: string;
    lastPing: string | null;
    deadline: string;
    paused: boolean;
  }[];
  incidents: {
    id: number;
    job: string;
    cause: "late" | "failed";
    detail: string | null;
    openedAt: string;
    resolvedAt: string | null;
    durationSeconds: number;
  }[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Everything the status page shows, and what an automated reader gets from /api/status. */
export async function readStatus(db: D1Database, now: number): Promise<Status> {
  const [jobs, incidents, checked] = await Promise.all([
    db.prepare("SELECT * FROM jobs ORDER BY name").all<JobRow>(),
    db
      .prepare("SELECT * FROM incidents WHERE opened_at >= ? OR resolved_at IS NULL ORDER BY opened_at DESC")
      .bind(now - INCIDENT_WINDOW_MS)
      .all<IncidentRow>(),
    lastCheck(db),
  ]);
  const open = new Map(incidents.results.filter((i) => i.resolved_at === null).map((i) => [i.job, i]));
  return {
    now: iso(now)!,
    lastCheck: iso(checked),
    jobs: jobs.results.map((job) => ({
      name: job.name,
      state: job.paused
        ? "paused"
        : (open.get(job.name)?.cause ?? (job.last_ping === null ? "waiting" : "up")),
      every: formatDuration(job.every_seconds),
      grace: formatDuration(job.grace_seconds),
      lastPing: iso(job.last_ping),
      deadline: iso(deadline(job))!,
      paused: job.paused === 1,
    })),
    incidents: incidents.results.map((i) => ({
      id: i.id,
      job: i.job,
      cause: i.cause,
      detail: i.detail,
      openedAt: iso(i.opened_at)!,
      resolvedAt: iso(i.resolved_at),
      durationSeconds: Math.round(((i.resolved_at ?? now) - i.opened_at) / 1000),
    })),
  };
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ago = (now: number, at: string | null) => (at ? `${humanDuration(now - Date.parse(at))} ago` : "never");

/** One server-rendered page. No scripts, no assets, nothing to build. */
export function renderStatusPage(status: Status): string {
  const now = Date.parse(status.now);
  const down = status.jobs.filter((j) => j.state === "late" || j.state === "failed").length;
  const jobRows = status.jobs
    .map(
      (j) => `<tr class="${j.state}"><td>${escape(j.name)}</td><td>${j.state}</td><td>${ago(now, j.lastPing)}</td>` +
        `<td>${j.every} + ${j.grace}</td><td>${j.paused ? "–" : escape(j.deadline.slice(0, 16).replace("T", " "))}</td></tr>`,
    )
    .join("\n");
  const incidentRows = status.incidents
    .slice(0, 20)
    .map(
      (i) => `<tr class="${i.resolvedAt ? "up" : i.cause}"><td>${escape(i.job)}</td><td>${i.cause}</td>` +
        `<td>${escape(i.openedAt.slice(0, 16).replace("T", " "))}</td>` +
        `<td>${i.resolvedAt ? humanDuration(i.durationSeconds * 1000) : "open"}</td>` +
        `<td>${i.detail ? escape(i.detail.slice(0, 200)) : ""}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${down ? `${down} down` : "All up"} · heartbeats</title>
<style>
  body { font: 15px/1.4 system-ui, sans-serif; margin: 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { font-weight: 600; font-size: .85rem; color: #555; }
  tr.late td:nth-child(2), tr.failed td:nth-child(2) { color: #b00020; font-weight: 600; }
  tr.paused, tr.waiting { color: #777; }
  .meta { color: #555; font-size: .85rem; }
  @media (max-width: 40rem) { td:nth-child(4), th:nth-child(4) { display: none; } }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; } th, .meta { color: #aaa; } th, td { border-color: #333; }
    tr.late td:nth-child(2), tr.failed td:nth-child(2) { color: #ff6b81; }
  }
</style>
</head>
<body>
<h1>${down ? `${down} of ${status.jobs.length} jobs down` : `All ${status.jobs.length} jobs up`}</h1>
<p class="meta">Last check ${ago(now, status.lastCheck)}. Times are UTC.</p>
<table>
<thead><tr><th>Job</th><th>State</th><th>Last ping</th><th>Every + grace</th><th>Deadline</th></tr></thead>
<tbody>
${jobRows || '<tr><td colspan="5">No jobs have pinged yet.</td></tr>'}
</tbody>
</table>
<h2>Incidents, last 14 days</h2>
<table>
<thead><tr><th>Job</th><th>Cause</th><th>Opened</th><th>Lasted</th><th>Detail</th></tr></thead>
<tbody>
${incidentRows || '<tr><td colspan="5">None.</td></tr>'}
</tbody>
</table>
</body>
</html>`;
}
