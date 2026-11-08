-- Student mode (see packages/core/src/student-policy.ts). A project without a row
-- here behaves as before. policy is the JSON StudentPolicy.
CREATE TABLE IF NOT EXISTS project_policies (
  project TEXT PRIMARY KEY,
  policy TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

-- Who read or changed a student-mode project's data, and how. One row per request and
-- project. actor is the Cloudflare Access email when the request carries one, else the
-- key scope; detail holds the SQL text or tool arguments (never query results).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  project TEXT NOT NULL,
  surface TEXT NOT NULL,
  scope TEXT NOT NULL,
  actor TEXT NOT NULL,
  operation TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS audit_log_by_project ON audit_log (project, ts);
