import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushNotifications } from "../src/slack";
import { checkDeadlines, recordFailure, recordPing, type JobRow } from "../src/store";
import { HOUR, mockSlack, resetDatabase, T0 } from "./helpers";

const hourly = { every: 3600, grace: 600 };
const job = (name: string) => env.DB.prepare("SELECT * FROM jobs WHERE name = ?").bind(name).first<JobRow>();
const openIncidents = async () =>
  (await env.DB.prepare("SELECT job, cause, detail FROM incidents WHERE resolved_at IS NULL ORDER BY job").all())
    .results;

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

describe("pings", () => {
  it("creates a job on its first ping", async () => {
    await recordPing(env.DB, "Nightly", { every: 86400 }, T0);
    expect(await job("Nightly")).toMatchObject({ every_seconds: 86400, grace_seconds: 8640, last_ping: T0 });
  });

  it("gives short jobs a five-minute grace at least", async () => {
    await recordPing(env.DB, "Often", { every: 300 }, T0);
    expect((await job("Often"))!.grace_seconds).toBe(300);
  });

  it("refuses to create a job without an interval", async () => {
    await expect(recordPing(env.DB, "Nameless", {}, T0)).rejects.toThrow(/must declare \?every=/);
    expect(await job("Nameless")).toBeNull();
  });

  it("keeps the schedule when a later ping declares none", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await recordPing(env.DB, "Hourly", {}, T0 + HOUR);
    expect(await job("Hourly")).toMatchObject({ every_seconds: 3600, grace_seconds: 600, last_ping: T0 + HOUR });
  });

  it("takes the latest declared schedule, resetting grace when only every is given", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await recordPing(env.DB, "Hourly", { every: 7200 }, T0 + HOUR);
    expect(await job("Hourly")).toMatchObject({ every_seconds: 7200, grace_seconds: 720 });
    await recordPing(env.DB, "Hourly", { grace: 60 }, T0 + 2 * HOUR);
    expect(await job("Hourly")).toMatchObject({ every_seconds: 7200, grace_seconds: 60 });
  });
});

describe("deadlines", () => {
  it("leaves a job alone inside its grace period", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    expect(await checkDeadlines(env.DB, T0 + HOUR + 9 * 60000)).toEqual([]);
  });

  it("opens one late incident once the grace period is over, and only one", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    expect(await checkDeadlines(env.DB, T0 + HOUR + 11 * 60000)).toEqual(["Hourly"]);
    expect(await checkDeadlines(env.DB, T0 + 3 * HOUR)).toEqual([]);
    expect(await openIncidents()).toEqual([{ job: "Hourly", cause: "late", detail: null }]);
  });

  it("resolves the incident on the next ping", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await checkDeadlines(env.DB, T0 + 2 * HOUR);
    await recordPing(env.DB, "Hourly", {}, T0 + 2 * HOUR + 1);
    expect(await openIncidents()).toEqual([]);
  });

  it("ignores paused jobs", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await env.DB.prepare("UPDATE jobs SET paused = 1").run();
    expect(await checkDeadlines(env.DB, T0 + 5 * HOUR)).toEqual([]);
  });

  it("counts from registration for a job that has only ever failed", async () => {
    await recordFailure(env.DB, "Broken", hourly, "boom", T0);
    await recordPing(env.DB, "Other", hourly, T0);
    await env.DB.prepare("DELETE FROM incidents").run();
    expect(await checkDeadlines(env.DB, T0 + 2 * HOUR)).toEqual(["Broken", "Other"]);
  });

  it("records when the check last ran", async () => {
    await checkDeadlines(env.DB, T0);
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_check'").first("value")).toBe(String(T0));
  });

  it("never moves the last check back, whichever run commits last", async () => {
    await checkDeadlines(env.DB, T0 + HOUR);
    await checkDeadlines(env.DB, T0);
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_check'").first("value")).toBe(String(T0 + HOUR));
  });

  it("prunes announced, resolved incidents after 90 days", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await checkDeadlines(env.DB, T0 + 2 * HOUR);
    await recordPing(env.DB, "Hourly", {}, T0 + 3 * HOUR);
    await env.DB.prepare("UPDATE incidents SET open_notified = 1, resolve_notified = 1").run();
    await recordPing(env.DB, "Hourly", {}, T0 + 91 * 24 * HOUR);
    await checkDeadlines(env.DB, T0 + 91 * 24 * HOUR);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents").first("n")).toBe(0);
  });
});

describe("failures", () => {
  it("opens a failed incident with the text the job sent", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    const result = await recordFailure(env.DB, "Hourly", {}, "SqlException: timeout", T0 + HOUR);
    expect(result.opened).toBe(true);
    expect(await openIncidents()).toEqual([{ job: "Hourly", cause: "failed", detail: "SqlException: timeout" }]);
  });

  it("does not count as a ping", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await recordFailure(env.DB, "Hourly", {}, "", T0 + HOUR);
    expect((await job("Hourly"))!.last_ping).toBe(T0);
  });

  it("adds its text to an open late incident instead of opening another", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await checkDeadlines(env.DB, T0 + 2 * HOUR);
    const result = await recordFailure(env.DB, "Hourly", {}, "finally said why", T0 + 2 * HOUR);
    expect(result.opened).toBe(false);
    expect(await openIncidents()).toEqual([{ job: "Hourly", cause: "late", detail: "finally said why" }]);
  });

  it("is resolved by the next successful ping", async () => {
    await recordFailure(env.DB, "Hourly", hourly, "boom", T0);
    await recordPing(env.DB, "Hourly", {}, T0 + HOUR);
    expect(await openIncidents()).toEqual([]);
  });

  it("records nothing for a paused job", async () => {
    await recordPing(env.DB, "Hourly", hourly, T0);
    await env.DB.prepare("UPDATE jobs SET paused = 1").run();
    expect((await recordFailure(env.DB, "Hourly", {}, "boom", T0)).opened).toBe(false);
    expect(await openIncidents()).toEqual([]);
  });

  it("keeps at most 2000 characters of detail", async () => {
    await recordFailure(env.DB, "Hourly", hourly, "x".repeat(5000), T0);
    expect(((await openIncidents())[0]!.detail as string).length).toBe(2000);
  });
});

describe("Slack", () => {
  it("posts the incident and its resolution, keeping Better Stack's key phrases", async () => {
    const { posted } = mockSlack();
    await recordPing(env.DB, "Reports", hourly, T0);
    await checkDeadlines(env.DB, T0 + HOUR + 11 * 60000);
    await flushNotifications(env);
    await recordPing(env.DB, "Reports", {}, T0 + HOUR + 53 * 60000);
    await flushNotifications(env);
    expect(posted).toEqual([
      "🔴 *New incident for Reports*: no ping since <!date^1792497600^{date_short_pretty} at {time}|2026-10-20 12:00 UTC> (expected every 1h, grace 10m)",
      "✅ *Automatically resolved Reports incident* after 42m",
    ]);
  });

  it("quotes a failure's text", async () => {
    const { posted } = mockSlack();
    await recordFailure(env.DB, "Hourly", hourly, "line one\nline two", T0);
    await flushNotifications(env);
    expect(posted).toEqual(["🔴 *New incident for Hourly*: the job reported a failure\n> line one\n> line two"]);
  });

  it("says when a late job never pinged at all", async () => {
    const { posted } = mockSlack();
    await env.DB.prepare("INSERT INTO jobs (name, every_seconds, grace_seconds, created_at) VALUES ('Fresh', 3600, 600, ?)")
      .bind(T0)
      .run();
    await checkDeadlines(env.DB, T0 + 2 * HOUR);
    await flushNotifications(env);
    expect(posted).toEqual(["🔴 *New incident for Fresh*: no ping yet (expected every 1h, grace 10m)"]);
  });

  it("never posts the same message twice", async () => {
    const { posted } = mockSlack();
    await recordFailure(env.DB, "Hourly", hourly, "boom", T0);
    await Promise.all([flushNotifications(env), flushNotifications(env)]);
    await flushNotifications(env);
    expect(posted).toHaveLength(1);
  });

  it("keeps an incident Slack refused and posts it on the next run", async () => {
    mockSlack(500);
    await recordFailure(env.DB, "Hourly", hourly, "boom", T0);
    await flushNotifications(env);
    vi.restoreAllMocks();
    const { posted } = mockSlack();
    await flushNotifications(env);
    expect(posted).toHaveLength(1);
  });

  it("posts the opening before the resolution when both are pending", async () => {
    mockSlack(500);
    await recordFailure(env.DB, "Hourly", hourly, "boom", T0);
    await flushNotifications(env);
    await recordPing(env.DB, "Hourly", {}, T0 + HOUR);
    vi.restoreAllMocks();
    const { posted } = mockSlack();
    await flushNotifications(env);
    expect(posted.map((p) => /\*([^*]+)\*/.exec(p)![1])).toEqual([
      "New incident for Hourly",
      "Automatically resolved Hourly incident",
    ]);
  });
});
