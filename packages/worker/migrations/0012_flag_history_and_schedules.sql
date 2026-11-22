-- Feature flags: a history of every change, and changes scheduled for later.

CREATE TABLE IF NOT EXISTS flag_changes (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  flag_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- create | update | delete | schedule
  action TEXT NOT NULL,
  -- Who: the key's scope, plus an optional name (X-Glass-Actor header or the actor field).
  actor TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS flag_changes_by_flag ON flag_changes (project, flag_key, at);

CREATE TABLE IF NOT EXISTS flag_schedules (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  flag_key TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  -- JSON: the fields to change, e.g. {"enabled":true,"rollout":50}
  change TEXT NOT NULL,
  -- pending | done | failed | cancelled
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  error TEXT,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS flag_schedules_due ON flag_schedules (status, run_at);
