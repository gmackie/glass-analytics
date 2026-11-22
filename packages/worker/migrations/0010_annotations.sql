-- Annotations: notes pinned to a moment ("Launched pricing v2", "Ads paused") that show on
-- every time chart of the project, or only on one saved insight.
CREATE TABLE IF NOT EXISTS annotations (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- '' for the whole project, or a saved insight key.
  insight TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS annotations_by_time ON annotations (project, ts_ms);
