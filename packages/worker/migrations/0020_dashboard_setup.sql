-- A completed setup survives dashboard edits and deletion. Adopt existing starter boards.
CREATE TABLE IF NOT EXISTS dashboard_setup (
  project TEXT PRIMARY KEY
);
INSERT OR IGNORE INTO dashboard_setup (project)
SELECT DISTINCT project FROM dashboards WHERE name = 'Website overview';
