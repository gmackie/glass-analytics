-- Dashboards: saved analyses (and text) laid out on a 12-column grid, with filters that
-- apply to every tile unless a tile opts out.
CREATE TABLE IF NOT EXISTS dashboards (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- JSON: { from?, to?, filters?, filterTestAccounts? }
  filters TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);

CREATE TABLE IF NOT EXISTS dashboard_tiles (
  project TEXT NOT NULL,
  dashboard TEXT NOT NULL,
  id TEXT NOT NULL,
  -- insight | text
  kind TEXT NOT NULL,
  insight_key TEXT,
  text TEXT,
  -- Columns of 12: 3, 4, 6 or 12. Height: 1 (short) or 2 (tall).
  width INTEGER NOT NULL DEFAULT 6,
  height INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  ignore_filters INTEGER NOT NULL DEFAULT 0,
  -- JSON: { display? } shown on this tile only
  overrides TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (project, dashboard, id)
);
CREATE INDEX IF NOT EXISTS dashboard_tiles_insight ON dashboard_tiles (project, insight_key);
