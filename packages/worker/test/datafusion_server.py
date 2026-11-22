"""A stand-in for Basin SQL in tests: DataFusion, the engine Basin SQL runs, over in-memory tables.

The lake conformance test (lake-conformance.test.ts) starts this once and talks JSON lines on
stdin/stdout:

  {"op": "schema", "table": "events", "fields": [{"name": "ts_ms", "type": "int64"}, ...]}
  {"op": "write", "table": "events", "rows": [{...}, ...]}     -> {"ok": true}
  {"op": "query", "sql": "SELECT ..."}                         -> Basin SQL's response body

Basin SQL adds JSON functions from datafusion-functions-json (json_as_text, json_get_float,
json_get_bool, json_contains), which take a path of keys: json_as_text(props, '$groups',
'company'). Plain DataFusion lacks them, so they are defined here for paths of one to four
keys. A Python UDF has a fixed arity, so each arity gets its own function and queries are
rewritten to call the one matching their path length.
"""

import json
import re
import sys
from datetime import datetime

import pyarrow as pa
from datafusion import SessionContext, udf

TYPES = {"string": pa.string(), "int64": pa.int64(), "float64": pa.float64(), "bool": pa.bool_()}


def arrow_type(name):
    return pa.timestamp("us", tz="UTC") if name == "timestamp" else TYPES[name]


MISSING = object()


def lookup(doc, keys):
    if doc is None:
        return MISSING
    try:
        value = json.loads(doc)
    except ValueError:
        return MISSING
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            return MISSING
        value = value[key]
    return value


def as_text(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"))


def as_float(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def as_bool(value):
    return value if isinstance(value, bool) else None


def json_udf(name, convert, out_type, arity, exists=False):
    def fn(docs, *keys):
        docs = docs.to_pylist()
        paths = list(zip(*[k.to_pylist() for k in keys]))
        out = []
        for doc, path in zip(docs, paths):
            value = lookup(doc, path)
            if exists:
                out.append(value is not MISSING)
            else:
                out.append(None if value is MISSING else convert(value))
        return pa.array(out, out_type)

    return udf(fn, [pa.string()] * (arity + 1), out_type, "immutable", name=name if arity == 1 else f"{name}__{arity}")


JSON_FUNCTIONS = {
    "json_as_text": (as_text, pa.string(), False),
    "json_get_float": (as_float, pa.float64(), False),
    "json_get_bool": (as_bool, pa.bool_(), False),
    "json_contains": (None, pa.bool_(), True),
}
MAX_PATH = 4

ctx = SessionContext()
for fname, (convert, out_type, exists) in JSON_FUNCTIONS.items():
    for arity in range(1, MAX_PATH + 1):
        ctx.register_udf(json_udf(fname, convert, out_type, arity, exists))

# json_x(<column>, '<k1>', '<k2>'...) with a plain column and string-literal keys, as the
# compilers write them; calls with longer paths go to the matching json_x__N.
CALL = re.compile(r"\b(json_as_text|json_get_float|json_get_bool|json_contains)\(([\w.]+)((?:\s*,\s*'(?:[^']|'')*')+)\s*\)")
KEY = re.compile(r"'(?:[^']|'')*'")


def by_arity(sql):
    def swap(m):
        keys = KEY.findall(m.group(3))
        name = m.group(1) if len(keys) == 1 else f"{m.group(1)}__{len(keys)}"
        return f"{name}({m.group(2)}, {', '.join(keys)})"

    return CALL.sub(swap, sql)
ctx.sql("CREATE SCHEMA IF NOT EXISTS glass").collect()

schemas, rows = {}, {}


def register(table):
    schema = schemas[table]
    data = rows.get(table, [])
    columns = {}
    for field in schema:
        values = [r.get(field.name) for r in data]
        if pa.types.is_timestamp(field.type):
            values = [datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None for v in values]
        columns[field.name] = pa.array(values, field.type)
    name = f"glass.{table}"
    ctx.deregister_table(name)
    ctx.register_record_batches(name, [[pa.RecordBatch.from_pydict(columns, schema=schema)]])


def plain(value):
    if isinstance(value, float) and value.is_integer():
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def main():
    for line in sys.stdin:
        msg = json.loads(line)
        try:
            if msg["op"] == "schema":
                schemas[msg["table"]] = pa.schema([pa.field(f["name"], arrow_type(f["type"])) for f in msg["fields"]])
                register(msg["table"])
                reply = {"ok": True}
            elif msg["op"] == "write":
                rows.setdefault(msg["table"], []).extend(msg["rows"])
                register(msg["table"])
                reply = {"ok": True}
            else:
                table = ctx.sql(by_arity(msg["sql"])).to_arrow_table()
                reply = {
                    "result": {
                        "schema": [{"name": n} for n in table.column_names],
                        "rows": [{k: plain(v) for k, v in r.items()} for r in table.to_pylist()],
                    },
                    "success": True,
                    "errors": [],
                }
        except Exception as err:  # reported to the test as a Basin SQL error
            reply = {"success": False, "errors": [{"message": f"{type(err).__name__}: {err}"}]}
        print(json.dumps(reply, default=str), flush=True)


if __name__ == "__main__":
    main()
