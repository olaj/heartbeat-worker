import { parseDuration } from "./duration";

export const JOB_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const MIN_EVERY = 60;
const MAX_EVERY = 30 * 86400;
const MAX_GRACE = 7 * 86400;
const MAX_DETAIL = 2000;
/** Resolved incidents older than this are deleted. The status API shows 14 days. */
const KEEP_INCIDENTS_MS = 90 * 86400 * 1000;

export interface JobRow {
  name: string;
  every_seconds: number;
  grace_seconds: number;
  last_ping: number | null;
  paused: number;
  created_at: number;
}

export interface IncidentRow {
  id: number;
  job: string;
  cause: "late" | "failed";
  detail: string | null;
  opened_at: number;
  resolved_at: number | null;
  open_notified: number;
  resolve_notified: number;
}

export type Schedule = { every: number; grace: number };

export class BadRequest extends Error {}

/** 10% of the interval, but never under five minutes. */
export function defaultGrace(every: number): number {
  return Math.max(300, Math.round(every / 10));
}

/**
 * Reads `every` and `grace` from a ping's query string. Both are optional on a
 * job we already know; `every` is required to create one, because without it
 * there is no deadline to miss.
 */
export function readSchedule(params: URLSearchParams): Partial<Schedule> {
  const result: Partial<Schedule> = {};
  const every = params.get("every");
  const grace = params.get("grace");
  if (every !== null) {
    const seconds = parseDuration(every);
    if (seconds === null || seconds < MIN_EVERY || seconds > MAX_EVERY) {
      throw new BadRequest("every must look like 10m, 2h or 1d, between 1m and 30d");
    }
    result.every = seconds;
  }
  if (grace !== null) {
    const seconds = parseDuration(grace);
    if (seconds === null || seconds > MAX_GRACE) {
      throw new BadRequest("grace must look like 30s, 10m or 1h, at most 7d");
    }
    result.grace = seconds;
  }
  return result;
}

/**
 * Creates the job, or updates its schedule when the ping declares one. The
 * latest ping wins: a job whose interval changes in code changes here on its
 * next run. Declaring `every` without `grace` resets grace to the default.
 */
async function upsertJob(db: D1Database, name: string, schedule: Partial<Schedule>, now: number): Promise<JobRow> {
  const existing = await db.prepare("SELECT * FROM jobs WHERE name = ?").bind(name).first<JobRow>();
  if (!existing) {
    if (schedule.every === undefined) {
      throw new BadRequest(`unknown job ${name}: its first ping must declare ?every=`);
    }
    const grace = schedule.grace ?? defaultGrace(schedule.every);
    await db
      .prepare("INSERT OR IGNORE INTO jobs (name, every_seconds, grace_seconds, created_at) VALUES (?, ?, ?, ?)")
      .bind(name, schedule.every, grace, now)
      .run();
    return (await db.prepare("SELECT * FROM jobs WHERE name = ?").bind(name).first<JobRow>())!;
  }
  if (schedule.every === undefined && schedule.grace === undefined) return existing;
  const every = schedule.every ?? existing.every_seconds;
  const grace = schedule.grace ?? (schedule.every !== undefined ? defaultGrace(every) : existing.grace_seconds);
  if (every !== existing.every_seconds || grace !== existing.grace_seconds) {
    await db.prepare("UPDATE jobs SET every_seconds = ?, grace_seconds = ? WHERE name = ?").bind(every, grace, name).run();
  }
  return { ...existing, every_seconds: every, grace_seconds: grace };
}

/** A successful run: records the ping and resolves whatever incident was open. */
export async function recordPing(db: D1Database, name: string, schedule: Partial<Schedule>, now: number): Promise<JobRow> {
  const job = await upsertJob(db, name, schedule, now);
  await db.batch([
    db.prepare("UPDATE jobs SET last_ping = ? WHERE name = ?").bind(now, name),
    db.prepare("UPDATE incidents SET resolved_at = ? WHERE job = ? AND resolved_at IS NULL").bind(now, name),
  ]);
  return { ...job, last_ping: now };
}

/**
 * A run that knows it failed. Opens an incident unless one is open already, in
 * which case the failure text is kept if the open one had none. Does not count
 * as a ping, so a job that keeps failing also goes late. A paused job records
 * nothing.
 */
export async function recordFailure(
  db: D1Database,
  name: string,
  schedule: Partial<Schedule>,
  detail: string,
  now: number,
): Promise<{ job: JobRow; opened: boolean }> {
  const job = await upsertJob(db, name, schedule, now);
  if (job.paused) return { job, opened: false };
  const text = detail.trim().slice(0, MAX_DETAIL) || null;
  const insert = await db
    .prepare("INSERT OR IGNORE INTO incidents (job, cause, detail, opened_at) VALUES (?, 'failed', ?, ?)")
    .bind(name, text, now)
    .run();
  if (insert.meta.changes === 0 && text) {
    await db
      .prepare("UPDATE incidents SET detail = ? WHERE job = ? AND resolved_at IS NULL AND detail IS NULL")
      .bind(text, name)
      .run();
  }
  return { job, opened: insert.meta.changes === 1 };
}

/**
 * The cron trigger's job: open a `late` incident for every unpaused job past
 * its deadline that has none open, note that the check ran, and prune old
 * history. Returns the names that went late.
 */
export async function checkDeadlines(db: D1Database, now: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM jobs j
       WHERE paused = 0
         AND COALESCE(last_ping, created_at) + (every_seconds + grace_seconds) * 1000 < ?
         AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.job = j.name AND i.resolved_at IS NULL)
       ORDER BY name`,
    )
    .bind(now)
    .all<{ name: string }>();
  const late = results.map((r) => r.name);
  await db.batch([
    ...late.map((name) =>
      db.prepare("INSERT OR IGNORE INTO incidents (job, cause, opened_at) VALUES (?, 'late', ?)").bind(name, now),
    ),
    // Only ever forward: a late or overlapping run that commits last must
    // not make the cron look older than it is.
    db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('last_check', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
         WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)`,
      )
      .bind(String(now)),
    db
      .prepare("DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ? AND resolve_notified = 1")
      .bind(now - KEEP_INCIDENTS_MS),
  ]);
  return late;
}

export async function lastCheck(db: D1Database): Promise<number | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'last_check'").first<{ value: string }>();
  return row ? Number(row.value) : null;
}

export function deadline(job: JobRow): number {
  return (job.last_ping ?? job.created_at) + (job.every_seconds + job.grace_seconds) * 1000;
}
