import { sha256Hex } from '../hash.ts';
import { filtersSql } from '../sql/filters.ts';
import { eventsCte } from '../sql/source.ts';
import { DAY_MS, iso, resolveRange } from '../time.ts';
import { type JourneysSpec, journeysSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase } from './types.ts';

export const JOURNEY_ROW_LIMIT = 50_000;
export interface JourneyNode {
  id: string;
  step: number;
  label: string;
  count: number;
  kind: 'event' | 'other' | 'termination';
}
export interface JourneyEdge {
  source: string;
  target: string;
  count: number;
}
export type JourneyTermination =
  | 'observed_end'
  | 'observed_start'
  | 'observation_pending'
  | 'step_limit'
  | 'duration_limit';
export interface JourneysResult extends ResultBase {
  kind: 'journeys';
  version: 1;
  specDigest: string;
  unit: 'session';
  direction: 'forward' | 'backward';
  sessions: number;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  terminations: Record<JourneyTermination, number>;
  observation: {
    asOf: string;
    contextFrom: string;
    contextTo: string;
    maxDurationMs: number;
    freshnessSeconds: number;
    completeness: 'bounded';
    missingSessionEvents: number;
  };
  limits: {
    maxSteps: number;
    maxLabels: number;
    candidateRows: number;
    rowLimit: number;
    pruned: boolean;
  };
  nonCausal: true;
}
interface Candidate {
  id: string;
  ts: number;
  person: string;
  session: string;
  label: string;
  cohort: boolean;
  anchor: boolean;
  visible: boolean;
}
const TERMINAL_LABELS: Record<JourneyTermination, string> = {
  observed_end: 'Observed end',
  observed_start: 'Observed start',
  observation_pending: 'Observation pending',
  step_limit: 'Step limit',
  duration_limit: 'Duration limit',
};

export async function runJourneys(input: JourneysSpec, ctx: QueryContext): Promise<JourneysResult> {
  const spec = journeysSpec.parse(input);
  const now = ctx.now ?? Date.now();
  const range = resolveRange(spec.from ?? '-7d', spec.to, now);
  if (range.to - range.from > 7 * DAY_MS)
    throw new RangeError('Journey anchor range exceeds 7 days. Narrow from/to.');
  const durationValue = spec.maxDuration ?? '1h';
  const duration =
    Number.parseInt(durationValue, 10) * (durationValue.endsWith('h') ? 3_600_000 : 60_000);
  if (duration > DAY_MS)
    throw new RangeError('Journey duration exceeds 24 hours. Lower maxDuration.');
  const direction = spec.direction ?? 'forward';
  const maxSteps = spec.maxSteps ?? 6;
  const maxLabels = spec.maxLabels ?? 8;
  // Freshness is a conservative observation cutoff, not a guarantee of complete source delivery.
  const freshness = ctx.freshnessSeconds ?? 0;
  const asOf = Math.min(now - freshness * 1000, now);
  const contextFrom = range.from - duration;
  const contextTo = Math.min(range.to + duration, asOf);
  const d = ctx.dialect;
  const anchor = spec.anchor;
  const anchorCondition = anchor
    ? `event = ${d.str(anchor.event)} AND ${filtersSql(anchor.filters, d)}`
    : '1=1';
  const visible =
    spec.node === 'page'
      ? "event = '$pageview'"
      : spec.events?.length
        ? `event IN (${spec.events.map((e) => d.str(e)).join(', ')})`
        : "event NOT IN ('$identify', '$set', '$exposure', '$web_vitals', '$pageleave')";
  const cohortCte = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    to: Math.min(range.to, asOf),
    filters: spec.filters,
  }).replace(/^ev AS/, 'cohort_ev AS');
  const sql = `WITH ${cohortCte}, ${eventsCte(d, { project: ctx.project, from: contextFrom, to: Math.max(contextFrom, contextTo) })}
SELECT id, ts_ms, pid, session_id, ${spec.node === 'page' ? 'path' : 'event'} AS label,
  CASE WHEN cohort_id IS NOT NULL THEN 1 ELSE 0 END AS cohort_match,
  CASE WHEN ${anchorCondition} THEN 1 ELSE 0 END AS anchor_match,
  CASE WHEN ${visible} THEN 1 ELSE 0 END AS visible_match
FROM ev LEFT JOIN (SELECT DISTINCT id AS cohort_id FROM cohort_ev) cohort ON ev.id = cohort.cohort_id
WHERE COALESCE(${d.jsonText('props', ['$event_class'])}, 'product') = 'product'
ORDER BY ts_ms, id
LIMIT ${d.num(JOURNEY_ROW_LIMIT + 1)}`;
  const rows = await ctx.execute(sql);
  if (rows.length > JOURNEY_ROW_LIMIT)
    throw new RangeError(
      'Journey candidate limit exceeded (50,000 rows). Narrow the date range or use a smaller maxDuration; no partial graph was returned.',
    );
  const seen = new Map<string, string>();
  const sessions = new Map<string, Candidate[]>();
  let missingSessionEvents = 0;
  for (const row of rows) {
    const event: Candidate = {
      id: String(row.id),
      ts: Number(row.ts_ms),
      person: String(row.pid ?? ''),
      session: String(row.session_id ?? ''),
      label: String(row.label ?? ''),
      cohort: Number(row.cohort_match) === 1,
      anchor: Number(row.anchor_match) === 1,
      visible: Number(row.visible_match) === 1,
    };
    const signature = JSON.stringify(event);
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== signature)
        throw new RangeError(
          'Conflicting journey event ids. Repair duplicate source records before querying.',
        );
      continue;
    }
    seen.set(event.id, signature);
    if (!event.session || !event.person) {
      missingSessionEvents++;
      continue;
    }
    const key = JSON.stringify([event.person, event.session]);
    const list = sessions.get(key) ?? [];
    list.push(event);
    sessions.set(key, list);
  }
  const paths: { labels: string[]; termination: JourneyTermination }[] = [];
  const terminations: JourneysResult['terminations'] = {
    observed_end: 0,
    observed_start: 0,
    observation_pending: 0,
    step_limit: 0,
    duration_limit: 0,
  };
  for (const events of sessions.values()) {
    const inRange = (e: Candidate) => e.ts >= range.from && e.ts < range.to;
    if (!events.some((e) => inRange(e) && e.cohort)) continue;
    // SQL total order is also used when timestamps tie. It is not causal evidence.
    const pivot = events.findIndex((e) => inRange(e) && e.anchor && (anchor || e.visible));
    if (pivot < 0) continue;
    const start = events[pivot]!;
    const directional =
      direction === 'forward' ? events.slice(pivot) : events.slice(0, pivot + 1).reverse();
    const window = directional.filter((e) => Math.abs(e.ts - start.ts) <= duration);
    const labels: string[] = [];
    for (const event of window) {
      if (!event.visible) continue;
      const label = event.label || '(no page)';
      if (spec.collapseConsecutive && labels.at(-1) === label) continue;
      labels.push(label);
    }
    if (!labels.length) continue;
    const termination: JourneyTermination =
      labels.length > maxSteps
        ? 'step_limit'
        : direction === 'forward' && start.ts + duration > asOf
          ? 'observation_pending'
          : directional.length > window.length
            ? 'duration_limit'
            : direction === 'backward'
              ? 'observed_start'
              : 'observed_end';
    paths.push({ labels: labels.slice(0, maxSteps), termination });
    terminations[termination]++;
  }
  const ranks = Array.from({ length: maxSteps }, () => new Map<string, number>());
  for (const path of paths)
    path.labels.forEach((label, i) => {
      ranks[i]!.set(label, (ranks[i]!.get(label) ?? 0) + 1);
    });
  const keep = ranks.map(
    (rank) =>
      new Set(
        [...rank]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .slice(0, maxLabels)
          .map(([label]) => label),
      ),
  );
  const nodes = new Map<string, JourneyNode>();
  const edges = new Map<string, JourneyEdge>();
  let pruned = false;
  for (const path of paths) {
    const steps: Omit<JourneyNode, 'count'>[] = path.labels.map((label, step) => {
      const other = !keep[step]!.has(label);
      if (other) pruned = true;
      return {
        id: JSON.stringify([step, other ? 'other' : 'event', other ? '' : label]),
        step,
        label: other ? 'Other' : label,
        kind: other ? ('other' as const) : ('event' as const),
      };
    });
    steps.push({
      id: JSON.stringify([steps.length, 'termination', path.termination]),
      step: steps.length,
      label: TERMINAL_LABELS[path.termination],
      kind: 'termination',
    });
    steps.forEach((node, i) => {
      const existing = nodes.get(node.id);
      nodes.set(node.id, { ...node, count: (existing?.count ?? 0) + 1 });
      if (i > 0) {
        const source = steps[i - 1]!.id;
        const key = JSON.stringify([source, node.id]);
        edges.set(key, { source, target: node.id, count: (edges.get(key)?.count ?? 0) + 1 });
      }
    });
  }
  return {
    kind: 'journeys',
    version: 1,
    unit: 'session',
    direction,
    sessions: paths.length,
    specDigest: await sha256Hex(JSON.stringify({ version: 1, project: ctx.project, ...spec })),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    terminations,
    range: { from: iso(range.from), to: iso(range.to) },
    sql: [sql],
    observation: {
      asOf: iso(asOf),
      contextFrom: iso(contextFrom),
      contextTo: iso(contextTo),
      maxDurationMs: duration,
      freshnessSeconds: freshness,
      completeness: 'bounded',
      missingSessionEvents,
    },
    limits: {
      maxSteps,
      maxLabels,
      candidateRows: rows.length,
      rowLimit: JOURNEY_ROW_LIMIT,
      pruned,
    },
    nonCausal: true,
    summary: `${fmt(paths.length)} session journeys, ${direction === 'backward' ? 'moving backward from the first matching anchor' : 'moving forward from the first matching anchor'}. ${fmt(terminations.observation_pending)} still have incomplete observation. Observed ends are not proof of abandonment; paths show association, not causation.`,
  };
}
