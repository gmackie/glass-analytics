/**
 * Look up the newest published Dataflare CLI version (@gmacko/dataflare-cli on npm.forgegraf.com, DATFLR-27) so /health and the
 * dashboard can tell operators (and agents) when to run `dataflare upgrade`.
 *
 * Failures are silent: an unreachable registry must never break health checks.
 */

const NPM_LATEST = 'https://npm.forgegraf.com/@gmacko%2fdataflare-cli/latest';
const CACHE_MS = 60 * 60 * 1000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

let cache: { at: number; latest: string | null } | null = null;
let inflight: Promise<string | null> | null = null;
let fetcher: Fetcher = fetch;

/** Test hook: swap the fetcher and/or clear the cache. */
export function configureLatestCheck(
  options: { fetch?: Fetcher; clearCache?: boolean } = {},
): void {
  if (options.fetch) fetcher = options.fetch;
  if (options.clearCache) {
    cache = null;
    inflight = null;
  }
}

export function peekLatestVersion(): string | null {
  return cache?.latest ?? null;
}

/** Cached lookup of the latest dataflare version on npm. */
export async function fetchLatestVersion(): Promise<string | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.latest;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetcher(NPM_LATEST, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        cache = { at: Date.now(), latest: cache?.latest ?? null };
        return cache.latest;
      }
      const body = (await res.json()) as { version?: unknown };
      const latest = typeof body.version === 'string' ? body.version : null;
      cache = { at: Date.now(), latest };
      return latest;
    } catch {
      cache = { at: Date.now(), latest: cache?.latest ?? null };
      return cache.latest;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
