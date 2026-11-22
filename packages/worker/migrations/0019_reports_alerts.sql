-- Scheduled reports (subscriptions) of a dashboard or an analysis, and alerts on analyses.
CREATE TABLE IF NOT EXISTS subscriptions (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  -- dashboard | insight
  target TEXT NOT NULL,
  target_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  -- JSON: { destinations?: string[], emails?: string[] }
  channels TEXT NOT NULL,
  -- JSON schedule (core/schedule.ts)
  schedule TEXT NOT NULL,
  -- JSON: tile ids to include (at most 20); empty for all, up to 20
  tiles TEXT NOT NULL DEFAULT '[]',
  message TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions (enabled, next_run_at);

-- One send of a subscription. Tiles are computed a few per cron tick (tiles_done), snapshots
-- go to R2 at reports/<project>/<run>/<tile>.json, then the report is sent.
CREATE TABLE IF NOT EXISTS subscription_runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  subscription TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  -- running | sent | failed
  status TEXT NOT NULL,
  -- JSON: tile ids, in order
  tiles TEXT NOT NULL,
  tiles_done INTEGER NOT NULL DEFAULT 0,
  -- JSON: per tile { title, value, delta, chart } as computed
  results TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
CREATE INDEX IF NOT EXISTS subscription_runs_open ON subscription_runs (status, started_at);

CREATE TABLE IF NOT EXISTS alerts (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  insight_key TEXT NOT NULL,
  -- JSON (core/alerts.ts)
  target TEXT NOT NULL DEFAULT '{}',
  condition TEXT NOT NULL,
  -- JSON: { schedule, ongoing?, skipWeekends?, quiet?: [{from,to}] }
  checks TEXT NOT NULL,
  -- JSON: { destinations?: string[], emails?: string[] }
  channels TEXT NOT NULL,
  -- ok | firing | errored | disabled
  state TEXT NOT NULL DEFAULT 'ok',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_value REAL,
  last_checked_at INTEGER,
  next_check_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS alerts_due ON alerts (enabled, next_check_at);

-- Each check, kept 90 days, for the alert's history chart.
CREATE TABLE IF NOT EXISTS alert_checks (
  project TEXT NOT NULL,
  alert TEXT NOT NULL,
  at INTEGER NOT NULL,
  value REAL,
  breakdown TEXT,
  fired INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS alert_checks_alert ON alert_checks (project, alert, at);
