-- Error tracking: exceptions grouped into issues by fingerprint, and uploaded source maps.

CREATE TABLE IF NOT EXISTS error_issues (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  -- active | resolved | suppressed | merged
  status TEXT NOT NULL DEFAULT 'active',
  merged_into TEXT,
  assignee TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  -- Exceptions not stored: the issue was suppressed, or over the per-minute limit.
  dropped INTEGER NOT NULL DEFAULT 0,
  first_release TEXT,
  last_release TEXT,
  resolved_at INTEGER,
  regressed_at INTEGER,
  regressions INTEGER NOT NULL DEFAULT 0,
  -- Spike alerts: occurrences in the current window.
  window_start INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0,
  spike_alerted_at INTEGER,
  -- The latest exception, as JSON, and its symbolicated frames once a dashboard has asked for them.
  sample TEXT,
  symbolicated TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS error_issues_seen ON error_issues (project, status, last_seen);

CREATE TABLE IF NOT EXISTS error_fingerprints (
  project TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (project, fingerprint)
);
CREATE INDEX IF NOT EXISTS error_fingerprints_issue ON error_fingerprints (project, issue_id);

-- Source maps live in R2 (sourcemaps/<project>/<release>/<hash>.map); this is their index.
CREATE TABLE IF NOT EXISTS sourcemaps (
  project TEXT NOT NULL,
  release TEXT NOT NULL,
  path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (project, release, path)
);
CREATE INDEX IF NOT EXISTS sourcemaps_path ON sourcemaps (project, path, uploaded_at);
