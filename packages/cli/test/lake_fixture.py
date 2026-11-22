"""Test fixture for the lake maintenance job: a local Iceberg catalog (SQLite + files).

  python lake_fixture.py seed <dir>   create glass.events / glass.identities, partitioned
                                      by day like the tables Pipelines creates, with rows
  python lake_fixture.py dump <dir>   print the remaining rows as JSON
"""

import json
import sys
from datetime import datetime, timezone

import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import DayTransform
from pyiceberg.types import LongType, NestedField, StringType, TimestamptzType

DAY = 86_400_000
NOW = 1_790_000_000_000


def catalog(root):
    return load_catalog(
        "dataflare", type="sql", uri=f"sqlite:///{root}/catalog.db", warehouse=f"file://{root}/warehouse"
    )


def seed(root):
    cat = catalog(root)
    cat.create_namespace("glass")
    events_schema = Schema(
        NestedField(1, "__ingest_ts", TimestamptzType(), required=False),
        NestedField(2, "project", StringType(), required=False),
        NestedField(3, "event", StringType(), required=False),
        NestedField(4, "ts_ms", LongType(), required=False),
        NestedField(5, "distinct_id", StringType(), required=False),
        NestedField(6, "user_id", StringType(), required=False),
        NestedField(7, "person_id", StringType(), required=False),
        NestedField(8, "id", StringType(), required=False),
        NestedField(9, "props", StringType(), required=False),
    )
    spec = PartitionSpec(PartitionField(1, 1000, DayTransform(), "__ingest_ts_day"))
    events = cat.create_table("glass.events", schema=events_schema, partition_spec=spec)
    rows = [
        # project, event, ts_ms, distinct_id, user_id, person_id
        ("acme", "$pageview", NOW - DAY, "dev-alice", None, "dev-alice"),
        ("acme", "signup", NOW - DAY, "dev-alice", "alice", "alice"),
        ("acme", "$pageview", NOW - DAY, "dev-bob", None, "dev-bob"),
        ("other", "$pageview", NOW - DAY, "dev-alice", None, "dev-alice"),  # same device, other project
        ("acme", "$pageview", NOW - 400 * DAY, "dev-bob", None, "dev-bob"),  # past retention
    ]
    events.append(
        pa.table(
            {
                "__ingest_ts": pa.array(
                    [datetime.fromtimestamp(r[2] / 1000, tz=timezone.utc) for r in rows], pa.timestamp("us", tz="UTC")
                ),
                "project": [r[0] for r in rows],
                "event": [r[1] for r in rows],
                "ts_ms": pa.array([r[2] for r in rows], pa.int64()),
                "distinct_id": [r[3] for r in rows],
                "user_id": [r[4] for r in rows],
                "person_id": [r[5] for r in rows],
                "id": [f"e{i}" for i in range(len(rows))],
                # Bob's recent pageview is in the "acme-inc" company (a group that gets deleted).
                "props": [
                    json.dumps({"$groups": {"company": "acme-inc"}, "$group_props": {"company": {"plan": "pro"}}, "x": 1})
                    if r[3] == "dev-bob" and r[2] == NOW - DAY
                    else "{}"
                    for r in rows
                ],
            }
        )
    )
    # A later schema version's table (see LAKE_SCHEMA_CHANGES): alice has a row here too.
    v2 = cat.create_table("glass.events_v2", schema=events_schema, partition_spec=spec)
    v2.append(
        pa.table(
            {
                "__ingest_ts": pa.array([datetime.fromtimestamp(NOW / 1000, tz=timezone.utc)] * 2, pa.timestamp("us", tz="UTC")),
                "project": ["acme", "acme"],
                "event": ["$pageview", "$pageview"],
                "ts_ms": pa.array([NOW, NOW], pa.int64()),
                "distinct_id": ["dev-alice", "dev-carol"],
                "user_id": pa.array([None, None], pa.string()),
                "person_id": ["dev-alice", "dev-carol"],
                "id": ["v2-0", "v2-1"],
                "props": ["{}", json.dumps({"$groups": {"company": "acme-inc", "team": "t1"}})],
            }
        )
    )
    identities_schema = Schema(
        NestedField(1, "project", StringType(), required=False),
        NestedField(2, "distinct_id", StringType(), required=False),
        NestedField(3, "person_id", StringType(), required=False),
        NestedField(4, "created_at", LongType(), required=False),
    )
    identities = cat.create_table("glass.identities", schema=identities_schema)
    identities.append(
        pa.table(
            {
                "project": ["acme", "acme"],
                "distinct_id": ["dev-alice", "dev-bob"],
                "person_id": ["alice", "bob"],
                "created_at": pa.array([NOW, NOW], pa.int64()),
            }
        )
    )


def dump(root):
    cat = catalog(root)
    out = {}
    for name in ("events", "events_v2", "identities"):
        out[name] = cat.load_table(f"glass.{name}").scan().to_arrow().drop_columns(
            [c for c in ("__ingest_ts",) if name.startswith("events")]
        ).to_pylist()
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    {"seed": seed, "dump": dump}[sys.argv[1]](sys.argv[2])
