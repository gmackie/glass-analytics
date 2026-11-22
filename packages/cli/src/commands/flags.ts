/**
 * `dataflare flags` and `dataflare experiments`.
 */

import type { ExperimentResult } from '@dataflare/core/insights/experiment';
import { call, withProject } from '../client.ts';
import { UsageError } from '../config.ts';
import { color, line, pct, printJson, table } from '../output.ts';
import type { Flags } from './data.ts';

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const projectQuery = (flags: Flags) =>
  str(flags.project) ? `?project=${encodeURIComponent(str(flags.project)!)}` : '';

export async function flags(
  sub: string | undefined,
  key: string | undefined,
  flags: Flags,
): Promise<void> {
  if (!sub || sub === 'list') {
    const r = await call<{
      summary: string;
      flags: { key: string; enabled: boolean; rollout: number; variants?: { key: string }[] }[];
    }>('GET', `/api/flags${projectQuery(flags)}`);
    if (flags.json) return printJson(r);
    if (!r.flags.length)
      return line('No flags yet. Create one: dataflare flags set new-checkout --rollout 10');
    table(
      ['Flag', 'On', 'Rollout', 'Variants'],
      r.flags.map((f) => [
        f.key,
        f.enabled ? 'yes' : 'no',
        `${f.rollout}%`,
        (f.variants ?? []).map((v) => v.key).join(', '),
      ]),
    );
    return;
  }
  if (!key) throw new UsageError(`Pass a flag key: dataflare flags ${sub} <key>`);
  if (sub === 'delete') {
    const r = await call<{ summary: string }>(
      'DELETE',
      `/api/flags/${encodeURIComponent(key)}${projectQuery(flags)}`,
    );
    return flags.json ? printJson(r) : line(r.summary);
  }
  if (sub === 'set') {
    const body: Record<string, unknown> = { project: str(flags.project) };
    if (flags.rollout !== undefined) body.rollout = Number(flags.rollout);
    if (flags.enable) body.enabled = true;
    if (flags.disable) body.enabled = false;
    if (typeof flags.description === 'string') body.description = flags.description;
    if (typeof flags.variants === 'string') {
      body.variants = flags.variants.split(',').map((v) => {
        const [k, w] = v.split(':');
        return { key: k!.trim(), weight: Number(w ?? 1) };
      });
    }
    if (typeof flags.rules === 'string') body.rules = JSON.parse(flags.rules);
    const r = await call<{ summary: string }>(
      'PUT',
      `/api/flags/${encodeURIComponent(key)}`,
      withProject(body),
    );
    return flags.json ? printJson(r) : line(r.summary);
  }
  throw new UsageError(
    `Unknown subcommand "flags ${sub}".`,
    'Use: dataflare flags [list | set <key> | delete <key>]',
  );
}

/** What an experiment measures: its goal event, or (created with metrics) its first metric. */
function goalOf(e: {
  goal: { event: string } | null;
  metrics?: { event?: string; name?: string; kind: string }[];
}): string {
  const m = e.metrics?.[0];
  return e.goal?.event ?? m?.name ?? m?.event ?? m?.kind ?? '–';
}

export async function experiments(
  sub: string | undefined,
  key: string | undefined,
  rest: string[],
  flags: Flags,
): Promise<void> {
  if (!sub || sub === 'list') {
    const r = await call<{
      summary: string;
      experiments: {
        key: string;
        status: string;
        goal: { event: string } | null;
        metrics?: { event?: string; name?: string; kind: string }[];
      }[];
    }>('GET', `/api/experiments${projectQuery(flags)}`);
    if (flags.json) return printJson(r);
    if (!r.experiments.length)
      return line(
        'No experiments yet. Create one: dataflare experiments create pricing-v2 --goal signup_completed',
      );
    table(
      ['Experiment', 'Status', 'Goal'],
      r.experiments.map((e) => [e.key, e.status, goalOf(e)]),
    );
    return;
  }
  if (!key) throw new UsageError(`Pass an experiment key: dataflare experiments ${sub} <key>`);
  if (sub === 'create') {
    const goal = str(flags.goal);
    if (!goal) throw new UsageError('Pass the goal event: --goal signup_completed');
    const r = await call<{ summary: string }>(
      'POST',
      '/api/experiments',
      withProject({
        key,
        goal: { event: goal, value: str(flags.value) },
        flag: str(flags.flag),
        hypothesis: str(flags.hypothesis),
        project: str(flags.project),
      }),
    );
    return flags.json ? printJson(r) : line(r.summary);
  }
  if (sub === 'start' || sub === 'stop' || sub === 'ship') {
    const variant = rest[0] ?? str(flags.variant);
    if (sub === 'ship' && !variant)
      throw new UsageError('Pass the variant to ship: dataflare experiments ship <key> <variant>');
    const r = await call<{ summary: string }>(
      'POST',
      `/api/experiments/${encodeURIComponent(key)}/${sub}`,
      withProject({ variant, project: str(flags.project) }),
    );
    return flags.json ? printJson(r) : line(r.summary);
  }
  if (sub === 'results' || sub === 'show') {
    const r = await call<{ summary: string; results: ExperimentResult }>(
      'GET',
      `/api/experiments/${encodeURIComponent(key)}${projectQuery(flags)}`,
    );
    if (flags.json) return printJson(r);
    line(color.bold(r.summary));
    line();
    table(
      ['Variant', 'Exposed', 'Converted', 'Rate', 'P(beat control)'],
      r.results.variants.map((v) => [
        v.variant,
        v.exposures,
        v.conversions,
        pct(v.conversionRate),
        v.vsControl ? pct(v.vsControl.probabilityToBeatControl) : 'control',
      ]),
    );
    return;
  }
  throw new UsageError(
    `Unknown subcommand "experiments ${sub}".`,
    'Use: dataflare experiments [list | create | start | stop | ship | results]',
  );
}
