-- Cohorts, version 2: behavioural conditions (in the definition JSON), static cohorts with
-- explicit members, and materialised membership of dynamic cohorts that flags target.

-- "dynamic" (members computed from the definition) or "static" (members listed in cohort_members).
ALTER TABLE cohorts ADD COLUMN kind TEXT NOT NULL DEFAULT 'dynamic';
ALTER TABLE cohorts ADD COLUMN description TEXT NOT NULL DEFAULT '';
-- When cohort_members last got this cohort's dynamic membership (for flag targeting).
ALTER TABLE cohorts ADD COLUMN refreshed_at INTEGER;

-- Members of static cohorts (source "static"), and the materialised members of dynamic cohorts
-- that feature flags target (source "dynamic", refreshed hourly).
CREATE TABLE IF NOT EXISTS cohort_members (
  project TEXT NOT NULL,
  cohort TEXT NOT NULL,
  person_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'static',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project, cohort, person_id)
);
CREATE INDEX IF NOT EXISTS cohort_members_by_person ON cohort_members (project, person_id);
