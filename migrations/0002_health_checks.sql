-- The last state each Cloudflare health check reported, so a "back up" message
-- is only posted for a check we announced as down. Times are milliseconds
-- since the epoch, UTC.

CREATE TABLE health_checks (
  -- Cloudflare's health check id, or its name when the payload has no id.
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- NULL while healthy. Set when a down message was posted.
  down_since INTEGER,
  updated_at INTEGER NOT NULL
);
