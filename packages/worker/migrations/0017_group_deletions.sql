-- Deleting a group: in lake mode its key and property snapshots are removed from stored events by
-- the lake maintenance job, queued here like person erasures. For kind 'group', ids is
-- ["<type>", "<key>"].
ALTER TABLE lake_deletions ADD COLUMN kind TEXT NOT NULL DEFAULT 'person';
