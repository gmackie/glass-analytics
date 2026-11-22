/**
 * Feature flags.
 *
 * A flag either returns `null` (off for this user) or a value: `"on"` for simple
 * flags, or a variant key for multivariate flags. Each value can carry a JSON
 * payload (remote config). Assignment is deterministic — a hash of the flag key
 * and an id — so the browser, the Worker and your own servers (dataflare-node,
 * local evaluation) always agree, with no shared state.
 *
 * What is hashed (`bucketBy`):
 * - "device" (default): `distinct_id`, which Dataflare keeps stable across
 *   `identify()`, so logging in never flips a variant mid-session;
 * - "person": the user id once identified (the device before), so a person
 *   gets the same variant on every device;
 * - a group type ("company"): the group key, so a whole account shares a variant.
 *
 * Rules are checked in order; the first whose conditions all match sets the
 * rollout (and can force a variant). Conditions use the filter language: person,
 * group and request properties, saved cohorts (`cohort`), and other flags
 * (`flag.<key>`), which are evaluated first.
 */

import { type EvaluationContext, type Filter, matchFilter, parseProperty } from './filters.ts';
import { fnv1a32 } from './hash.ts';

export interface FlagVariant {
  key: string;
  /** Relative weight; weights need not sum to 100. */
  weight: number;
}

export interface FlagRule {
  /** All conditions must match (AND). Properties as in query filters, e.g. `person.plan`, `country`. */
  conditions: Filter[];
  /** Percentage (0-100) of matching users who get the flag. Defaults to the flag's rollout. */
  rollout?: number;
  /** Force a specific variant for matching users. */
  variant?: string;
}

export interface EarlyAccess {
  /** Shown to users who can opt in, e.g. "New editor". */
  name: string;
  description?: string;
  docsUrl?: string;
  stage: 'concept' | 'alpha' | 'beta';
}

export interface FlagDefinition {
  key: string;
  description?: string;
  enabled: boolean;
  /** Percentage (0-100) of users who get the flag when no rule matches. */
  rollout: number;
  /** Multivariate split. Omit for a simple on/off flag. The first variant is the control. */
  variants?: FlagVariant[];
  /** Targeting rules, checked in order; the first match wins. */
  rules?: FlagRule[];
  /** Change to reshuffle everyone's buckets. */
  salt?: string;
  /** JSON payload per value ("on" for a simple flag, or a variant key). */
  payloads?: Record<string, unknown>;
  /** What is hashed for bucketing: "device" (default), "person", or a group type. */
  bucketBy?: string;
  /** Make the flag an early-access feature that people can opt into. */
  earlyAccess?: EarlyAccess;
  /**
   * A holdout this flag's experiment respects: people in it get the value "holdout" (treat it as
   * the default experience) and are compared with everyone else in holdout results.
   */
  holdout?: { key: string; percentage: number };
  tags?: string[];
}

export const FLAG_ON = 'on';
/** Value given to people in an experiment holdout. */
export const HOLDOUT = 'holdout';
/** Person property where early-access choices are stored: `$early_access.<flag>` = true/false. */
export const EARLY_ACCESS_PROPERTY = '$early_access';

export interface FlagEvaluation {
  value: string | null;
  /** Why: "disabled", "rule 2", "rollout", "outside rollout", "opted in", "no group"… */
  reason: string;
  /** Local evaluation couldn't decide (a property it doesn't know); ask the server. */
  inconclusive?: boolean;
}

export interface EvaluateOptions {
  /**
   * Local evaluation: whether a property is known. A rule that needs an unknown
   * property makes the result inconclusive instead of guessing.
   */
  isKnown?: (property: string) => boolean;
}

/** A user's position in [0, 100) for a given flag and purpose. */
export function bucketOf(
  flag: Pick<FlagDefinition, 'key' | 'salt'>,
  distinctId: string,
  purpose = 'rollout',
): number {
  return (fnv1a32(`${flag.key}:${flag.salt ?? ''}:${purpose}:${distinctId}`) % 10_000) / 100;
}

function pickVariant(flag: FlagDefinition, id: string): string {
  const variants = flag.variants ?? [];
  const total = variants.reduce((a, v) => a + Math.max(0, v.weight), 0);
  if (total <= 0) return variants[0]?.key ?? FLAG_ON;
  const point = (bucketOf(flag, id, 'variant') / 100) * total;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += Math.max(0, v.weight);
    if (point < cumulative) return v.key;
  }
  return variants[variants.length - 1]!.key;
}

/** The id a flag hashes, or null when it buckets by a group the context doesn't have. */
export function bucketingId(flag: FlagDefinition, ctx: EvaluationContext): string | null {
  const by = flag.bucketBy ?? 'device';
  if (by === 'device') return ctx.distinct_id;
  if (by === 'person') return ctx.user_id || ctx.distinct_id;
  return ctx.groups?.[by] ?? null;
}

/** In the flag's holdout: the value "holdout" (not null), so reading it still logs an exposure. */
function holdoutResult(flag: FlagDefinition, id: string): FlagEvaluation | null {
  if (
    !flag.holdout ||
    bucketOf({ key: flag.holdout.key }, id, 'holdout') >= flag.holdout.percentage
  )
    return null;
  return { value: HOLDOUT, reason: `in holdout ${flag.holdout.key}` };
}

/** A person's own early-access choice wins over rules and rollout. */
function earlyAccessResult(flag: FlagDefinition, ctx: EvaluationContext): FlagEvaluation | null {
  if (!flag.earlyAccess) return null;
  const choices = ctx.person?.[EARLY_ACCESS_PROPERTY] as Record<string, unknown> | undefined;
  const choice = choices?.[flag.key];
  if (choice === true)
    return {
      value: flag.variants?.length ? flag.variants.at(-1)!.key : FLAG_ON,
      reason: 'opted in',
    };
  return choice === false ? { value: null, reason: 'opted out' } : null;
}

/** The rule that applies (the first whose conditions all match), or what stops local evaluation. */
function matchingRule(
  flag: FlagDefinition,
  ctx: EvaluationContext,
  options: EvaluateOptions,
): { rollout: number; variant?: string; reason: string } | FlagEvaluation {
  for (const [i, rule] of (flag.rules ?? []).entries()) {
    if (options.isKnown && rule.conditions.some((c) => !options.isKnown!(c.property)))
      return {
        value: null,
        reason: `rule ${i + 1} needs properties local evaluation doesn't have`,
        inconclusive: true,
      };
    if (rule.conditions.every((c) => matchFilter(c, ctx)))
      return {
        rollout: rule.rollout ?? flag.rollout,
        variant: rule.variant,
        reason: `rule ${i + 1}`,
      };
  }
  return { rollout: flag.rollout, reason: 'rollout' };
}

/** Evaluate one flag, with the reason. Other flags it depends on must already be in `ctx.flags`. */
export function evaluateFlagDetailed(
  flag: FlagDefinition,
  ctx: EvaluationContext,
  options: EvaluateOptions = {},
): FlagEvaluation {
  if (!flag.enabled) return { value: null, reason: 'disabled' };
  const id = bucketingId(flag, ctx);
  if (id === null) return { value: null, reason: `no ${flag.bucketBy} group` };
  const early = holdoutResult(flag, id) ?? earlyAccessResult(flag, ctx);
  if (early) return early;
  const rule = matchingRule(flag, ctx, options);
  if ('value' in rule) return rule;
  if (bucketOf(flag, id) >= rule.rollout)
    return { value: null, reason: `outside ${rule.reason} (${rule.rollout}%)` };
  if (rule.variant) return { value: rule.variant, reason: rule.reason };
  return { value: flag.variants?.length ? pickVariant(flag, id) : FLAG_ON, reason: rule.reason };
}

/** Evaluate one flag. Returns null when the flag is off for this context. */
export function evaluateFlag(flag: FlagDefinition, ctx: EvaluationContext): string | null {
  return evaluateFlagDetailed(flag, ctx).value;
}

/** Keys of the flags a flag's rules depend on (`flag.<key>` conditions). */
export function flagDependencies(flag: FlagDefinition): string[] {
  const out = new Set<string>();
  for (const rule of flag.rules ?? []) {
    for (const c of rule.conditions) {
      const ref = parseProperty(c.property);
      if (ref.kind === 'flag') out.add(ref.key);
    }
  }
  return [...out];
}

/** Flags in dependency order (dependencies first). Flags in a cycle are returned in `cyclic`. */
export function dependencyOrder(flags: readonly FlagDefinition[]): {
  ordered: FlagDefinition[];
  cyclic: FlagDefinition[];
} {
  const byKey = new Map(flags.map((f) => [f.key, f]));
  const ordered: FlagDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const cyclic = new Set<string>();
  const visit = (f: FlagDefinition, path: string[]) => {
    const s = state.get(f.key);
    if (s === 'done') return;
    if (s === 'visiting') {
      for (const k of path.slice(path.indexOf(f.key))) cyclic.add(k);
      return;
    }
    state.set(f.key, 'visiting');
    for (const dep of flagDependencies(f)) {
      const d = byKey.get(dep);
      if (d) visit(d, [...path, f.key]);
    }
    state.set(f.key, 'done');
    ordered.push(f);
  };
  for (const f of flags) visit(f, []);
  return {
    ordered: ordered.filter((f) => !cyclic.has(f.key)),
    cyclic: flags.filter((f) => cyclic.has(f.key)),
  };
}

/** Evaluate every flag, dependencies first, with reasons. */
export function evaluateFlagsDetailed(
  flags: readonly FlagDefinition[],
  ctx: EvaluationContext,
  options: EvaluateOptions = {},
): Record<string, FlagEvaluation> {
  const out: Record<string, FlagEvaluation> = {};
  const values: Record<string, string> = { ...(ctx.flags ?? {}) };
  const { ordered, cyclic } = dependencyOrder(flags);
  for (const flag of ordered) {
    const deps = flagDependencies(flag);
    const unknownDep = deps.find((k) => out[k]?.inconclusive);
    if (unknownDep) {
      out[flag.key] = { value: null, reason: `depends on ${unknownDep}`, inconclusive: true };
      continue;
    }
    const result = evaluateFlagDetailed(flag, { ...ctx, flags: values }, options);
    out[flag.key] = result;
    if (result.value !== null) values[flag.key] = result.value;
  }
  for (const flag of cyclic)
    out[flag.key] = { value: null, reason: 'flags depend on each other in a loop' };
  return out;
}

/** Evaluate every flag for a context. Flags that are off are omitted. */
export function evaluateFlags(
  flags: readonly FlagDefinition[],
  ctx: EvaluationContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, r] of Object.entries(evaluateFlagsDetailed(flags, ctx))) {
    if (r.value !== null) out[key] = r.value;
  }
  return out;
}

/** Payloads for the values a user got. */
export function payloadsFor(
  flags: readonly FlagDefinition[],
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const flag of flags) {
    const value = values[flag.key];
    if (value === undefined || !flag.payloads) continue;
    if (Object.hasOwn(flag.payloads, value)) out[flag.key] = flag.payloads[value];
  }
  return out;
}

const FLAG_KEY = /^[a-z0-9][a-z0-9_.-]{0,99}$/i;
/** The most payload JSON one flag may carry, in UTF-8 bytes of compact JSON. */
export const MAX_PAYLOAD_BYTES = 10_000;

/** How big payloads are, as stored and sent: UTF-8 bytes of compact JSON. */
export function payloadBytes(payloads: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payloads) ?? '').length;
}

/**
 * Problems with a web experiment payload (`{ type: "web", transforms: [...] }`), or none.
 * Other payloads are any JSON and aren't checked here.
 */
export function webPayloadProblems(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'web')
    return [];
  const transforms = (payload as { transforms?: unknown }).transforms;
  if (!Array.isArray(transforms)) return ['a web payload needs a "transforms" list'];
  return transforms.flatMap((t, i) => webTransformProblems(t, i + 1));
}

const TRANSFORM_KINDS = ['text', 'html', 'css', 'attributes', 'hide'] as const;

function webTransformProblems(t: unknown, n: number): string[] {
  if (!t || typeof t !== 'object') return [`change ${n} must be an object`];
  const change = t as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof change.selector !== 'string' || !change.selector.trim())
    problems.push(`change ${n} needs a "selector", e.g. "h1" or "#signup"`);
  const kinds = TRANSFORM_KINDS.filter((k) => change[k] !== undefined);
  if (kinds.length === 0)
    problems.push(`change ${n} needs one of ${TRANSFORM_KINDS.map((k) => `"${k}"`).join(', ')}`);
  return problems;
}

type Problems = string[];

function variantProblems(flag: FlagDefinition, problems: Problems): Set<string> {
  const keys = new Set<string>();
  for (const v of flag.variants ?? []) {
    if (!FLAG_KEY.test(v.key)) problems.push(`variant "${v.key}" has an invalid key`);
    if (keys.has(v.key)) problems.push(`variant "${v.key}" is duplicated`);
    if (!(v.weight >= 0)) problems.push(`variant "${v.key}" needs a weight >= 0`);
    keys.add(v.key);
  }
  if (flag.variants && flag.variants.length === 1)
    problems.push('a multivariate flag needs at least two variants');
  return keys;
}

function ruleProblems(flag: FlagDefinition, variants: Set<string>, problems: Problems): void {
  for (const rule of flag.rules ?? []) {
    if (rule.variant && !variants.has(rule.variant))
      problems.push(`rule forces unknown variant "${rule.variant}"`);
    if (rule.rollout !== undefined && !inPercent(rule.rollout))
      problems.push('rule rollout must be between 0 and 100');
  }
}

function payloadProblems(flag: FlagDefinition, variants: Set<string>, problems: Problems): void {
  if (!flag.payloads) return;
  const values = flag.variants?.length ? variants : new Set([FLAG_ON]);
  for (const [k, payload] of Object.entries(flag.payloads)) {
    if (!values.has(k))
      problems.push(
        `payload for "${k}", which this flag never returns (${[...values].join(', ')})`,
      );
    for (const p of webPayloadProblems(payload)) problems.push(`payload for "${k}": ${p}`);
  }
  if (payloadBytes(flag.payloads) > MAX_PAYLOAD_BYTES)
    problems.push('payloads must be at most 10 KB of JSON');
}

const inPercent = (n: number) => n >= 0 && n <= 100;

/** Validate a definition, returning a list of human-readable problems (empty when valid). */
export function validateFlag(flag: FlagDefinition): string[] {
  const problems: string[] = [];
  if (!FLAG_KEY.test(flag.key))
    problems.push('key must be 1-100 characters: letters, digits, "_", "-", "."');
  if (!inPercent(flag.rollout)) problems.push('rollout must be between 0 and 100');
  const variants = variantProblems(flag, problems);
  ruleProblems(flag, variants, problems);
  payloadProblems(flag, variants, problems);
  const groupBucket = flag.bucketBy && flag.bucketBy !== 'device' && flag.bucketBy !== 'person';
  if (groupBucket && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$/.test(flag.bucketBy!))
    problems.push('bucketBy must be "device", "person" or a group type');
  if (flag.holdout && !inPercent(flag.holdout.percentage))
    problems.push('holdout percentage must be between 0 and 100');
  if (flagDependencies(flag).includes(flag.key)) problems.push('a flag cannot depend on itself');
  return problems;
}

/** Problems across a project's flags: dependency loops and dependencies on missing flags. */
export function validateFlagSet(flags: readonly FlagDefinition[]): string[] {
  const problems: string[] = [];
  const keys = new Set(flags.map((f) => f.key));
  for (const f of flags) {
    for (const dep of flagDependencies(f)) {
      if (!keys.has(dep)) problems.push(`flag "${f.key}" depends on "${dep}", which doesn't exist`);
    }
  }
  const { cyclic } = dependencyOrder(flags);
  if (cyclic.length)
    problems.push(`flags depend on each other in a loop: ${cyclic.map((f) => f.key).join(', ')}`);
  return problems;
}
