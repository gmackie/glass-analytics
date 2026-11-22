/**
 * The destination registry. Add a template: write it (data plus a render function, see
 * types.ts), add it here, and it appears in list_destination_templates and the dashboard.
 */

import { GA4, META_CAPI, TIKTOK } from './ads.ts';
import { AMPLITUDE, MIXPANEL, POSTHOG } from './analytics.ts';
import { CUSTOMERIO, HUBSPOT, LOOPS } from './crm.ts';
import { DISCORD, MAKE, N8N, SLACK, TEAMS, WEBHOOK, ZAPIER } from './notifications.ts';
import type { DestinationTemplate } from './types.ts';

export const TEMPLATES: Record<string, DestinationTemplate> = Object.fromEntries(
  [
    WEBHOOK,
    SLACK,
    DISCORD,
    TEAMS,
    META_CAPI,
    GA4,
    TIKTOK,
    CUSTOMERIO,
    LOOPS,
    HUBSPOT,
    MIXPANEL,
    AMPLITUDE,
    POSTHOG,
    ZAPIER,
    MAKE,
    N8N,
  ].map((t) => [t.id, t]),
);

export { eventPayload } from './notifications.ts';
export * from './types.ts';
