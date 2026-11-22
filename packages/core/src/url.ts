/**
 * URL and referrer helpers used at ingest.
 */

export interface ParsedPage {
  url: string;
  host: string;
  path: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
}

const EMPTY: ParsedPage = {
  url: '',
  host: '',
  path: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_term: '',
  utm_content: '',
};

/** Parse a page URL. Query strings are dropped from `url` except UTM tags, which become columns. */
export function parsePage(raw: string | null | undefined): ParsedPage {
  if (!raw) return { ...EMPTY };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return {
      ...EMPTY,
      url: raw.slice(0, 2000),
      path: raw.startsWith('/') ? raw.split('?')[0]!.slice(0, 500) : '',
    };
  }
  const q = u.searchParams;
  // `ref` and `source` are common untagged alternatives to utm_source.
  const source = q.get('utm_source') ?? q.get('ref') ?? q.get('source') ?? '';
  // `origin` is the string "null" for non-special schemes such as the
  // native SDK's app://<project>/<route>, so rebuild it from its parts.
  const origin = u.origin === 'null' ? `${u.protocol}//${u.host}` : u.origin;
  return {
    url: `${origin}${u.pathname}`.slice(0, 2000),
    host: u.hostname,
    path: (decodeSafe(u.pathname) || '/').slice(0, 500),
    utm_source: source.slice(0, 200),
    utm_medium: (q.get('utm_medium') ?? '').slice(0, 200),
    utm_campaign: (q.get('utm_campaign') ?? '').slice(0, 200),
    utm_term: (q.get('utm_term') ?? '').slice(0, 200),
    utm_content: (q.get('utm_content') ?? '').slice(0, 200),
  };
}

function decodeSafe(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * The referrer host, normalised. Internal navigation (same host as the page)
 * returns '' so it shows up as "Direct / None" rather than as your own site.
 */
export function referrerHost(referrer: string | null | undefined, pageHost: string): string {
  if (!referrer) return '';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    return host === pageHost.replace(/^www\./, '') ? '' : host;
  } catch {
    return '';
  }
}

/** `s` without trailing slashes, in linear time (a `/\/+$/` regex backtracks on long runs of slashes). */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** `s` without leading or trailing slashes, in linear time. */
export function trimSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47) start++;
  return trimTrailingSlashes(s.slice(start));
}
