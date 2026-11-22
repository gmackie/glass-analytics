/**
 * Session replays: a searchable list, and a player beside the activity
 * timeline agents read as a transcript.
 *
 * The player is rrweb's Replayer with our own controls: a scrubber with
 * markers for clicks, errors, pages and notes, speed, skip-inactivity,
 * fullscreen and keyboard shortcuts. The activity panel is the structured
 * timeline from `/api/replays/:id/summary?format=json` (the same one
 * `summarise_replay` renders as text), synced to playback.
 *
 * Times in links (`?t=`) are ms from the start of the transcript, so a link an
 * agent prints opens the player at the same moment it describes.
 */

import { type eventWithTime, Replayer } from 'rrweb';
import 'rrweb/dist/style.css';
import { api } from '../api.ts';
import { cleanFilters, type FilterRow, filterEditor } from '../components/filter-editor.ts';
import { type IconName, icon } from '../components/icons.ts';
import { modal, selectMenu, toggle } from '../components/menu.ts';
import { eventPicker } from '../components/picker.ts';
import {
  copyButton,
  empty,
  errorState,
  iconButton,
  later,
  loading,
  pageHeader,
  panel,
  table,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, dateTime, duration } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

// ── Shared ─────────────────────────────────────────────────────────────────

interface ReplayListItem {
  session: string;
  person: string;
  started: string;
  durationSeconds: number;
  activeSeconds: number | null;
  pages: number;
  clicks: number;
  rageClicks: number;
  deadClicks: number | null;
  errors: number;
  consoleErrors: number;
  failedRequests: number;
  url: string;
  device: string;
}

type Kind =
  | 'page'
  | 'click'
  | 'input'
  | 'event'
  | 'error'
  | 'console'
  | 'network'
  | 'idle'
  | 'note';

interface TimelineItem {
  ts: number;
  t: number;
  kind: Kind;
  text: string;
  label?: string;
  selector?: string;
  url?: string;
  count?: number;
  detail?: string;
  level?: 'error' | 'warn' | 'info';
  signals?: ('rage' | 'dead' | 'error')[];
  author?: string;
  id?: string;
  verbose?: boolean;
}

interface Stats {
  durationSeconds: number;
  activeSeconds: number;
  pages: number;
  clicks: number;
  rageClicks: number;
  deadClicks: number;
  errorClicks: number;
  inputs: number;
  errors: number;
  consoleErrors: number;
  failedRequests: number;
  customEvents: number;
}

interface SummaryResponse {
  session: string;
  person: string;
  device: string;
  started: string;
  transcript: string;
  stats: Stats;
  startedAt: number;
  endedAt: number;
  timeline: TimelineItem[];
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const LIST_KEY = 'glass:replay-list';

/** Remember the list the user came from, for previous/next on the player. */
function rememberList(sessions: string[], query: string): void {
  try {
    sessionStorage.setItem(LIST_KEY, JSON.stringify({ sessions, query }));
  } catch {
    // Storage blocked: previous/next just won't show.
  }
}

function recallList(): { sessions: string[]; query: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(LIST_KEY) ?? 'null');
  } catch {
    return null;
  }
}

// ── List ───────────────────────────────────────────────────────────────────

const SIGNALS: { value: string; label: string; icon: IconName }[] = [
  { value: 'errors', label: 'Errors', icon: 'alert' },
  { value: 'rage_clicks', label: 'Rage clicks', icon: 'zap' },
  { value: 'dead_clicks', label: 'Dead clicks', icon: 'mouse' },
  { value: 'console_errors', label: 'Console errors', icon: 'code' },
  { value: 'failed_requests', label: 'Failed requests', icon: 'globe' },
];

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'longest', label: 'Longest' },
  { value: 'most_active', label: 'Most active' },
  { value: 'most_errors', label: 'Most errors' },
  { value: 'most_frustrated', label: 'Most frustrated' },
] as const;

const MIN_LENGTHS = [
  { value: '', label: 'Any length' },
  { value: '10', label: '10s or longer' },
  { value: '30', label: '30s or longer' },
  { value: '60', label: '1 min or longer' },
  { value: '300', label: '5 min or longer' },
];

const PAGE_SIZE = 50;

function signalBadges(x: ReplayListItem): Child {
  const out: Child[] = [];
  if (x.errors)
    out.push(
      h(
        'span',
        { class: 'badge bad', title: 'JavaScript errors' },
        icon('alert', 12),
        String(x.errors),
      ),
    );
  if (x.rageClicks)
    out.push(
      h(
        'span',
        { class: 'badge warn', title: 'Rage clicks' },
        icon('zap', 12),
        String(x.rageClicks),
      ),
    );
  if (x.deadClicks)
    out.push(
      h(
        'span',
        { class: 'badge warn', title: 'Dead clicks' },
        icon('mouse', 12),
        String(x.deadClicks),
      ),
    );
  if (x.consoleErrors)
    out.push(
      h(
        'span',
        { class: 'badge bad', title: 'Console errors' },
        icon('code', 12),
        String(x.consoleErrors),
      ),
    );
  if (x.failedRequests)
    out.push(
      h(
        'span',
        { class: 'badge bad', title: 'Failed requests' },
        icon('globe', 12),
        String(x.failedRequests),
      ),
    );
  return out.length
    ? h('span', { class: 'signal-badges' }, out)
    : h('span', { class: 'muted' }, '—');
}

function list(route: Route): Node[] {
  const p = route.params;
  // Older links used ?errors=1.
  const has = new Set(
    (p.get('has') ?? (p.get('errors') === '1' ? 'errors' : '')).split(',').filter(Boolean),
  );
  const filters: FilterRow[] = (() => {
    try {
      return JSON.parse(p.get('filters') ?? '[]');
    } catch {
      return [];
    }
  })();
  const state = {
    q: p.get('q') ?? '',
    url: p.get('url') ?? '',
    did: p.get('did') ?? '',
    not: p.get('not') ?? '',
    min: p.get('min') ?? '',
    sort: p.get('sort') ?? 'newest',
  };
  const apply = (changes: Record<string, string | null> = {}) =>
    go('replays', {
      q: state.q || null,
      has: [...has].join(',') || null,
      url: state.url || null,
      did: state.did || null,
      not: state.not || null,
      min: state.min || null,
      sort: state.sort === 'newest' ? null : state.sort,
      filters: cleanFilters(filters)?.length ? JSON.stringify(cleanFilters(filters)) : null,
      errors: null,
      ...changes,
    });

  const search = h('input', {
    type: 'search',
    placeholder: 'Search sessions, people, URLs, clicked elements, errors…',
    value: state.q,
    'aria-label': 'Search sessions',
  });
  search.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      state.q = search.value.trim();
      apply();
    }
  });

  const chips = h(
    'div',
    { class: 'signal-chips', role: 'group', 'aria-label': 'Only sessions with' },
    SIGNALS.map((s) =>
      h(
        'button',
        {
          type: 'button',
          class: `signal-chip ${has.has(s.value) ? 'on' : ''}`,
          'aria-pressed': String(has.has(s.value)),
          onclick: () => {
            if (has.has(s.value)) has.delete(s.value);
            else has.add(s.value);
            apply();
          },
        },
        icon(s.icon, 13),
        s.label,
      ),
    ),
  );

  const extraCount =
    [state.url, state.did, state.not, state.min].filter(Boolean).length +
    (cleanFilters(filters)?.length ?? 0);
  const more = h('div', { class: 'replay-filters', hidden: extraCount === 0 });
  const urlInput = h('input', {
    type: 'text',
    placeholder: '/checkout',
    value: state.url,
    'aria-label': 'Visited URL containing',
  });
  mount(
    more,
    h(
      'div',
      { class: 'replay-filter-grid' },
      h('label', { class: 'field' }, h('span', {}, 'Visited a URL containing'), urlInput),
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'Did this event'),
        eventPicker({
          value: state.did,
          placeholder: 'Any event',
          onChange: (v) => (state.did = v),
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'But never did'),
        eventPicker({
          value: state.not,
          placeholder: 'No exclusion',
          onChange: (v) => (state.not = v),
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'Length'),
        selectMenu({
          value: state.min,
          options: MIN_LENGTHS,
          label: 'Minimum length',
          onChange: (v) => {
            state.min = v;
            apply();
          },
        }),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Where any event matches'),
      filterEditor(filters, () => {}, { cohorts: true, project: scope().project }),
    ),
    h(
      'div',
      { class: 'replay-filter-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'primary small',
          onclick: () => {
            state.url = urlInput.value.trim();
            apply();
          },
        },
        'Apply filters',
      ),
      extraCount
        ? h(
            'button',
            {
              type: 'button',
              class: 'ghost small',
              onclick: () => go('replays', { has: [...has].join(',') || null, q: state.q || null }),
            },
            'Clear',
          )
        : null,
    ),
  );
  const moreButton = h(
    'button',
    {
      type: 'button',
      class: `ghost small ${extraCount ? 'active' : ''}`,
      onclick: () => (more.hidden = !more.hidden),
    },
    icon('filter', 14),
    extraCount ? `Filters · ${extraCount}` : 'More filters',
  );
  const sort = selectMenu({
    value: state.sort,
    options: [...SORTS],
    label: 'Sort',
    align: 'end',
    onChange: (v) => {
      state.sort = v;
      apply();
    },
  });
  const params = () => ({
    project: scope().project,
    from: scope().from,
    to: scope().to,
    search: state.q || undefined,
    has: [...has].join(',') || undefined,
    url: state.url || undefined,
    did_event: state.did || undefined,
    not_event: state.not || undefined,
    min_duration: state.min || undefined,
    sort: state.sort,
    filters: cleanFilters(filters)?.length ? JSON.stringify(cleanFilters(filters)) : undefined,
    limit: PAGE_SIZE,
  });

  const agentPrompt = () => {
    const parts = [...has].map((x) => x.replace('_', ' '));
    return `Using the Dataflare MCP tools, run analyse_replays${parts.length ? ` on sessions with ${parts.join(' and ')}` : ''}${state.url ? ` that visited ${state.url}` : ''} for ${scope().from}, then open the worst examples with summarise_replay and replay_snapshot. Tell me what is frustrating users and where in the code to fix it.`;
  };

  return [
    pageHeader('Replays', 'Recorded sessions with a timeline agents can read.', [
      copyButton(agentPrompt, 'Ask an agent', 'bot'),
      h(
        'a',
        { class: 'button ghost small', href: href('replays/patterns') },
        icon('layers', 14),
        'Patterns',
      ),
    ]),
    h(
      'div',
      { class: 'toolbar replay-toolbar' },
      h('label', { class: 'search-field' }, icon('search', 14), search),
      chips,
      h('span', { class: 'spacer' }),
      moreButton,
      sort,
    ),
    more,
    later(
      async () => {
        const r = await api.get<{ enabled: boolean; total: number; replays: ReplayListItem[] }>(
          '/api/replays',
          params(),
        );
        if (!r.enabled)
          return empty(
            'Enable R2 in your Cloudflare account, then run dataflare upgrade.',
            undefined,
            {
              icon: 'replay',
              title: 'Session replay is off',
            },
          );
        const filtered = Boolean(state.q || has.size || extraCount);
        if (r.replays.length === 0) {
          return filtered
            ? empty(
                'No recorded sessions match these filters in this period.',
                h(
                  'button',
                  { type: 'button', class: 'ghost small', onclick: () => go('replays', {}) },
                  'Clear filters',
                ),
                { icon: 'search', title: 'No matches' },
              )
            : empty(
                'Set data-replay-sample-rate="0.1" on the script tag to record 10% of sessions. Inputs are masked. Loading Dataflare cookieless? Replay waits for consent unless you also add data-replay-cookieless="true".',
                h(
                  'a',
                  { class: 'button', href: href('settings') },
                  icon('code', 14),
                  'Install snippet',
                ),
                { icon: 'replay', title: 'No recordings yet' },
              );
        }
        const sessions = r.replays.map((x) => x.session);
        const query = location.hash.split('?')[1] ?? '';
        rememberList(sessions, query);
        const row = (x: ReplayListItem): Child[] => [
          h(
            'a',
            {
              class: 'replay-link',
              href: href(`replays/${x.session}`),
              title: dateTime(x.started),
            },
            h('span', { class: 'play-chip' }, icon('play', 11)),
            h(
              'span',
              {},
              h('span', { class: 'replay-when' }, ago(x.started)),
              h('span', { class: 'muted replay-date' }, dateTime(x.started)),
            ),
          ),
          h(
            'a',
            { class: 'cell-clip', href: href(`users/${encodeURIComponent(x.person)}`) },
            x.person.slice(0, 20),
          ),
          h(
            'span',
            {},
            duration(x.durationSeconds),
            x.activeSeconds != null
              ? h('span', { class: 'muted' }, ` · ${duration(x.activeSeconds)} active`)
              : null,
          ),
          String(x.pages || '—'),
          String(x.clicks),
          signalBadges(x),
          h('span', { class: 'muted cell-clip', title: x.url }, x.url.replace(/^https?:\/\//, '')),
          h(
            'span',
            { class: 'muted device-cell' },
            icon(
              x.device.startsWith('mobile')
                ? 'smartphone'
                : x.device.startsWith('tablet')
                  ? 'tablet'
                  : 'monitor',
              14,
            ),
            x.device,
          ),
        ];
        const t = table(
          ['Session', 'Person', 'Length', 'Pages', 'Clicks', 'Signals', 'First page', 'Device'],
          r.replays.map(row),
          { numeric: [3, 4], class: 'replay-table' },
        );
        const tbody = t.querySelector('tbody')!;
        let loaded = r.replays.length;
        const moreRows = h('div', { class: 'load-more' });
        const paint = () => {
          if (loaded >= r.total) return mount(moreRows);
          mount(
            moreRows,
            h(
              'button',
              {
                type: 'button',
                class: 'ghost',
                onclick: async () => {
                  mount(moreRows, loading('Loading more'));
                  const next = await api.get<{ replays: ReplayListItem[] }>('/api/replays', {
                    ...params(),
                    offset: loaded,
                  });
                  for (const x of next.replays)
                    tbody.append(
                      h(
                        'tr',
                        {},
                        row(x).map((cell, i) =>
                          h('td', { class: i === 3 || i === 4 ? 'num' : '' }, cell),
                        ),
                      ),
                    );
                  loaded += next.replays.length;
                  sessions.push(...next.replays.map((x) => x.session));
                  rememberList(sessions, query);
                  paint();
                },
              },
              `Load ${Math.min(PAGE_SIZE, r.total - loaded)} more`,
            ),
          );
        };
        paint();
        return panel(
          `${r.total.toLocaleString('en-US')} recording${r.total === 1 ? '' : 's'}`,
          [t, moreRows],
          { subtitle: SORTS.find((s) => s.value === state.sort)?.label },
        );
      },
      'Loading recordings',
      'table',
    ),
  ];
}

// ── Patterns across sessions ──────────────────────────────────────────────

interface Finding {
  what: string;
  occurrences: number;
  sessions: number;
  examples: { session: string; t: number; at: string }[];
}

function patterns(): Node[] {
  const section = (title: string, iconName: IconName, findings: Finding[], hint: string) =>
    panel(
      title,
      findings.length
        ? h(
            'ul',
            { class: 'findings' },
            findings.map((f) =>
              h(
                'li',
                {},
                h('div', { class: 'finding-what' }, f.what),
                h(
                  'div',
                  { class: 'finding-meta muted' },
                  `${f.sessions} session${f.sessions === 1 ? '' : 's'} · ${f.occurrences}×`,
                  f.examples.map((e) =>
                    h(
                      'a',
                      {
                        class: 'finding-example',
                        href: href(`replays/${e.session}`, { t: String(e.t) }),
                      },
                      icon('play', 10),
                      e.at,
                    ),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted' }, hint),
      { icon: iconName },
    );
  return [
    pageHeader('Replay patterns', 'What frustrates people across recent sessions in this period.', [
      h(
        'a',
        { class: 'button ghost small', href: href('replays') },
        icon('replay', 14),
        'All recordings',
      ),
    ]),
    later(
      async () => {
        const a = await api.get<{
          enabled: boolean;
          analysed: number;
          matching: number;
          skipped: number;
          totals: Record<string, number>;
          rageClicks: Finding[];
          deadClicks: Finding[];
          errors: Finding[];
          failedRequests: Finding[];
          consoleErrors: Finding[];
          exitPages: Finding[];
        }>('/api/replays/analyse', {
          project: scope().project,
          from: scope().from,
          to: scope().to,
          limit: 100,
        });
        if (!a.enabled)
          return empty(
            'Enable R2 in your Cloudflare account, then run dataflare upgrade.',
            undefined,
            {
              icon: 'replay',
              title: 'Session replay is off',
            },
          );
        return [
          h(
            'p',
            { class: 'muted patterns-coverage' },
            `${a.analysed} of ${a.matching} sessions analysed`,
            a.skipped
              ? ` (${a.skipped} not summarised yet: sessions are summarised hourly, about 30 minutes after they end)`
              : '',
            '.',
          ),
          h(
            'div',
            { class: 'grid-2 patterns-grid' },
            section('Rage-clicked', 'zap', a.rageClicks, 'No rage clicks.'),
            section(
              'Dead clicks',
              'mouse',
              a.deadClicks,
              'No clicks on controls that did nothing.',
            ),
            section('Errors', 'alert', a.errors, 'No JavaScript errors.'),
            section('Failed requests', 'globe', a.failedRequests, 'No failed requests.'),
            section('Console errors', 'code', a.consoleErrors, 'No console errors.'),
            section(
              'Where frustrated sessions ended',
              'external',
              a.exitPages,
              'No sessions with problems.',
            ),
          ),
        ];
      },
      'Analysing sessions',
      'cards',
    ),
  ];
}

// ── Player ─────────────────────────────────────────────────────────────────

/** rrweb needs the player root in the document before it builds its sandboxed iframe. */
async function whenConnected(el: Element): Promise<void> {
  if (el.isConnected) return;
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (el.isConnected) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const KIND_ICON: Record<Kind, IconName> = {
  page: 'external',
  click: 'mouse',
  input: 'hash',
  event: 'zap',
  error: 'alert',
  console: 'code',
  network: 'globe',
  idle: 'clock',
  note: 'bot',
};

const FILTERS: { value: string; label: string; match: (i: TimelineItem) => boolean }[] = [
  { value: 'all', label: 'All', match: (i) => !i.verbose },
  {
    value: 'problems',
    label: 'Problems',
    match: (i) => i.level === 'error' || i.level === 'warn' || Boolean(i.signals?.length),
  },
  { value: 'page', label: 'Pages', match: (i) => i.kind === 'page' },
  { value: 'click', label: 'Clicks', match: (i) => i.kind === 'click' || i.kind === 'input' },
  { value: 'event', label: 'Events', match: (i) => i.kind === 'event' },
  { value: 'console', label: 'Console', match: (i) => i.kind === 'console' || i.kind === 'error' },
  { value: 'network', label: 'Network', match: (i) => i.kind === 'network' },
  { value: 'note', label: 'Notes', match: (i) => i.kind === 'note' },
];

function markerClass(i: TimelineItem): string | null {
  if (i.kind === 'note') return 'note';
  if (i.kind === 'error' || (i.level === 'error' && i.kind !== 'click')) return 'error';
  if (i.kind === 'click' && i.signals?.length)
    return i.signals.includes('error') ? 'error' : 'warn';
  if (i.kind === 'page') return 'page';
  if (i.kind === 'click') return 'click';
  if (i.kind === 'event') return 'event';
  return null;
}

function detail(session: string, route: Route): Node[] {
  const project = scope().project;
  const deepLink = Number(route.params.get('t'));
  const stage = h('div', { class: 'replay-stage' });
  const frame = h('div', { class: 'replay-frame' });
  const overlay = h('div', { class: 'replay-overlay', hidden: true });
  stage.append(frame, overlay);
  const urlBar = h(
    'div',
    { class: 'replay-url' },
    icon('globe', 13),
    h('span', { class: 'replay-url-text' }, '…'),
    h('span', { class: 'replay-viewport muted' }),
  );
  const controls = h('div', { class: 'player-controls' }, loading('Loading recording'));
  const activity = h('div', { class: 'activity' }, loading('Reading the session', 'table'));
  const header = h('div', {}, pageHeader('Session replay', session));
  const statsRow = h('div', { class: 'replay-stats' });
  const playerPanel = h('section', { class: 'panel player' }, urlBar, stage, controls);

  let replayer: Replayer | null = null;
  let summary: SummaryResponse | null = null;
  let disposed = false;
  let raf = 0;
  /** Epoch ms of the recording's first event: replayer time 0. */
  let recordingStart = 0;
  let total = 0;
  const urlMarks: { ts: number; href: string }[] = [];
  let playing = false;
  let filter = 'all';
  let needle = '';
  let follow = true;
  let renderActivity: () => void = () => {};
  let paintMarkers: () => void = () => {};
  let updatePosition: (offset: number) => void = () => {};

  const currentOffset = () =>
    replayer ? Math.min(total, Math.max(0, replayer.getCurrentTime())) : 0;
  /** Transcript time (what agents and links use) for the current playback position. */
  const transcriptTime = () =>
    summary ? recordingStart + currentOffset() - summary.startedAt : currentOffset();
  const toOffset = (ts: number) => Math.min(total, Math.max(0, ts - recordingStart));

  const setPlaying = (next: boolean, from?: number) => {
    if (!replayer) return;
    const at = from ?? currentOffset();
    if (next) replayer.play(at >= total - 50 ? 0 : at);
    else replayer.pause(at);
    playing = next;
    playButton.replaceChildren(icon(next ? 'pause' : 'play', 16));
    playButton.setAttribute('aria-label', next ? 'Pause (space)' : 'Play (space)');
    loop();
  };
  const seek = (offset: number) => setPlaying(playing, Math.min(total, Math.max(0, offset)));
  const loop = () => {
    cancelAnimationFrame(raf);
    const step = () => {
      if (disposed) return;
      updatePosition(currentOffset());
      if (playing) raf = requestAnimationFrame(step);
    };
    step();
  };

  const playButton = h(
    'button',
    {
      type: 'button',
      class: 'play-button',
      'aria-label': 'Play (space)',
      onclick: () => setPlaying(!playing),
    },
    icon('play', 16),
  );

  /** Fit the recorded viewport into the stage, like a video. */
  let viewport = { width: 1280, height: 800 };
  const fit = () => {
    const wrapper = frame.querySelector<HTMLElement>('.replayer-wrapper');
    if (!wrapper) return;
    const full = document.fullscreenElement === playerPanel;
    const available = stage.clientWidth;
    const maxHeight = full ? window.innerHeight - 140 : Math.min(window.innerHeight * 0.62, 640);
    const scale = Math.min(available / viewport.width, maxHeight / viewport.height, 1);
    wrapper.style.transform = `scale(${scale})`;
    wrapper.style.transformOrigin = 'top left';
    frame.style.width = `${viewport.width * scale}px`;
    frame.style.height = `${viewport.height * scale}px`;
    (urlBar.querySelector('.replay-viewport') as HTMLElement).textContent =
      `${viewport.width}×${viewport.height}${scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}`;
  };
  const resizeObserver = new ResizeObserver(() => fit());

  const openSnapshot = async () => {
    const t = Math.round(transcriptTime());
    const body = h('div', {}, loading('Reading the screen'));
    modal({
      title: `What an agent sees at ${clock(t)}`,
      width: 720,
      body,
      actions: copyButton(() => body.textContent ?? '', 'Copy'),
    });
    try {
      const r = await api.get<{ url: string; viewport: string; screen: string; summary: string }>(
        `/api/replays/${encodeURIComponent(session)}/snapshot`,
        { project, at: String(t / 1000) },
      );
      mount(
        body,
        h('p', { class: 'muted' }, r.summary),
        h('pre', { class: 'transcript snapshot-text' }, r.screen),
      );
    } catch (err) {
      mount(body, errorState(err));
    }
  };

  const linkAtNow = () =>
    `${location.origin}${location.pathname}${href(`replays/${session}`, { t: String(Math.round(transcriptTime())) })}`;
  const agentPrompt = () =>
    `Using the Dataflare MCP tools, read session ${session} with summarise_replay, then use replay_snapshot at ${clock(transcriptTime())} to see what was on screen. Tell me what went wrong and where in the code to fix it.`;

  const loadSummary = async () => {
    summary = await api.get<SummaryResponse>(
      `/api/replays/${encodeURIComponent(session)}/summary`,
      { project, format: 'json', detail: 'full' },
    );
    return summary;
  };

  void (async () => {
    try {
      const [events, s] = await Promise.all([
        api
          .get<{ events: eventWithTime[] }>(`/api/replays/${encodeURIComponent(session)}/events`, {
            project,
          })
          .then((r) => r.events),
        loadSummary(),
      ]);
      if (disposed) return;
      paintHeader(s);
      buildActivity();
      if (events.length < 2) {
        mount(controls, empty('This recording has no playable events yet.'));
        return;
      }
      await whenConnected(stage);
      if (disposed) return;
      replayer = new Replayer(events, {
        root: frame,
        skipInactive: true,
        showWarning: false,
        mouseTail: { strokeStyle: 'rgba(42,122,103,0.6)', lineWidth: 2, duration: 500 },
      });
      const meta = replayer.getMetaData();
      for (const e of events as {
        type: number;
        timestamp: number;
        data?: { href?: string; tag?: string; payload?: { href?: string } };
      }[]) {
        const url =
          e.type === 4
            ? e.data?.href
            : e.type === 5 && e.data?.tag === 'glass:url'
              ? e.data.payload?.href
              : undefined;
        if (url) urlMarks.push({ ts: e.timestamp, href: url });
      }
      urlMarks.sort((a, b) => a.ts - b.ts);
      recordingStart = meta.startTime;
      total = meta.totalTime;
      const firstMeta = events.find((e) => e.type === 4) as
        | { data?: { width?: number; height?: number } }
        | undefined;
      if (firstMeta?.data?.width)
        viewport = { width: firstMeta.data.width, height: firstMeta.data.height ?? 800 };
      replayer.on('resize', (d) => {
        const dim = d as { width: number; height: number };
        viewport = { width: dim.width, height: dim.height };
        fit();
      });
      replayer.on('finish', () => {
        playing = false;
        playButton.replaceChildren(icon('play', 16));
        updatePosition(total);
      });
      replayer.on('skip-start', () => {
        overlay.hidden = false;
        mount(overlay, icon('clock', 16), 'Skipping inactivity');
      });
      replayer.on('skip-end', () => (overlay.hidden = true));
      resizeObserver.observe(stage);
      fit();
      buildControls();
      const start =
        Number.isFinite(deepLink) && deepLink > 0 ? toOffset(s.startedAt + deepLink) : 0;
      replayer.pause(start);
      updatePosition(start);
      if (start > 0) toast(`Opened at ${clock(deepLink)}`);
    } catch (err) {
      mount(controls, errorState(err));
      mount(activity, errorState(err));
    }
  })();

  function paintHeader(s: SummaryResponse): void {
    const nav = recallList();
    const i = nav?.sessions.indexOf(session) ?? -1;
    const prev = i > 0 ? nav!.sessions[i - 1] : null;
    const next = i >= 0 && i < nav!.sessions.length - 1 ? nav!.sessions[i + 1] : null;
    mount(
      header,
      h(
        'div',
        { class: 'page-head replay-head' },
        h(
          'div',
          { class: 'page-title' },
          h(
            'a',
            { class: 'back-link', href: `#/replays${nav?.query ? `?${nav.query}` : ''}` },
            '← Replays',
          ),
          h('h1', {}, 'Session replay'),
          h(
            'p',
            { class: 'muted replay-meta' },
            h(
              'a',
              { href: href(`users/${encodeURIComponent(s.person)}`) },
              icon('user', 13),
              s.person,
            ),
            h('span', {}, icon('calendar', 13), dateTime(s.started)),
            s.device
              ? h(
                  'span',
                  {},
                  icon(s.device.startsWith('mobile') ? 'smartphone' : 'monitor', 13),
                  s.device,
                )
              : null,
            h('span', { class: 'mono', title: 'Session id' }, session.slice(0, 13)),
          ),
        ),
        h(
          'div',
          { class: 'page-actions' },
          prev
            ? h(
                'a',
                {
                  class: 'button ghost small',
                  href: href(`replays/${prev}`),
                  title: 'Previous session in the list',
                },
                '‹ Prev',
              )
            : null,
          next
            ? h(
                'a',
                {
                  class: 'button ghost small',
                  href: href(`replays/${next}`),
                  title: 'Next session in the list',
                },
                'Next ›',
              )
            : null,
          copyButton(linkAtNow, 'Link at this time', 'link'),
          copyButton(agentPrompt, 'Ask an agent', 'bot'),
        ),
      ),
    );
    const st = s.stats;
    const stat = (label: string, value: string, kind = '') =>
      h(
        'div',
        { class: `replay-stat ${kind}` },
        h('span', { class: 'muted' }, label),
        h('strong', {}, value),
      );
    mount(
      statsRow,
      stat('Length', `${duration(st.durationSeconds)}`),
      stat('Active', duration(st.activeSeconds)),
      stat('Pages', String(st.pages)),
      stat('Clicks', String(st.clicks)),
      stat('Rage clicks', String(st.rageClicks), st.rageClicks ? 'warn' : ''),
      stat('Dead clicks', String(st.deadClicks), st.deadClicks ? 'warn' : ''),
      stat('Errors', String(st.errors), st.errors ? 'bad' : ''),
      stat('Console errors', String(st.consoleErrors), st.consoleErrors ? 'bad' : ''),
      stat('Failed requests', String(st.failedRequests), st.failedRequests ? 'bad' : ''),
    );
  }

  function buildControls(): void {
    const time = h('span', { class: 'player-time' }, `00:00 / ${clock(total)}`);
    const progress = h('div', { class: 'scrub-progress' });
    const hoverTip = h('div', { class: 'scrub-tip', hidden: true });
    const markers = h('div', { class: 'scrub-markers' });
    const track = h('div', { class: 'scrub-track' }, progress, markers);
    const scrubber = h(
      'div',
      {
        class: 'scrubber',
        role: 'slider',
        tabindex: 0,
        'aria-label': 'Seek',
        'aria-valuemin': 0,
        'aria-valuemax': Math.round(total / 1000),
      },
      track,
      hoverTip,
    );

    paintMarkers = () => {
      if (!summary) return;
      mount(
        markers,
        summary.timeline.map((item) => {
          const kind = markerClass(item);
          if (!kind) return null;
          const at = toOffset(item.ts);
          return h('button', {
            type: 'button',
            class: `marker ${kind}`,
            style: `left:${(at / Math.max(total, 1)) * 100}%`,
            title: `${clock(item.t)} ${item.text}`,
            'aria-label': `${clock(item.t)} ${item.text}`,
            onclick: (e: Event) => {
              e.stopPropagation();
              seek(at - 300);
            },
          });
        }),
      );
    };
    paintMarkers();

    const offsetAt = (clientX: number) => {
      const r = track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total;
    };
    let dragging = false;
    scrubber.addEventListener('pointerdown', (e) => {
      dragging = true;
      scrubber.setPointerCapture(e.pointerId);
      seek(offsetAt(e.clientX));
    });
    scrubber.addEventListener('pointermove', (e) => {
      const at = offsetAt(e.clientX);
      hoverTip.hidden = false;
      hoverTip.textContent = clock(at + recordingStart - (summary?.startedAt ?? recordingStart));
      hoverTip.style.left = `${(at / Math.max(total, 1)) * 100}%`;
      if (dragging) seek(at);
    });
    scrubber.addEventListener('pointerup', () => (dragging = false));
    scrubber.addEventListener('pointerleave', () => (hoverTip.hidden = true));
    scrubber.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        seek(currentOffset() + (e.key === 'ArrowRight' ? 5000 : -5000));
      }
    });

    let lastCurrent = -1;
    updatePosition = (offset: number) => {
      const shown = offset + recordingStart - (summary?.startedAt ?? recordingStart);
      time.textContent = `${clock(shown)} / ${clock(total + recordingStart - (summary?.startedAt ?? recordingStart))}`;
      progress.style.width = `${(offset / Math.max(total, 1)) * 100}%`;
      scrubber.setAttribute('aria-valuenow', String(Math.round(offset / 1000)));
      // Highlight the latest activity at or before now.
      const rows = activity.querySelectorAll<HTMLElement>('.activity-item');
      let current: HTMLElement | null = null;
      const now = recordingStart + offset;
      for (const row of rows) {
        if (Number(row.dataset.ts) <= now + 50) current = row;
        else break;
      }
      const index = current ? Number(current.dataset.index) : -1;
      if (index !== lastCurrent) {
        activity.querySelector('.activity-item.current')?.classList.remove('current');
        current?.classList.add('current');
        if (current && follow && playing) current.scrollIntoView({ block: 'nearest' });
        lastCurrent = index;
      }
      // The recording's own URL marks (page loads and client-side navigation), else Dataflare pageviews.
      const mark =
        urlMarks.filter((m) => m.ts <= now + 50).at(-1)?.href ??
        summary?.timeline.filter((i) => i.kind === 'page' && i.ts <= now + 50).at(-1)?.url ??
        '';
      const urlText = urlBar.querySelector('.replay-url-text')!;
      if (urlText.textContent !== (mark || '—')) urlText.textContent = mark || '—';
    };

    let speed = '1';
    const speedMenu = () =>
      selectMenu({
        value: speed,
        label: 'Playback speed',
        options: ['0.5', '1', '2', '4', '8'].map((v) => ({ value: v, label: `${v}×` })),
        onChange: (v) => {
          speed = v;
          replayer?.setConfig({ speed: Number(v) });
          speedSlot.replaceChildren(speedMenu());
        },
        class: 'speed-menu',
      });
    const speedSlot = h('span', {}, speedMenu());
    const skip = toggle({
      checked: true,
      label: 'Skip inactivity',
      onChange: (on) => replayer?.setConfig({ skipInactive: on }),
    });
    const fullscreen = iconButton('panel', 'Fullscreen (f)', () => toggleFullscreen());
    const agentView = iconButton('bot', 'Agent view', () => void openSnapshot(), { text: true });
    mount(
      controls,
      scrubber,
      h(
        'div',
        { class: 'player-bar' },
        playButton,
        h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            title: 'Back 5 seconds (←)',
            onclick: () => seek(currentOffset() - 5000),
          },
          '−5s',
        ),
        time,
        h('span', { class: 'spacer' }),
        agentView,
        skip,
        speedSlot,
        fullscreen,
      ),
    );
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void playerPanel.requestFullscreen?.();
  };
  document.addEventListener('fullscreenchange', fit);

  function buildActivity(): void {
    const searchBox = h('input', {
      type: 'search',
      placeholder: 'Filter activity',
      'aria-label': 'Filter activity',
    });
    searchBox.addEventListener('input', () => {
      needle = searchBox.value.toLowerCase();
      renderActivity();
    });
    const listEl = h('ol', { class: 'activity-list' });
    listEl.addEventListener('wheel', () => (follow = false), { passive: true });
    const followButton = h(
      'button',
      {
        type: 'button',
        class: 'ghost small follow',
        hidden: true,
        onclick: () => {
          follow = true;
          followButton.hidden = true;
        },
      },
      'Follow playback',
    );
    listEl.addEventListener('scroll', () => (followButton.hidden = follow || !playing));
    const filterBar = h('div', { class: 'activity-filters' });
    const transcriptView = h('pre', { class: 'transcript', hidden: true });
    let view: 'activity' | 'transcript' = 'activity';
    const viewTabs = h('div', { class: 'activity-views' });
    const paintTabs = () =>
      mount(
        viewTabs,
        (['activity', 'transcript'] as const).map((v) =>
          h(
            'button',
            {
              type: 'button',
              class: `tab ${view === v ? 'active' : ''}`,
              onclick: () => {
                view = v;
                listEl.hidden = filterBar.hidden = searchBox.hidden = v !== 'activity';
                transcriptView.hidden = v !== 'transcript';
                paintTabs();
              },
            },
            v === 'activity' ? 'Activity' : 'Agent transcript',
          ),
        ),
        h('span', { class: 'spacer' }),
        copyButton(() => summary?.transcript ?? '', 'Copy transcript'),
      );
    paintTabs();

    renderActivity = () => {
      if (!summary) return;
      transcriptView.textContent = summary.transcript;
      const counts = new Map(
        FILTERS.map((f) => [f.value, summary!.timeline.filter(f.match).length]),
      );
      mount(
        filterBar,
        FILTERS.filter((f) => f.value === 'all' || counts.get(f.value)).map((f) =>
          h(
            'button',
            {
              type: 'button',
              class: `signal-chip small ${filter === f.value ? 'on' : ''} ${f.value === 'problems' ? 'problems' : ''}`,
              onclick: () => {
                filter = f.value;
                renderActivity();
              },
            },
            f.label,
            h('span', { class: 'count' }, String(counts.get(f.value))),
          ),
        ),
      );
      const match = FILTERS.find((f) => f.value === filter)!.match;
      const items = summary.timeline
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item }) =>
            match(item) &&
            (!needle ||
              `${item.text} ${item.selector ?? ''} ${item.detail ?? ''}`
                .toLowerCase()
                .includes(needle)),
        );
      mount(
        listEl,
        items.length
          ? items.map(({ item, index }) => activityRow(item, index))
          : h(
              'li',
              { class: 'muted activity-empty' },
              needle ? 'Nothing matches.' : 'Nothing of this kind in the session.',
            ),
      );
      updatePosition(currentOffset());
    };

    const noteInput = h('input', {
      type: 'text',
      placeholder: 'Add a note at the current time…',
      'aria-label': 'Note',
      maxlength: 2000,
    });
    const addNote = async () => {
      const text = noteInput.value.trim();
      if (!text) return;
      try {
        await api.post(
          `/api/replays/${encodeURIComponent(session)}/notes`,
          { at: Math.round(transcriptTime()), text, author: 'dashboard' },
          { project },
        );
        noteInput.value = '';
        await loadSummary();
        renderActivity();
        paintMarkers();
        toast('Note added');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not add the note', 'error');
      }
    };
    noteInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void addNote();
    });

    mount(
      activity,
      viewTabs,
      h(
        'div',
        { class: 'activity-tools' },
        h('label', { class: 'search-field' }, icon('search', 14), searchBox),
      ),
      filterBar,
      listEl,
      followButton,
      transcriptView,
      h(
        'div',
        { class: 'note-form' },
        icon('bot', 14),
        noteInput,
        h('button', { type: 'button', class: 'ghost small', onclick: () => void addNote() }, 'Add'),
      ),
    );
    renderActivity();
  }

  function activityRow(item: TimelineItem, index: number): HTMLElement {
    const level =
      item.kind === 'note'
        ? 'note'
        : item.level === 'error' || item.signals?.includes('error')
          ? 'error'
          : item.level === 'warn' || item.signals?.length
            ? 'warn'
            : '';
    const badges = (item.signals ?? []).map((sig) =>
      h(
        'span',
        { class: `badge ${sig === 'error' ? 'bad' : 'warn'}` },
        sig === 'rage' ? 'rage' : sig === 'dead' ? 'dead' : 'error after',
      ),
    );
    const expandable = Boolean(
      item.detail && (item.kind === 'error' || item.kind === 'console' || item.kind === 'network'),
    );
    const body = h(
      'div',
      { class: 'activity-body' },
      h(
        'div',
        { class: 'activity-text' },
        item.text.replace(/^(ERROR |Console (error|warn|log|info|debug): |Note \([^)]*\): )/, ''),
        badges,
      ),
      item.selector
        ? h(
            'code',
            { class: 'activity-selector', title: 'Selector: search your code for it' },
            item.selector,
          )
        : null,
      item.kind === 'note' && item.author
        ? h('span', { class: 'muted activity-author' }, `by ${item.author}`)
        : null,
      expandable ? h('pre', { class: 'activity-detail', hidden: true }, item.detail) : null,
    );
    const row = h(
      'li',
      {
        class: `activity-item kind-${item.kind} ${level}`,
        'data-ts': item.ts,
        'data-index': index,
      },
      h(
        'button',
        {
          type: 'button',
          class: 'activity-time',
          title: 'Play from here',
          onclick: () => seek(toOffset(item.ts) - 300),
        },
        clock(item.t),
      ),
      h('span', { class: 'activity-icon' }, icon(KIND_ICON[item.kind], 13)),
      body,
      item.kind === 'note' && item.id
        ? iconButton('trash', 'Delete note', async () => {
            try {
              await api.delete(
                `/api/replays/${encodeURIComponent(session)}/notes/${encodeURIComponent(item.id!)}`,
                { project },
              );
              await loadSummary();
              renderActivity();
              paintMarkers();
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not delete the note', 'error');
            }
          })
        : null,
    );
    body.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('code, pre')) return;
      const pre = body.querySelector<HTMLElement>('.activity-detail');
      if (pre) pre.hidden = !pre.hidden;
      seek(toOffset(item.ts) - 300);
    });
    return row;
  }

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      target.isContentEditable ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      !replayer
    )
      return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'ArrowRight' || e.key === 'l') {
      e.preventDefault();
      seek(currentOffset() + 5000);
    } else if (e.key === 'ArrowLeft' || e.key === 'j') {
      e.preventDefault();
      seek(currentOffset() - 5000);
    } else if (e.key === 'f') {
      toggleFullscreen();
    } else if (e.key === 'a') {
      void openSnapshot();
    }
  };
  document.addEventListener('keydown', onKey);

  // Tear down the player when the user navigates away.
  const cleanup = () => {
    window.removeEventListener('hashchange', cleanup);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', fit);
    resizeObserver.disconnect();
    disposed = true;
    cancelAnimationFrame(raf);
    try {
      replayer?.pause();
      replayer?.destroy();
    } catch {
      // ignore
    }
    replayer = null;
  };
  window.addEventListener('hashchange', cleanup, { once: true });

  return [
    header,
    statsRow,
    h(
      'div',
      { class: 'replay-layout' },
      playerPanel,
      h('section', { class: 'panel activity-panel' }, activity),
    ),
    h(
      'p',
      { class: 'muted shortcuts' },
      'Shortcuts: space play/pause · ←/→ 5 seconds · f fullscreen · a what an agent sees',
    ),
  ];
}

export function replaysPage(route: Route): Node[] {
  const sub = route.rest[0];
  if (sub === 'patterns') return patterns();
  return sub ? detail(sub, route) : list(route);
}
