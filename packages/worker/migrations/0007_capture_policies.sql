-- Explicit per-project collection policy and event catalog. No policy preserves legacy behavior.
CREATE TABLE IF NOT EXISTS capture_policies (
  project TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  policy TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
