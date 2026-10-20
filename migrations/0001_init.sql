-- Times are milliseconds since the epoch, UTC.

CREATE TABLE jobs (
  name TEXT PRIMARY KEY,
  every_seconds INTEGER NOT NULL,
  grace_seconds INTEGER NOT NULL,
  -- NULL until the first successful ping. Deadlines then run from created_at.
  last_ping INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  -- 'late' (no ping in time) or 'failed' (the job said so).
  cause TEXT NOT NULL,
  detail TEXT,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  -- Slack posts are claimed by flipping these, so a failed post is retried
  -- by the next run instead of being lost.
  open_notified INTEGER NOT NULL DEFAULT 0,
  resolve_notified INTEGER NOT NULL DEFAULT 0
);

-- At most one open incident per job, enforced by the database rather than by
-- whichever request got there first.
CREATE UNIQUE INDEX incidents_one_open ON incidents (job) WHERE resolved_at IS NULL;
CREATE INDEX incidents_opened_at ON incidents (opened_at);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
