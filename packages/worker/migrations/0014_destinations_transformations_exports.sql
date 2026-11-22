-- Destinations (forward events to other tools), transformations (rules applied at ingest)
-- and batch exports (files of events to S3/R2, BigQuery or an HTTP endpoint).

CREATE TABLE IF NOT EXISTS destinations (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- JSON: { "events": [...], "filters": [...] }: which events go.
  match TEXT NOT NULL DEFAULT '{}',
  -- JSON of the template's non-secret inputs.
  config TEXT NOT NULL DEFAULT '{}',
  -- AES-GCM encrypted JSON of its secret inputs (see packages/core/src/crypto.ts).
  secrets TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);

-- Deliveries per destination per hour.
CREATE TABLE IF NOT EXISTS destination_stats (
  project TEXT NOT NULL,
  destination TEXT NOT NULL,
  hour INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, destination, hour)
);

-- Deliveries that failed for good, with what was sent, so they can be retried.
CREATE TABLE IF NOT EXISTS destination_failures (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  destination TEXT NOT NULL,
  event_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  status INTEGER,
  error TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS destination_failures_by_destination ON destination_failures (project, destination, at);

-- Deliveries waiting to be sent by the five-minute task: when there is no queue, when sending
-- to the queue failed, or retries of failed ones.
CREATE TABLE IF NOT EXISTS delivery_outbox (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  destination TEXT NOT NULL,
  message TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_outbox_due ON delivery_outbox (next_at);

CREATE TABLE IF NOT EXISTS transformations (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- JSON rule (packages/core/src/transformations.ts).
  rule TEXT NOT NULL,
  -- How many events it changed or dropped, for the dashboard.
  applied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);

CREATE TABLE IF NOT EXISTS batch_exports (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- s3 | bigquery | http
  target TEXT NOT NULL,
  -- jsonl | csv
  format TEXT NOT NULL DEFAULT 'jsonl',
  -- hour | day
  frequency TEXT NOT NULL DEFAULT 'hour',
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  secrets TEXT,
  -- Events received before this (epoch ms) have been exported.
  watermark INTEGER NOT NULL,
  -- Mid-run position: the next (received_ms, id) to export, or NULL between runs.
  cursor TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);

CREATE TABLE IF NOT EXISTS batch_export_runs (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  -- running | done | failed
  status TEXT NOT NULL,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS batch_export_runs_by_export ON batch_export_runs (project, export_id, started_at);
