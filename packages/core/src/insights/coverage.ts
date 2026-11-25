import { resolveRange } from '../time.ts';
import type { QueryContext } from './types.ts';

export interface FunnelStep {
  project: string;
  event: string;
  name: string;
}

export interface Definition {
  project: string;
  event: string;
  role: string;
  description: string;
}

const probes = new Set(['journey_verified', 'deployment_verified']);

function classify(event: string, role: string) {
  if (probes.has(event)) return 'Operational probe';
  if (event.startsWith('$')) return 'System event';
  if (role === 'important' || role === 'conversion') return 'Marked action';
  return 'Custom event without a role';
}

function observedStatus(active: { kind: string }[]) {
  const kinds = new Set(active.map((e) => e.kind));
  if (kinds.has('Marked action')) return 'Marked action observed';
  if (kinds.has('Custom event without a role')) return 'Custom events to review';
  if (kinds.has('Operational probe')) return 'Operational probes only among custom events';
  return active.length ? 'System events only' : 'No observed traffic';
}

export async function runCoverage(
  spec: { from?: string | number; to?: string | number },
  projects: string[],
  definitions: Definition[],
  ctx: Omit<QueryContext, 'project'>,
  steps: FunnelStep[] = [],
) {
  const range = resolveRange(spec.from ?? '-30d', spec.to, ctx.now);
  const d = ctx.dialect;
  const sql = `SELECT project, event, COUNT(*) AS n FROM ${d.table('events')}
    WHERE project IN (${projects.map((p) => d.str(p)).join(', ')})
    AND ts_ms >= ${d.num(range.from)} AND ts_ms < ${d.num(range.to)}
    GROUP BY project, event ORDER BY project, event`;
  const rows = projects.length ? await ctx.execute(sql) : [];
  return projects.map((project) => {
    const observed = new Map(
      rows.filter((r) => r.project === project).map((r) => [String(r.event), Number(r.n)]),
    );
    const config = new Map(
      definitions.filter((r) => r.project === project).map((r) => [r.event, r]),
    );
    const journey = steps.filter((step) => step.project === project);
    const events = [
      ...new Set([...observed.keys(), ...config.keys(), ...journey.map((step) => step.event)]),
    ]
      .sort()
      .map((event) => {
        const definition = config.get(event);
        const role = definition?.role ?? '';
        return {
          event,
          funnels: journey.filter((step) => step.event === event).map((step) => step.name),
          count: observed.get(event) ?? 0,
          role,
          description: definition?.description ?? '',
          kind: classify(event, role),
        };
      });
    const active = events.filter((e) => e.count > 0);
    return {
      project,
      events,
      status: observedStatus(active),
      configured: events.filter((e) => e.kind === 'Marked action').length,
    };
  });
}

export function coverageTotals(projects: Awaited<ReturnType<typeof runCoverage>>) {
  const active = projects.filter((p) => p.events.some((e) => e.count > 0));
  const custom = active.filter((p) =>
    p.events.some((e) => e.count > 0 && e.kind !== 'System event'),
  );
  return {
    registered: projects.length,
    active: active.length,
    custom: custom.length,
    systemOnly: active.length - custom.length,
    quiet: projects.length - active.length,
  };
}
