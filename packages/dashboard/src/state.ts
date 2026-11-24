/**
 * App state that lives in the URL (so every view is a shareable link) or in
 * localStorage (the API key and preferences).
 */

const base = document.querySelector<HTMLMetaElement>('meta[name="glass-base"]')?.content ?? '';

/**
 * Demo mode: the public site serves the dashboard with recorded API responses
 * (`<meta name="glass-demo" content="/demo/data">`), so nothing needs a key or a Worker.
 */
const demo = document.querySelector<HTMLMetaElement>('meta[name="glass-demo"]')?.content ?? '';

export const config = {
  /** Path prefix of the Worker, '' or '/_glass'. */
  base,
  /** URL of the recorded responses, when this is the public demo. */
  demo,
  /** The Worker authenticated the dashboard with Cloudflare Access. */
  access: document.querySelector('meta[name="glass-auth"]')?.getAttribute('content') === 'access',
};

function stored(key: string): string | null {
  try {
    return localStorage.getItem(`glass:${key}`);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`glass:${key}`);
    else localStorage.setItem(`glass:${key}`, value);
  } catch {
    // ignore
  }
}

export const prefs = {
  get key(): string | null {
    return demo ? 'demo' : stored('key');
  },
  set key(value: string | null) {
    store('key', value);
  },
  get showSql(): boolean {
    return stored('show-sql') === '1';
  },
  set showSql(value: boolean) {
    store('show-sql', value ? '1' : null);
    document.documentElement.classList.toggle('show-sql', value);
  },
  get project(): string | null {
    return stored('project');
  },
  set project(value: string | null) {
    store('project', value);
  },
  /** Overlay the previous period on time charts. On by default. */
  get compare(): boolean {
    return stored('compare') !== '0';
  },
  set compare(value: boolean) {
    store('compare', value ? null : '0');
  },
  get sidebarCollapsed(): boolean {
    return stored('sidebar') === 'collapsed';
  },
  set sidebarCollapsed(value: boolean) {
    store('sidebar', value ? 'collapsed' : null);
  },
  /** 'system' follows the OS; 'light' and 'dark' pin the theme. */
  get theme(): 'system' | 'light' | 'dark' {
    const t = stored('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  },
  set theme(value: 'system' | 'light' | 'dark') {
    store('theme', value === 'system' ? null : value);
    if (value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', value);
  },
};

export interface Route {
  /** e.g. "reports", "insights", "replays" */
  page: string;
  /** Path segments after the page, e.g. ["funnel"] or ["session-id"] */
  rest: string[];
  params: URLSearchParams;
}

/**
 * Sign in from a link: `<host>/app#key=<api key>` (what a QR code for a phone carries).
 * The fragment never reaches the server, so the key stays out of request logs. The key
 * is saved like a pasted one and wiped from the address bar and history straight away.
 * Access dashboards discard old key links. Returns true when a key link was cleared.
 */
export function takeKeyFromLink(): boolean {
  const match = /^#\/?key=([^&]+)$/.exec(location.hash);
  if (!match?.[1]) return false;
  if (!config.access) prefs.key = decodeURIComponent(match[1]);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

export function currentRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = hash.split('?');
  const [page = 'reports', ...rest] = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { page, rest, params: new URLSearchParams(query) };
}

/** Navigate, keeping the shared project and date range parameters unless overridden. */
export function go(
  page: string,
  params: Record<string, string | undefined | null> = {},
  keep = true,
): void {
  const current = currentRoute().params;
  const next = new URLSearchParams();
  if (keep)
    for (const k of ['project', 'from', 'to']) if (current.get(k)) next.set(k, current.get(k)!);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') next.delete(k);
    else next.set(k, v);
  }
  const q = next.toString();
  location.hash = `#/${page}${q ? `?${q}` : ''}`;
}

export function href(page: string, params: Record<string, string | undefined | null> = {}): string {
  const current = currentRoute().params;
  const next = new URLSearchParams();
  for (const k of ['project', 'from', 'to']) if (current.get(k)) next.set(k, current.get(k)!);
  for (const [k, v] of Object.entries(params)) {
    if (v) next.set(k, v);
    else if (v === null) next.delete(k);
  }
  const q = next.toString();
  return `#/${page}${q ? `?${q}` : ''}`;
}

/** The shared query parameters every page passes to the API. */
export function scope(): { project?: string; from: string; to?: string } {
  const p = currentRoute().params;
  return {
    project: p.get('project') ?? prefs.project ?? undefined,
    from: p.get('from') ?? '-30d',
    to: p.get('to') ?? undefined,
  };
}
