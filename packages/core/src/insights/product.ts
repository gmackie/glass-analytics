import { bucketExpr, eventsCte, num } from '../sql/source.ts';
import type { TimeRange } from '../time.ts';
import { type QueryContext, zoneOf } from './types.ts';

export async function runProduct(
  range: TimeRange,
  definitions: readonly { event: string; role: string }[],
  ctx: QueryContext,
) {
  const marks = definitions.filter(({ event }) => !event.startsWith('$'));
  const zone = zoneOf({}, ctx, range);
  const events = ['$pageview', ...marks.map(({ event }) => event)];
  const source = eventsCte(ctx.dialect, { ...range, project: ctx.project, events });
  const day = bucketExpr(ctx.dialect, 'ts_ms', 'day', zone);
  const sql = `WITH ${source}, uses AS (
    SELECT event, pid, COUNT(*) AS volume, MIN(${day}) AS first_day, MAX(${day}) AS last_day
    FROM ev WHERE event IN (${events.map((e) => ctx.dialect.str(e)).join(', ')}) GROUP BY event, pid
  )
  SELECT NULL AS event, COUNT(DISTINCT pid) AS adopters, 0 AS volume, 0 AS repeaters FROM uses
  UNION ALL
  SELECT event, COUNT(*) AS adopters, SUM(volume) AS volume,
    SUM(CASE WHEN first_day <> last_day THEN 1 ELSE 0 END) AS repeaters
  FROM uses GROUP BY event`;
  const rows = await ctx.execute(sql);
  const byEvent = new Map(rows.map((row) => [row.event, row]));
  const audience = num(byEvent.get(null)?.adopters);
  const actions = marks
    .map(({ event, role }) => {
      const row = byEvent.get(event);
      const adopters = num(row?.adopters);
      const repeaters = num(row?.repeaters);
      return {
        event,
        role,
        volume: num(row?.volume),
        adopters,
        repeaters,
        adoptionShare: audience ? adopters / audience : null,
        repeatShare: adopters ? repeaters / adopters : null,
      };
    })
    .sort((a, b) => b.adopters - a.adopters || a.event.localeCompare(b.event));
  return { project: ctx.project, range, timezone: zone.name, audience, actions };
}
