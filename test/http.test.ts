import { createScheduledController, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { recordFailure, recordPing } from "../src/store";
import { HOUR, mockSlack, PING, READ, resetDatabase } from "./helpers";

const BASE = "https://heartbeat.test";
const get = (path: string, headers: Record<string, string> = {}) => SELF.fetch(BASE + path, { headers });
const post = (path: string, headers: Record<string, string> = {}, body?: string) =>
  SELF.fetch(BASE + path, { method: "POST", headers, body });
const runCron = (scheduledTime: number) =>
  worker.scheduled(createScheduledController({ scheduledTime }), env);

beforeEach(async () => {
  await resetDatabase();
  mockSlack();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("/ping and /fail", () => {
  it("registers a job and answers with its schedule", async () => {
    const response = await post("/ping/Nightly?every=1d&grace=30m", PING);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, job: "Nightly", every: 86400, grace: 1800, paused: false });
  });

  it("accepts GET, for callers that only know how to fetch a URL", async () => {
    expect((await get("/ping/Nightly?every=1d", PING)).status).toBe(200);
  });

  it("opens an incident from a POSTed failure, keeping the body", async () => {
    const response = await post("/fail/Nightly?every=1d", PING, "it broke");
    expect(await response.json()).toMatchObject({ ok: true, incidentOpened: true });
    expect(await env.DB.prepare("SELECT detail FROM incidents").first("detail")).toBe("it broke");
  });

  it("refuses GET on /fail, so a crawler cannot open incidents", async () => {
    expect((await get("/fail/Nightly?every=1d", PING)).status).toBe(405);
  });

  it("refuses a missing token, a wrong one and the read token", async () => {
    expect((await post("/ping/Nightly?every=1d")).status).toBe(401);
    expect((await post("/ping/Nightly?every=1d", { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/ping/Nightly?every=1d", READ)).status).toBe(401);
    expect((await post("/fail/Nightly?every=1d", READ)).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first("n")).toBe(0);
  });

  it("refuses bad names and bad schedules without storing anything", async () => {
    for (const path of [
      "/ping/has%20space?every=1h",
      "/ping/" + "x".repeat(65) + "?every=1h",
      "/ping/%E0%A4%A?every=1h",
      "/ping/Nightly",
      "/ping/Nightly?every=10",
      "/ping/Nightly?every=30s",
      "/ping/Nightly?every=1h&grace=8d",
    ]) {
      const response = await post(path, PING);
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toHaveProperty("error");
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first("n")).toBe(0);
  });

  it("does not treat a longer path as a ping", async () => {
    expect((await post("/ping/Nightly/extra?every=1d", PING)).status).toBe(404);
  });
});

describe("/health", () => {
  it("is unhealthy before the cron trigger has ever run", async () => {
    expect((await get("/health")).status).toBe(503);
  });

  it("is healthy right after a run, and through a late one, until runs stop for 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await runCron(Date.now());
    expect((await get("/health")).status).toBe(200);
    vi.setSystemTime(Date.now() + 9 * 60 * 1000);
    expect((await get("/health")).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    const response = await get("/health");
    expect(response.status).toBe(503);
    expect(Object.keys(await response.json())).toEqual(["ok", "lastCheck"]);
  });

  it("stays healthy when Cloudflare delivers an old run late", async () => {
    // A late run still carries its original scheduledTime, minutes ago.
    await runCron(Date.now());
    await runCron(Date.now() - 15 * 60 * 1000);
    const response = await get("/health");
    expect(response.status).toBe(200);
    const { lastCheck } = (await response.json()) as { lastCheck: string };
    expect(Date.now() - Date.parse(lastCheck)).toBeLessThan(60 * 1000);
  });
});

describe("/api/status", () => {
  it("reports jobs, their state and recent incidents", async () => {
    const now = Date.now();
    await recordPing(env.DB, "Fine", { every: 3600 }, now);
    await recordPing(env.DB, "Late", { every: 3600, grace: 600 }, now - 2 * HOUR);
    await recordFailure(env.DB, "Broken", { every: 3600 }, "boom", now);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await runCron(now);

    const response = await get("/api/status", READ);
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      jobs: { name: string; state: string }[];
      incidents: { job: string; cause: string; detail: string | null; resolvedAt: string | null }[];
      lastCheck: string;
    };
    expect(status.jobs.map((j) => [j.name, j.state])).toEqual([
      ["Broken", "failed"],
      ["Fine", "up"],
      ["Late", "late"],
    ]);
    expect(status.incidents.map((i) => [i.job, i.cause, i.detail, i.resolvedAt]).sort()).toEqual([
      ["Broken", "failed", "boom", null],
      ["Late", "late", null, null],
    ]);
    expect(status.lastCheck).toBe(new Date(now).toISOString());
  });

  it("refuses a missing token and the ping token", async () => {
    expect((await get("/api/status")).status).toBe(401);
    expect((await get("/api/status", PING)).status).toBe(401);
  });
});

describe("the status page", () => {
  it("is only served when the request came through Cloudflare Access", async () => {
    expect((await get("/")).status).toBe(403);
  });

  it("renders jobs and escapes what the jobs sent", async () => {
    await recordFailure(env.DB, "Broken", { every: 3600 }, "<script>alert(1)</script>", Date.now());
    const response = await get("/", { "Cf-Access-Jwt-Assertion": "x" });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("1 of 1 jobs down");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

it("answers 404 for anything else", async () => {
  expect((await get("/nope")).status).toBe(404);
});
