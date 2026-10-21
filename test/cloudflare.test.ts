import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHealthEvent } from "../src/cloudflare";
import { mockSlack, PING, READ, resetDatabase, WEBHOOK } from "./helpers";

const T = Date.UTC(2026, 9, 21, 7, 35, 27);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** A health check notification in the shape of Cloudflare's webhook payload schema. */
function notification(name: string, status: "Healthy" | "Unhealthy", at = T, text?: string) {
  return {
    account_id: "acc",
    alert_correlation_id: "corr",
    alert_event: status === "Healthy" ? "ALERT_STATE_EVENT_END" : "ALERT_STATE_EVENT_START",
    alert_type: "health_check_status_notification",
    data: {
      health_check_id: `id-${name}`,
      health_check_name: name,
      new_health_status: status,
      old_status: status === "Healthy" ? "Unhealthy" : "Healthy",
      reason: status === "Healthy" ? "" : "Response code mismatch error",
      status_change_time: iso(at),
      zone_name: "example.com",
    },
    name: "Health Check Alert",
    policy_name: "Health Check Alert",
    text:
      text ??
      `Health Check Name: ${name}\nStatus: ${status}\n` +
        (status === "Unhealthy" ? "Failure reason: Response code mismatch error\nExpected codes: [200]\nReceived code: 503" : ""),
    ts: Math.floor(at / 1000),
  };
}

const send = (body: unknown, headers: Record<string, string> = WEBHOOK) =>
  SELF.fetch("https://heartbeat.test/cloudflare/health", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let posted: string[];
beforeEach(async () => {
  await resetDatabase();
  posted = mockSlack().posted;
});
afterEach(() => vi.restoreAllMocks());

describe("reading the payload", () => {
  it("prefers the status codes in the text to the generic reason", () => {
    expect(readHealthEvent(notification("image-server", "Unhealthy"), 0)).toEqual({
      id: "id-image-server",
      name: "image-server",
      healthy: false,
      at: T,
      reason: "got 503, expected 200",
    });
  });

  it("falls back to Cloudflare's reason when the text has no codes", () => {
    const event = readHealthEvent(notification("api", "Unhealthy", T, "Status: Unhealthy"), 0);
    expect(event?.reason).toBe("Response code mismatch error");
  });

  it("lists several expected codes", () => {
    const event = readHealthEvent(notification("api", "Unhealthy", T, "Expected codes: [200 301]\nReceived code: 500"), 0);
    expect(event?.reason).toBe("got 500, expected 200 or 301");
  });

  it("tells the status from alert_event when the status field is missing", () => {
    const payload = notification("api", "Healthy");
    delete (payload.data as Partial<typeof payload.data>).new_health_status;
    expect(readHealthEvent(payload, 0)?.healthy).toBe(true);
  });

  it("is null for other notifications and for a status it cannot tell", () => {
    expect(readHealthEvent({ text: "Hello World!" }, 0)).toBeNull();
    const odd = notification("api", "Healthy");
    expect(readHealthEvent({ ...odd, alert_event: "SOMETHING_NEW", data: { ...odd.data, new_health_status: "Degraded" } }, 0)).toBeNull();
  });
});

describe("POST /cloudflare/health", () => {
  it("refuses a missing or wrong secret, and the ping and read tokens", async () => {
    const wrong: Record<string, string>[] = [{}, { "cf-webhook-auth": "nope" }, PING, READ];
    for (const headers of wrong) {
      expect((await send(notification("api", "Unhealthy"), headers)).status).toBe(401);
    }
    expect(posted).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM health_checks").first("n")).toBe(0);
  });

  it("does not accept its secret on /ping", async () => {
    expect((await SELF.fetch("https://heartbeat.test/ping/Job?every=1h", { method: "POST", headers: WEBHOOK })).status).toBe(401);
  });

  it("refuses GET and a body that is not a JSON object", async () => {
    expect((await SELF.fetch("https://heartbeat.test/cloudflare/health", { headers: WEBHOOK })).status).toBe(405);
    expect((await send("not json")).status).toBe(400);
    expect((await send("[1]")).status).toBe(400);
  });

  it("posts down, then back up with how long it lasted", async () => {
    const down = await send(notification("image-server", "Unhealthy"));
    expect(await down.json()).toEqual({ ok: true, posted: true });
    await send(notification("image-server", "Healthy", T + 4 * 60000));
    expect(posted).toEqual([
      "🔴 *image-server* is down: got 503, expected 200",
      "✅ *image-server* is back up after 4m",
    ]);
  });

  it("stays quiet about checks it never saw go down, such as newly created ones", async () => {
    for (const name of ["a", "b", "c"]) {
      expect(await (await send(notification(name, "Healthy"))).json()).toEqual({ ok: true, posted: false });
    }
    expect(posted).toEqual([]);
  });

  it("announces a check going down once, and coming back once", async () => {
    await send(notification("api", "Unhealthy"));
    await send(notification("api", "Unhealthy", T + 60000));
    await send(notification("api", "Healthy", T + 120000));
    await send(notification("api", "Healthy", T + 180000));
    expect(posted).toHaveLength(2);
  });

  it("keeps the state unchanged when Slack refuses, so Cloudflare's retry posts it", async () => {
    vi.restoreAllMocks();
    mockSlack(500);
    expect((await send(notification("api", "Unhealthy"))).status).toBe(502);
    vi.restoreAllMocks();
    posted = mockSlack().posted;
    await send(notification("api", "Unhealthy"));
    expect(posted).toEqual(["🔴 *api* is down: got 503, expected 200"]);

    vi.restoreAllMocks();
    mockSlack(500);
    expect((await send(notification("api", "Healthy", T + 3600000))).status).toBe(502);
    vi.restoreAllMocks();
    posted = mockSlack().posted;
    await send(notification("api", "Healthy", T + 3600000));
    expect(posted).toEqual(["✅ *api* is back up after 1h"]);
  });

  it("passes the dashboard's test message and other notifications on as they are", async () => {
    await send({ text: "Hello World! This is a test message sent from https://cloudflare.com." });
    await send({ name: "Some Other Alert", text: "Something <happened>", alert_type: "other" });
    expect(posted).toEqual([
      "ℹ️ *Cloudflare notification*\nHello World! This is a test message sent from https://cloudflare.com.",
      "ℹ️ *Some Other Alert*\nSomething &lt;happened&gt;",
    ]);
  });
});
