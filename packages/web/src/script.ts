/**
 * Entry point for the script-tag build served by the Worker at `/s.js`.
 *
 * ```html
 * <script defer src="https://glass.acme.workers.dev/s.js" data-project="acme"></script>
 * ```
 *
 * Attributes: `data-project` (required), `data-host` (defaults to where the
 * script was loaded from), `data-persistence="cookieless"`,
 * `data-autocapture="false"`, `data-replay-sample-rate="0.1"`,
 * `data-replay-on-error-sample-rate="1"`, `data-replay-console="false"` (or
 * `"all"`), `data-replay-network="false"`, `data-replay-mask-all-text="true"`,
 * `data-replay-cookieless="true"` (record without stored ids),
 * `data-release="<version>"` (for source maps), `data-debug="true"`.
 *
 * Calls made before the script loads can be queued with this one-line stub:
 * `<script>window.glass=window.glass||{q:[],capture(){this.q.push(['capture',...arguments])},identify(){this.q.push(['identify',...arguments])}}</script>`
 */

import { Dataflare } from './client.ts';

type Queued = [method: string, ...args: unknown[]];
const w = window as unknown as { glass?: Dataflare | { q?: Queued[] } };
const queued = (w.glass as { q?: Queued[] } | undefined)?.q ?? [];
const glass = new Dataflare();
w.glass = glass;

const script = document.currentScript as HTMLScriptElement | null;
const data = script?.dataset;
if (script && data?.project) {
  const host = data.host ?? new URL(script.src, location.href).href.replace(/\/s\.js(\?.*)?$/, '');
  const sampleRate = Number(data.replaySampleRate ?? 0);
  const onErrorSampleRate = Number(data.replayOnErrorSampleRate ?? 0);
  glass.init({
    host,
    project: data.project,
    persistence: data.persistence === 'cookieless' ? 'cookieless' : 'localStorage',
    autocapture: data.autocapture !== 'false',
    replay:
      sampleRate > 0 || onErrorSampleRate > 0
        ? {
            sampleRate,
            onErrorSampleRate,
            console:
              data.replayConsole === 'false'
                ? false
                : data.replayConsole === 'all'
                  ? true
                  : undefined,
            network: data.replayNetwork !== 'false',
            maskAllText: data.replayMaskAllText === 'true',
            cookieless: data.replayCookieless === 'true',
          }
        : false,
    debug: data.debug === 'true',
    release: data.release,
  });
}

for (const [method, ...args] of queued) {
  const fn = (glass as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
  if (typeof fn === 'function') fn.apply(glass, args);
}
