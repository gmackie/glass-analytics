-- Holdouts: a share of people kept out of every experiment that uses the holdout, so the
-- combined effect of shipping those experiments can be measured against them.
CREATE TABLE IF NOT EXISTS holdouts (
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Share of people (0-100) held out.
  percentage REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, key)
);
