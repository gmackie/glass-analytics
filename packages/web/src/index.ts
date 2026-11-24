/**
 * @gmacko/dataflare-web — the Dataflare browser SDK.
 *
 * ```ts
 * import { glass } from '@gmacko/dataflare-web';
 *
 * glass.init({ host: 'https://glass.acme.workers.dev', project: 'acme' });
 * glass.capture('signup_completed', { plan: 'pro' });
 * glass.identify(user.id, { plan: 'pro' });
 * if (glass.flag('new-checkout') === 'test') showNewCheckout();
 * ```
 *
 * No build step? Use the script tag the Worker serves instead:
 * `<script defer src="https://glass.acme.workers.dev/s.js" data-project="acme"></script>`
 */

import { Dataflare } from './client.ts';

export type {
  AutocaptureOptions,
  Bootstrap,
  ConsoleLevel,
  EarlyAccessFeature,
  GlassOptions,
  Persistence,
  ReplayOptions,
  WireEvent,
} from './types.ts';
/** `Glass` is the class's earlier name, kept so existing imports keep working. */
export { Dataflare, Dataflare as Glass };

/** The default client. Call `glass.init()` once, as early as possible. */
export const glass = new Dataflare();
