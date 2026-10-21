import { env } from "cloudflare:test";
import { vi } from "vitest";

export const PING = { Authorization: "Bearer test-ping-token" };
export const READ = { Authorization: "Bearer test-read-token" };
export const WEBHOOK = { "cf-webhook-auth": "test-webhook-secret" };
export const HOUR = 3600 * 1000;
export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

export async function resetDatabase() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM meta"),
    env.DB.prepare("DELETE FROM health_checks"),
  ]);
}

/** Replaces fetch for the Slack webhook and returns the texts posted. */
export function mockSlack(status = 200) {
  const posted: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://hooks.slack.test/")) throw new Error(`unexpected fetch to ${url}`);
    posted.push(JSON.parse(String(init?.body)).text);
    return new Response("ok", { status });
  });
  return { posted, spy };
}
