/** Server-enforced collection controls. These do not implement district authorization. */
import { z } from 'zod/v4';
import type { WireEvent } from './events.ts';

const scalar = z.union([z.string().max(100), z.number().finite(), z.boolean()]);
const propertyRule = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    values: z.array(scalar).min(1).max(100).optional(),
  })
  .strict();
export const eventCatalogSchema = z
  .object({
    version: z.number().int().positive(),
    events: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
            description: z.string().min(1).max(300),
            label: z.string().min(1).max(100).optional(),
            eventClass: z.literal('product').default('product'),
            properties: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), propertyRule),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    if (new Set(catalog.events.map((e) => e.name)).size !== catalog.events.length)
      ctx.addIssue({ code: 'custom', message: 'Event names must be unique.' });
  });
export const capturePolicySchema = z
  .object({
    revision: z.number().int().positive(),
    profile: z.enum(['standard', 'disabled', 'aggregate']),
    catalog: eventCatalogSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.profile === 'aggregate') {
      if (!policy.catalog)
        ctx.addIssue({
          code: 'custom',
          message: 'Aggregate collection requires an event catalog.',
        });
      for (const event of policy.catalog?.events ?? [])
        for (const rule of Object.values(event.properties)) {
          if (rule.type === 'string' && !rule.values)
            ctx.addIssue({
              code: 'custom',
              message: 'Aggregate string properties require a bounded values allowlist.',
            });
        }
    }
  });
export type CapturePolicy = z.infer<typeof capturePolicySchema>;

/** Returns null for a denied event. Rejection never exposes the input payload. */
export function applyCapturePolicy(event: WireEvent, policy: CapturePolicy): WireEvent | null {
  if (policy.profile === 'disabled') return null;
  const definition = policy.catalog?.events.find((e) => e.name === event.event);
  if (policy.profile === 'aggregate' && event.event.startsWith('$')) return null;
  if (policy.catalog && !definition && !event.event.startsWith('$')) return null;
  const props = event.props ?? {};
  if (definition) {
    if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
    for (const [key, value] of Object.entries(props)) {
      const rule = definition.properties[key];
      if (
        !rule ||
        typeof value !== rule.type ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (typeof value === 'string' && value.length > 100) ||
        (rule.values && !rule.values.includes(value as string | number | boolean))
      )
        return null;
    }
  }
  if (policy.profile !== 'aggregate') return event;
  // Per-event ids deliberately prevent session/person linking; no IP/UA identity is needed.
  return {
    id: event.id,
    event: event.event,
    ts: event.ts,
    distinct_id: `a_${event.id}`,
    session_id: `a_${event.id}`,
    props: { ...props },
  };
}
