# heartbeat-worker

A dead man's switch for scheduled jobs, on one Cloudflare Worker and one D1 database.

Each job pings the Worker when it finishes. If a ping is late, or a job reports that it failed, the Worker posts to Slack. When the job pings again, it posts that the incident is resolved. That is the whole product.

- **Jobs declare themselves.** The first ping carries the schedule (`?every=1h`), so there is nothing to configure.
- **Failures are reported, not just inferred.** A job that knows it failed alerts within a minute and says why.
- **The watcher is watched.** `/health` turns unhealthy when the Worker's own cron trigger stops running. Point an outside check at it.
- **A read-only status page**, plus a JSON status API for scripts and agents.
- **Optional: tidier Cloudflare health check alerts.** Point a Cloudflare notification at the Worker and it posts one short line per outage instead of Cloudflare's own block of text.

It runs comfortably on the Workers free plan.

## Pinging it

Every ping and failure needs `Authorization: Bearer <PING_TOKEN>`.

```sh
# A successful run. GET works too, for callers that can only fetch a URL.
curl -X POST -H "Authorization: Bearer $PING_TOKEN" \
  "https://heartbeat.example.com/ping/NightlyBackup?every=1d&grace=30m"

# A run that knows it failed. The body (up to 2000 characters) appears in Slack.
curl -X POST -H "Authorization: Bearer $PING_TOKEN" --data "disk full" \
  "https://heartbeat.example.com/fail/NightlyBackup?every=1d&grace=30m"
```

- **Job names** match `[A-Za-z0-9_-]{1,64}`.
- **`every`** is how often the job runs: `90s`, `10m`, `2h` or `7d`, from 1 minute to 30 days. It is required on a job's first ping. After that it is optional, and the latest value given wins.
- **`grace`** is how long past `every` to wait before alerting, at most 7 days. It defaults to 10% of `every`, and never less than five minutes.
- **A job is late** once `every + grace` has passed since its last successful ping. There is one incident per job at a time.
- **A failure does not count as a ping.** It opens an incident, or adds its text to the one already open. The next successful ping resolves it.

Send the ping last, after the work has succeeded, and never let a failed ping fail the job. A lost ping costs you a false alarm; a thrown one costs you a failed run that actually worked.

## Reading it

| Path | Auth | What |
|---|---|---|
| `GET /health` | none | `200` if the cron trigger ran in the last 5 minutes, `503` otherwise. Shows no job data. |
| `GET /api/status` | `Bearer <READ_TOKEN>` | JSON: every job and its state, incidents from the last 14 days, and the last check time. |
| `GET /` | Cloudflare Access | The status page. |
| `POST /cloudflare/health` | `cf-webhook-auth: <CLOUDFLARE_WEBHOOK_SECRET>` | Receives Cloudflare notifications. See [below](#cloudflare-health-check-alerts). |

The read token and the ping token are separate on purpose. Whatever reads status can never send a ping, so it can never make a dead job look alive.

The Worker does not authenticate the status page itself; put a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) application in front of `/`. As a guard against forgetting, the Worker refuses to serve the page to requests without the header Access adds. That guard is not security, because anyone can send the header if Access is missing.

## Deploying your own

You need a Cloudflare account, a zone for the custom domain, and a Slack [incoming webhook](https://api.slack.com/messaging/webhooks).

```sh
npm ci
npx wrangler login
npx wrangler deploy --domain heartbeat.example.com   # creates the D1 database on first deploy
npx wrangler d1 migrations apply heartbeat-worker --remote
npx wrangler secret put PING_TOKEN          # any long random string
npx wrangler secret put READ_TOKEN          # a different one
npx wrangler secret put SLACK_WEBHOOK_URL
```

Then:

1. **Protect the status page.** Create a Cloudflare Access application for `heartbeat.example.com`, then bypass it for `/ping/*`, `/fail/*`, `/health` and `/api/*`. Those paths check their own tokens.
2. **Watch the watcher.** Point a Cloudflare health check, or any uptime checker, at `/health`.
3. **Try it.** Ping a test job with `?every=1m`, stop pinging, and within about seven minutes you should see the incident in Slack. One more ping resolves it.

Pass `--domain` on every deploy. The config file names no domain, so the repository stays generic.

When the first deploy creates the database, Wrangler may write its `database_id` into `wrangler.toml`. Discard that change: later deploys and `wrangler d1` commands find the database by name. To avoid the write altogether, run `npx wrangler d1 create heartbeat-worker` before the first deploy.

Without `SLACK_WEBHOOK_URL`, incidents are still recorded, but nothing is posted.

## Cloudflare health check alerts

Cloudflare's own Slack message for a health check is a dozen lines of ids and labels, and a burst of "Healthy" posts appears whenever checks are created. Sent through the Worker instead, the same alerts read:

```
🔴 *image-server* is down: got 503, expected 200
✅ *image-server* is back up after 4m
```

"Back up" is only posted for a check the Worker announced as down, so new checks and repeated "Healthy" notifications stay quiet. Any other notification, including the dashboard's test message, is passed on to Slack as it is.

To set it up:

```sh
npx wrangler secret put CLOUDFLARE_WEBHOOK_SECRET   # another long random string
```

1. In Cloudflare **Notifications → Destinations**, create a generic webhook with the Worker's workers.dev URL, `https://heartbeat-worker.<your-subdomain>.workers.dev/cloudflare/health`, and the same secret. Cloudflare sends it in the `cf-webhook-auth` header; the Worker refuses anything else, including the ping and read tokens.
2. Point your Health Checks notification at that webhook, and remove its Slack destination once a test alert looks right.

Use workers.dev, not the custom domain: Cloudflare's webhook test against the custom domain gets a 403 before the request reaches the Worker, even with Access bypassed for the path. `wrangler.toml` turns workers.dev on for this. Every path there checks its own secret, and the status page refuses requests that did not come through Access.

If Slack refuses a message, the endpoint answers `502` and leaves its state as it was, so a redelivery posts it. The payload Cloudflare sends has no URL for the check, so the message names the check but does not link it.

One caveat: if the Worker itself is broken, its alerts cannot reach Slack through it. Keep the health check on `/health` notifying Slack directly, in a notification of its own.

## Operating it

There is no admin UI. The rare changes are one SQL statement each:

```sh
# Pause a job: no alerts until you unpause it
npx wrangler d1 execute heartbeat-worker --remote --command "UPDATE jobs SET paused = 1 WHERE name = 'NightlyBackup'"

# Forget a job that no longer exists
npx wrangler d1 execute heartbeat-worker --remote --command "DELETE FROM jobs WHERE name = 'OldJob'; DELETE FROM incidents WHERE job = 'OldJob'"
```

- **Typo in a job name?** You get a second job that never pings again, and it goes late after one interval. Forget it with the statement above.
- **Slack down?** Messages are retried every minute, up to 20 per run, and nothing is posted twice.
- **History:** resolved incidents are kept for 90 days.

## Developing

```sh
npm run check   # typecheck, lint, tests
npm run dev     # local Worker with a local D1
```

Tests run inside the Workers runtime against a real local D1, using `@cloudflare/vitest-plugin`.

## Licence

MIT
