/**
 * What this Dataflare deployment adds to the Cloudflare bill: usage over the last
 * 7 days (from Dataflare's own data), projected to a month, priced against the
 * Workers Paid plan, plus recommendations for cutting it.
 *
 * These are estimates. Dataflare doesn't see Cloudflare's billing; it counts what
 * it stored and infers the requests and writes that took. Allowances on the
 * Workers Paid plan are shared by every Worker in the account, so "overage"
 * here means "if Dataflare were the only thing using them".
 *
 * Prices: developers.cloudflare.com/{workers,d1,r2}/platform/pricing, checked
 * November 2026.
 */

export const PRICES = {
  checked: '2026-11',
  plan: { name: 'Workers Paid', monthly: 5 },
  workers: {
    includedRequests: 10e6,
    perMillionRequests: 0.3,
    includedCpuMs: 30e6,
    perMillionCpuMs: 0.02,
    freeRequestsPerDay: 100_000,
  },
  /** Workers Free daily limits and the per-database cap (developers.cloudflare.com/d1/platform/limits). */
  free: {
    requestsPerDay: 100_000,
    d1RowsReadPerDay: 5_000_000,
    d1RowsWrittenPerDay: 100_000,
    d1MaxDatabaseGb: 0.5,
  },
  d1: {
    includedRowsRead: 25e9,
    perMillionRowsRead: 0.001,
    includedRowsWritten: 50e6,
    perMillionRowsWritten: 1,
    includedStorageGb: 5,
    perGbMonth: 0.75,
    /** Largest a single D1 database can grow on Workers Paid. */
    maxDatabaseGb: 10,
  },
  /** developers.cloudflare.com/queues/platform/pricing: a message is a write, a read and a delete. */
  queues: {
    includedOperations: 1e6,
    perMillionOperations: 0.4,
    operationsPerMessage: 3,
    freeOperationsPerDay: 10_000,
  },
  r2: {
    includedStorageGb: 10,
    perGbMonth: 0.015,
    includedClassA: 1e6,
    perMillionClassA: 4.5,
    includedClassB: 10e6,
    perMillionClassB: 0.36,
  },
} as const;

/** Rows a D1 event insert writes: the row plus one per index on `events` (time, name, person, session). */
const EVENT_ROW_WRITES = 5;
/** A replay chunk upserts its index row, which has three indexes. */
const REPLAY_ROW_WRITES = 4;
/** Assumed CPU per request; ingest and script requests are light. */
const CPU_MS_PER_REQUEST = 1.5;
/** Queries behind one Reports load, each scanning the range's events once or so. */
const QUERIES_PER_REPORT = 12;
const GB = 1024 ** 3;

export interface UsageInputs {
  days: number;
  store: 'd1' | 'lake';
  /** Per project, over `days`. */
  projects: {
    project: string;
    events: number;
    pageviews: number;
    sessions: number;
    replaySessions: number;
    replayChunks: number;
    replayBytes: number;
  }[];
  /** Largest events by volume over `days`, all projects. */
  topEvents: { event: string; count: number }[];
  /** Totals currently stored. */
  stored: { events: number; replayBytes: number; d1Bytes: number | null };
  retentionDays: number | null;
  replayRetentionDays: number;
  /** Destination deliveries over `days` (delivered, failed and skipped), and whether a queue carries them. */
  deliveries?: { messages: number; queue: boolean };
}

export interface Line {
  resource: string;
  unit: string;
  monthly: number;
  included: number;
  /** Share of the plan's allowance this would use. */
  share: number;
  overageUsd: number;
  basis: string;
}

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  /** Rough monthly saving or headroom, in words. */
  impact: string;
  /** A prompt for a coding agent working in the project that runs Dataflare. */
  prompt: string;
}

export interface UsageReport {
  window: { days: number };
  monthly: {
    events: number;
    pageviews: number;
    sessions: number;
    replaySessions: number;
    requests: number;
    rowsWritten: number;
    replayGb: number;
  };
  lines: Line[];
  /** Dataflare's own projected cost beyond the plan's allowances. */
  overageUsd: number;
  /** Rows one Reports load reads, and how many loads the allowance covers. */
  reads: { perReportLoad: number; loadsIncluded: number };
  projects: (UsageInputs['projects'][number] & { monthlyEvents: number; share: number })[];
  recommendations: Recommendation[];
  prices: typeof PRICES;
  summary: string;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const money = (n: number) => (n < 0.01 ? '$0.00' : `$${n.toFixed(2)}`);
const millions = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(0)}k`
      : String(Math.round(n));

function line(
  resource: string,
  unit: string,
  monthly: number,
  included: number,
  perMillion: number,
  basis: string,
  scale = 1e6,
): Line {
  const over = Math.max(0, monthly - included);
  return {
    resource,
    unit,
    monthly: round(monthly),
    included,
    share: included ? monthly / included : 0,
    overageUsd: round((over / scale) * perMillion, 4),
    basis,
  };
}

export function estimateUsage(input: UsageInputs): UsageReport {
  const scale = 30 / Math.max(1, input.days);
  const sum = (k: keyof UsageInputs['projects'][number]) =>
    input.projects.reduce((n, p) => n + (p[k] as number), 0);
  const events = sum('events') * scale;
  const pageviews = sum('pageviews') * scale;
  const sessions = sum('sessions') * scale;
  const replaySessions = sum('replaySessions') * scale;
  const replayChunks = sum('replayChunks') * scale;
  const replayBytesMonth = sum('replayBytes') * scale;

  // Requests: the SDK script, its flag fetch and its event batches per pageview (a batch carries ~4 events),
  // plus one per replay chunk and a replay.js load per recorded session.
  const requests = pageviews * 2 + Math.max(pageviews, events / 4) + replayChunks + replaySessions;
  const rowsWritten =
    (input.store === 'd1' ? events * EVENT_ROW_WRITES : 0) + replayChunks * REPLAY_ROW_WRITES;
  const d1Gb =
    (input.stored.d1Bytes ?? (input.store === 'd1' ? input.stored.events * 450 : 0)) / GB;
  // Steady state: what's kept once retention deletes the oldest replays.
  const replayGb =
    Math.max(input.stored.replayBytes, (replayBytesMonth / 30) * input.replayRetentionDays) / GB;
  const p = PRICES;
  const lines: Line[] = [
    line(
      'Worker requests',
      'requests',
      requests,
      p.workers.includedRequests,
      p.workers.perMillionRequests,
      'Script, flags and event batches per pageview, plus replay uploads',
    ),
    line(
      'Worker CPU',
      'CPU ms',
      requests * CPU_MS_PER_REQUEST,
      p.workers.includedCpuMs,
      p.workers.perMillionCpuMs,
      `About ${CPU_MS_PER_REQUEST} ms per request`,
    ),
    line(
      'D1 rows written',
      'rows',
      rowsWritten,
      p.d1.includedRowsWritten,
      p.d1.perMillionRowsWritten,
      input.store === 'd1'
        ? `${EVENT_ROW_WRITES} per event (row + 4 indexes), ${REPLAY_ROW_WRITES} per replay chunk`
        : `${REPLAY_ROW_WRITES} per replay chunk (events go to the lake)`,
    ),
    line(
      'D1 storage',
      'GB',
      d1Gb,
      p.d1.includedStorageGb,
      p.d1.perGbMonth,
      input.stored.d1Bytes === null
        ? 'Estimated at ~450 bytes per stored event'
        : 'Database size reported by D1',
      1,
    ),
    line(
      'R2 replay storage',
      'GB',
      replayGb,
      p.r2.includedStorageGb,
      p.r2.perGbMonth,
      `Gzipped recordings, kept ${input.replayRetentionDays} days`,
      1,
    ),
    line(
      'R2 writes (Class A)',
      'operations',
      replayChunks * 1.05,
      p.r2.includedClassA,
      p.r2.perMillionClassA,
      'One per replay chunk, plus cached summaries',
    ),
  ];
  // Destinations: queue operations when a queue carries deliveries (the outbox uses D1 instead).
  const deliveries = (input.deliveries?.messages ?? 0) * scale;
  if (deliveries > 0 && input.deliveries?.queue) {
    lines.push(
      line(
        'Queue operations',
        'operations',
        deliveries * p.queues.operationsPerMessage,
        p.queues.includedOperations,
        p.queues.perMillionOperations,
        `${p.queues.operationsPerMessage} per destination delivery (write, read, delete), plus retries`,
      ),
    );
  }
  const overageUsd = round(lines.reduce((n, l) => n + l.overageUsd, 0));
  const storedEvents = input.store === 'd1' ? Math.max(input.stored.events, events) : events;
  const perReportLoad = Math.round(Math.min(storedEvents, events) * QUERIES_PER_REPORT);
  const totalEvents = sum('events') || 1;
  const projects = input.projects
    .map((pr) => ({
      ...pr,
      monthlyEvents: Math.round(pr.events * scale),
      share: pr.events / totalEvents,
    }))
    .sort((a, b) => b.events - a.events);

  const recommendations = recommend(input, {
    events,
    pageviews,
    sessions,
    replaySessions,
    replayChunks,
    replayGb,
    rowsWritten,
    requests,
    d1Gb,
  });
  const top = lines.slice().sort((a, b) => b.share - a.share)[0]!;
  return {
    window: { days: input.days },
    monthly: {
      events: Math.round(events),
      pageviews: Math.round(pageviews),
      sessions: Math.round(sessions),
      replaySessions: Math.round(replaySessions),
      requests: Math.round(requests),
      rowsWritten: Math.round(rowsWritten),
      replayGb: round(replayGb, 3),
    },
    lines,
    overageUsd,
    reads: {
      perReportLoad,
      loadsIncluded: perReportLoad ? Math.floor(p.d1.includedRowsRead / perReportLoad) : 0,
    },
    projects,
    recommendations,
    prices: PRICES,
    summary:
      `Projected from the last ${input.days} days: ${millions(events)} events, ${millions(requests)} Worker requests and ${round(replayGb, 2)} GB of replays a month. ` +
      (overageUsd > 0
        ? `About ${money(overageUsd)}/month beyond the ${p.plan.name} allowances (plus the $${p.plan.monthly} plan).`
        : `Within the ${p.plan.name} allowances: $0 beyond the $${p.plan.monthly}/month plan. The largest share is ${top.resource} at ${Math.round(top.share * 100)}% of its allowance.`) +
      (recommendations.length
        ? ` ${recommendations.length} recommendation${recommendations.length === 1 ? '' : 's'}.`
        : ''),
  };
}

function recommend(
  input: UsageInputs,
  m: {
    events: number;
    pageviews: number;
    sessions: number;
    replaySessions: number;
    replayChunks: number;
    replayGb: number;
    rowsWritten: number;
    requests: number;
    d1Gb: number;
  },
): Recommendation[] {
  const out: Recommendation[] = [];
  const p = PRICES;
  const replayShare = m.sessions ? m.replaySessions / m.sessions : 0;
  if (m.replayGb > p.r2.includedStorageGb * 0.5 || (replayShare > 0.5 && m.replaySessions > 3000)) {
    out.push({
      id: 'replay-sampling',
      title: 'Record fewer sessions',
      detail: `About ${Math.round(replayShare * 100)}% of sessions are recorded, about ${round(m.replayGb, 1)} GB kept. Recording 10% of sessions plus every session that hits an error usually keeps what you need to debug.`,
      impact: `About ${Math.round((1 - 0.1 / Math.max(replayShare, 0.1)) * 100)}% less replay storage and uploads`,
      prompt:
        'In the Dataflare snippet for this site, set the replay sample rate to 0.1 and the on-error sample rate to 1 (data-replay-sample-rate="0.1" data-replay-on-error-sample-rate="1", or replay: { sampleRate: 0.1, onErrorSampleRate: 1 } in glass.init). Deploy, then check the replays list still shows sessions with errors.',
    });
  }
  if (
    input.store === 'd1' &&
    (m.d1Gb > p.d1.includedStorageGb * 0.6 || m.rowsWritten > p.d1.includedRowsWritten * 0.6)
  ) {
    out.push({
      id: 'lake',
      title: 'Move events to the data lake',
      detail: `D1 is projected at ${round(m.d1Gb, 1)} GB and ${millions(m.rowsWritten)} rows written a month. The lake store keeps events as Iceberg tables on R2 (about $0.015/GB-month) and takes event writes out of D1.`,
      impact: 'D1 writes and storage drop to the replay index and settings',
      prompt:
        'Switch this Dataflare deployment to the lake store: run `npx dataflare-cli@latest init --lake` in the project with .glass/, commit .glass/ and push so the Dataflare workflow deploys it. Then confirm events arrive with `npx dataflare-cli status` and that the dashboard Reports load.',
    });
  }
  if (input.store === 'd1' && input.retentionDays === null && (m.d1Gb > 1 || m.events > 5e6)) {
    out.push({
      id: 'retention',
      title: 'Expire old events',
      detail:
        'Events are kept forever. Keeping 13 months covers year-on-year comparisons and stops D1 growing without bound.',
      impact: 'D1 storage stops growing after 13 months',
      prompt:
        'Set event retention for this Dataflare deployment to 400 days: run `npx dataflare-cli@latest upgrade --retention-days 400`, commit .glass/ and push so the Dataflare workflow deploys it.',
    });
  }
  const total = input.topEvents.reduce((n, e) => n + e.count, 0) || 1;
  for (const e of input.topEvents.slice(0, 3)) {
    const share = e.count / total;
    if (share < 0.35 || e.event === '$pageview' || m.events < 300_000) continue;
    const what =
      e.event === '$click'
        ? 'Autocaptured clicks'
        : e.event === '$web_vitals'
          ? 'Web vitals'
          : `"${e.event}"`;
    out.push({
      id: `noisy-${e.event}`,
      title: `${what} are ${Math.round(share * 100)}% of all events`,
      detail:
        'One event dominating volume usually means something fires on every scroll, render or timer. Sampling it or sending it less often cuts writes and storage in proportion.',
      impact: `Up to ${Math.round(share * 100)}% fewer event writes`,
      prompt:
        e.event === '$click'
          ? 'Dataflare autocaptures every click. Check whether we use $click in any analysis (list_events, describe_event). If not, turn click autocapture off in the Dataflare snippet (autocapture: { clicks: false }) and track the few clicks that matter as named events instead.'
          : `The Dataflare event "${e.event}" is ${Math.round(share * 100)}% of all events. Find where it is captured, explain why it fires so often, and make it fire once per meaningful action (debounce, dedupe or sample it). Keep what our saved analyses need (check list_insights).`,
    });
  }
  if (m.requests / 30 > p.workers.freeRequestsPerDay * 0.6) {
    out.push({
      id: 'free-plan',
      title: 'Above the Workers Free daily limit',
      detail: `About ${millions(m.requests / 30)} requests a day. The free plan stops at ${millions(p.workers.freeRequestsPerDay)} a day, so this needs Workers Paid ($5/month), which includes 10M a month.`,
      impact: 'Avoids dropped events on busy days',
      prompt:
        'Check whether the Cloudflare account running Dataflare is on Workers Paid. If it is on the free plan, tell me before traffic grows past 100,000 requests a day.',
    });
  }
  return out;
}
