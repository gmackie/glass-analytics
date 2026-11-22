-- Group analytics: accounts, companies, workspaces… Events carry their groups in
-- props.$groups ({ "company": "acme" }) and a snapshot of each group's properties in
-- props.$group_props, so both stores can filter, break down and aggregate by group.

-- Group types in use, at most five per project (as in PostHog). idx is the order they appeared.
CREATE TABLE IF NOT EXISTS group_types (
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name_singular TEXT NOT NULL DEFAULT '',
  name_plural TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project, type)
);
CREATE UNIQUE INDEX IF NOT EXISTS group_types_by_idx ON group_types (project, idx);

-- One row per group, with its current properties ($groupidentify / glass.group(type, key, props)).
CREATE TABLE IF NOT EXISTS groups (
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (project, type, key)
);
CREATE INDEX IF NOT EXISTS groups_by_last_seen ON groups (project, type, last_seen);
