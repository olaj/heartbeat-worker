import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { isTransientD1Error, retryD1 } from "../src/retry";
import { mockSlack, PING, resetDatabase } from "./helpers";

const NO_WAIT = [0, 0];
const internal = () => new Error("D1_ERROR: internal error; reference = abc123");

/** env.DB, except that its first `failures` prepare() calls throw a D1 internal error. */
function flakyDb(failures: number): D1Database {
  let left = failures;
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          if (left-- > 0) throw internal();
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  mockSlack();
});
afterEach(() => vi.restoreAllMocks());

describe("retryD1", () => {
  it("tells Cloudflare's errors from the query's own", () => {
    expect(isTransientD1Error(internal())).toBe(true);
    expect(isTransientD1Error(new Error("D1_ERROR: out of memory: SQLITE_NOMEM"))).toBe(true);
    expect(isTransientD1Error(new Error("D1_ERROR: no such table: jobs: SQLITE_ERROR"))).toBe(false);
    expect(isTransientD1Error(new Error("internal error"))).toBe(false);
  });

  it("tries again after a transient error", async () => {
    const work = vi.fn().mockRejectedValueOnce(internal()).mockResolvedValueOnce("done");
    expect(await retryD1(work, NO_WAIT)).toBe("done");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("gives up after its last attempt", async () => {
    const work = vi.fn().mockRejectedValue(internal());
    await expect(retryD1(work, NO_WAIT)).rejects.toThrow(/internal error/);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a query that is itself wrong", async () => {
    const work = vi.fn().mockRejectedValue(new Error("D1_ERROR: no such table: jobs: SQLITE_ERROR"));
    await expect(retryD1(work, NO_WAIT)).rejects.toThrow(/no such table/);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("keeps a ping that D1 fails once", async () => {
    const ctx = createExecutionContext();
    const request = new Request("https://heartbeat.test/ping/Nightly?every=1d", { method: "POST", headers: PING });
    const response = await worker.fetch(request, { ...env, DB: flakyDb(1) }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT last_ping FROM jobs WHERE name = 'Nightly'").first("last_ping")).not.toBeNull();
  });
});
