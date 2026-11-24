-- Public ingest discards bot events. Keep only what is needed to count a
-- filtered pageview once within a project and reporting period.
CREATE TABLE IF NOT EXISTS filtered_pageviews (
  project TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  PRIMARY KEY (project, event_hash)
);
CREATE INDEX IF NOT EXISTS filtered_pageviews_by_project_time ON filtered_pageviews (project, ts_ms);
CREATE INDEX IF NOT EXISTS filtered_pageviews_by_time ON filtered_pageviews (ts_ms);

CREATE TABLE IF NOT EXISTS traffic_collection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO traffic_collection (id, started_ms) VALUES (1, unixepoch() * 1000);
