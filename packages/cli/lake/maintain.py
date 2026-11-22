"""Lake maintenance: the deletes Basin SQL can't do.

Basin SQL is read-only, so Dataflare deletes lake rows with PyIceberg through the
catalog (Basin Catalog in production, a local SQL catalog in tests). `dataflare
lake maintain` runs this script and passes a JSON job on stdin:

  {
    "catalog": {"type": "rest", "uri": "...", "warehouse": "...", "token": "..."},
    "namespace": "glass",
    "tables": {"events": ["events", "events_v2"], "identities": ["identities"]},
    "deletions": [{"id": 1, "project": "acme", "ids": ["alice", "device-1"]}],
    "group_deletions": [{"id": 2, "project": "acme", "type": "company", "key": "acme-inc"}],
    "retention_cutoff_ms": 1790000000000   # or null: keep events forever
  }

It erases each queued person (events by person, device or user id, and their
identity links), removes each deleted group from its events (its key in
props.$groups and its snapshot in props.$group_props; the events stay), deletes
events older than the retention cutoff, and prints a JSON result on stdout. Deletes are copy-on-write commits: the rows disappear from
queries at once, and the old files go when Basin Catalog's snapshot expiration
(enabled by `dataflare init --lake`) drops the snapshots that still hold them.
"""

import json
import sys
import time
from collections import defaultdict

from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import CommitFailedException, NoSuchTableError
import pyarrow as pa
from pyiceberg.expressions import And, EqualTo, In, LessThan

ATTEMPTS = 6
# Rows rewritten per commit when removing a group.
REWRITE_CHUNK = 10_000


def log(message):
    print(message, file=sys.stderr, flush=True)


def delete(catalog, name, row_filter, label):
    """Delete matching rows, retrying when Pipelines commits to the table at the same time."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            table = catalog.load_table(name)
        except NoSuchTableError:
            log(f"{name}: no table yet, nothing to delete")
            return False
        try:
            table.delete(delete_filter=row_filter)
            log(f"{name}: deleted {label}")
            return True
        except CommitFailedException as err:
            if attempt == ATTEMPTS:
                raise
            wait = 2**attempt
            log(f"{name}: commit conflict ({err}); retrying in {wait}s")
            time.sleep(wait)
    return False


def without_group(props, gtype, key):
    """The props JSON with the group removed, or None when the event isn't in that group."""
    try:
        obj = json.loads(props or "{}")
    except ValueError:
        return None
    groups = obj.get("$groups")
    if not isinstance(groups, dict) or groups.get(gtype) != key:
        return None
    groups.pop(gtype, None)
    if not groups:
        obj.pop("$groups", None)
    snapshots = obj.get("$group_props")
    if isinstance(snapshots, dict):
        snapshots.pop(gtype, None)
        if not snapshots:
            obj.pop("$group_props", None)
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def remove_group(catalog, name, project, gtype, key):
    """Rewrite a project's events that carry the group, without it: delete and append in one commit."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            table = catalog.load_table(name)
        except NoSuchTableError:
            log(f"{name}: no table yet, nothing to rewrite")
            return 0
        rows = table.scan(row_filter=EqualTo("project", project)).to_arrow()
        if rows.num_rows == 0 or "props" not in rows.column_names:
            return 0
        rewritten = [without_group(p, gtype, key) for p in rows.column("props").to_pylist()]
        picked = [i for i, p in enumerate(rewritten) if p is not None]
        if not picked:
            log(f"{name}: no events of {gtype} {key} in {project}")
            return 0
        try:
            for start in range(0, len(picked), REWRITE_CHUNK):
                chunk = picked[start : start + REWRITE_CHUNK]
                changed = rows.take(pa.array(chunk))
                at = changed.schema.get_field_index("props")
                changed = changed.set_column(
                    at, changed.schema.field(at), pa.array([rewritten[i] for i in chunk], pa.string())
                )
                ids = changed.column("id").to_pylist()
                with table.transaction() as tx:
                    tx.delete(delete_filter=And(EqualTo("project", project), In("id", ids)))
                    tx.append(changed)
            log(f"{name}: removed {gtype} {key} from {len(picked)} events in {project}")
            return len(picked)
        except CommitFailedException as err:
            if attempt == ATTEMPTS:
                raise
            wait = 2**attempt
            log(f"{name}: commit conflict ({err}); retrying in {wait}s")
            time.sleep(wait)
    return 0


def main():
    job = json.load(sys.stdin)
    catalog = load_catalog("dataflare", **job["catalog"])
    ns = job.get("namespace") or "glass"
    # Every schema version's table (events, events_v2, ...): rows live in all of them.
    tables = job.get("tables") or {}
    events = [f"{ns}.{t}" for t in tables.get("events") or ["events"]]
    identities = [f"{ns}.{t}" for t in tables.get("identities") or ["identities"]]

    # Queued ids are merged per project, so a long queue still costs a few commits.
    by_project = defaultdict(set)
    for d in job.get("deletions") or []:
        by_project[d["project"]].update(d["ids"])
    for project, ids in sorted(by_project.items()):
        ids = sorted(ids)
        # One delete per column, never an OR across columns: PyIceberg's copy-on-write delete keeps
        # rows where the filter is NULL, and user_id is NULL on anonymous events, so
        # `distinct_id IN ids OR user_id IN ids` would leave a matching device's anonymous rows.
        for name in events:
            for column in ("distinct_id", "person_id", "user_id"):
                delete(
                    catalog,
                    name,
                    And(EqualTo("project", project), In(column, ids)),
                    f"events of {len(ids)} ids in {project} by {column}",
                )
        for name in identities:
            for column in ("distinct_id", "person_id"):
                delete(
                    catalog,
                    name,
                    And(EqualTo("project", project), In(column, ids)),
                    f"identity links of {len(ids)} ids in {project} by {column}",
                )

    for g in job.get("group_deletions") or []:
        for name in events:
            remove_group(catalog, name, g["project"], g["type"], g["key"])

    cutoff = job.get("retention_cutoff_ms")
    if cutoff:
        for name in events:
            delete(catalog, name, LessThan("ts_ms", int(cutoff)), f"events before {cutoff}")

    json.dump(
        {
            "deletions": [d["id"] for d in (job.get("deletions") or []) + (job.get("group_deletions") or [])],
            "retention_cutoff_ms": cutoff,
        },
        sys.stdout,
    )
    print()


if __name__ == "__main__":
    main()
