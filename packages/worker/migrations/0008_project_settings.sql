-- Per-project settings (time zone, internal-traffic filters, currency, revenue events,
-- error tracking options), as JSON. See packages/core/src/settings.ts.
ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
