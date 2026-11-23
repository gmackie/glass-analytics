/**
 * An inline table of literal rows, portable across dialects.
 *
 * SQLite accepts `(VALUES (1, 2), (3, 4))`, but Basin SQL rejects any VALUES
 * clause ("unsupported feature: VALUES clause is not supported"), which broke
 * every funnel, path, rolling-window trend and revenue query on the lake
 * (DATFLR-24). A UNION ALL of literal SELECTs works on both. Columns are named
 * `column1`, `column2`, … to match what VALUES produces, so callers can keep
 * reading `v.column1`.
 *
 * Basin also refuses a query that reads no table at all; every caller joins
 * this against the events CTE, so that never applies here.
 *
 * Each cell must already be safe SQL (a number from `d.num()`, or an integer
 * the compiler produced); nothing here quotes or escapes.
 */
export function literalRows(rows: readonly (readonly (string | number)[])[]): string {
  if (rows.length === 0) throw new Error('literalRows needs at least one row');
  const width = rows[0]!.length;
  if (width === 0 || rows.some((row) => row.length !== width)) {
    throw new Error('literalRows needs rows of one non-zero width');
  }
  return rows
    .map((row) => `SELECT ${row.map((cell, i) => `${cell} AS column${i + 1}`).join(', ')}`)
    .join(' UNION ALL ');
}
