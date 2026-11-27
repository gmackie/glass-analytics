-- Track each starter independently. A marker survives board edits and deletion.
CREATE TABLE IF NOT EXISTS dashboard_template_setup (
  project TEXT NOT NULL,
  template TEXT NOT NULL,
  PRIMARY KEY (project, template)
);

INSERT OR IGNORE INTO dashboard_template_setup (project, template)
SELECT project, CASE name WHEN 'Acquisition' THEN 'acquisition' ELSE 'engagement' END
FROM dashboards WHERE name IN ('Acquisition', 'Engagement');
