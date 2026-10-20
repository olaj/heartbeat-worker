import { hasToken } from "./auth";
import type { Env } from "./env";
import { flushNotifications } from "./slack";
import { readStatus, renderStatusPage } from "./status";
import { BadRequest, checkDeadlines, JOB_NAME, lastCheck, readSchedule, recordFailure, recordPing } from "./store";

/** /health turns unhealthy when the cron trigger has not run for this long. */
const STALE_CHECK_MS = 5 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const error = (status: number, message: string) => json({ error: message }, status);

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const now = Date.now();
  const [, action, rawName, extra] = url.pathname.split("/");

  if (url.pathname === "/health") {
    if (request.method !== "GET") return error(405, "use GET");
    const checked = await lastCheck(env.DB);
    const healthy = checked !== null && now - checked <= STALE_CHECK_MS;
    return json(
      { ok: healthy, lastCheck: checked === null ? null : new Date(checked).toISOString() },
      healthy ? 200 : 503,
    );
  }

  if ((action === "ping" || action === "fail") && rawName !== undefined && extra === undefined) {
    if (action === "ping" ? !["GET", "POST"].includes(request.method) : request.method !== "POST") {
      return error(405, action === "ping" ? "use GET or POST" : "use POST");
    }
    if (!hasToken(request, env.PING_TOKEN)) return error(401, "missing or wrong ping token");
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return error(400, "job name must match [A-Za-z0-9_-]{1,64}");
    }
    if (!JOB_NAME.test(name)) return error(400, "job name must match [A-Za-z0-9_-]{1,64}");
    try {
      const schedule = readSchedule(url.searchParams);
      const result =
        action === "ping"
          ? { job: await recordPing(env.DB, name, schedule, now), opened: false }
          : await recordFailure(env.DB, name, schedule, await request.text(), now);
      ctx.waitUntil(flushNotifications(env));
      return json({
        ok: true,
        job: result.job.name,
        every: result.job.every_seconds,
        grace: result.job.grace_seconds,
        paused: result.job.paused === 1,
        ...(action === "fail" ? { incidentOpened: result.opened } : {}),
      });
    } catch (e) {
      if (e instanceof BadRequest) return error(400, e.message);
      throw e;
    }
  }

  if (url.pathname === "/api/status") {
    if (request.method !== "GET") return error(405, "use GET");
    if (!hasToken(request, env.READ_TOKEN)) return error(401, "missing or wrong read token");
    return json(await readStatus(env.DB, now));
  }

  if (url.pathname === "/") {
    if (request.method !== "GET") return error(405, "use GET");
    // Cloudflare Access protects this page; the Worker does not. This header
    // is only set when a request came through Access, so its absence means
    // the Access application is missing. It is a guard against forgetting,
    // not authentication: anyone can send the header if Access is not there.
    if (!request.headers.has("Cf-Access-Jwt-Assertion")) {
      return new Response("The status page is only served behind Cloudflare Access.\n", { status: 403 });
    }
    return new Response(renderStatusPage(await readStatus(env.DB, now)), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return error(404, "not found");
}

export default {
  fetch: handle,

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await checkDeadlines(env.DB, controller.scheduledTime);
    await flushNotifications(env);
  },
} satisfies ExportedHandler<Env>;
