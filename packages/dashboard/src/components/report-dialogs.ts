/**
 * Scheduled reports and alerts: the dialogs that set them up. Both send to the same channels
 * (Slack, Discord, Teams and webhook destinations, and email when the deployment has it), and
 * list what is already set up with buttons to send or check now.
 */

import { api } from '../api.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago } from '../format.ts';
import { href, scope } from '../state.ts';
import { sparkline } from './charts.ts';
import { icon } from './icons.ts';
import { modal, selectMenu, toggle } from './menu.ts';
import { empty, errorState, later, toast } from './ui.ts';

/** Destination templates that can carry reports and alerts. */
const NOTICE_TEMPLATES = new Set(['slack', 'discord', 'teams', 'webhook', 'zapier', 'make', 'n8n']);

interface Destination {
  id: string;
  name: string;
  template: string;
}

interface Channels {
  destinations?: string[];
  emails?: string[];
}

interface ChannelSources {
  destinations: Destination[];
  email: { enabled: boolean; from: string | null };
}

export async function channelSources(project: string | undefined): Promise<ChannelSources> {
  const [d, caps] = await Promise.all([
    api.get<{ destinations: Destination[] }>('/api/destinations', { project }),
    api.get<{ email: boolean; emailFrom: string | null }>('/api/capabilities', { project }),
  ]);
  return {
    destinations: d.destinations.filter((x) => NOTICE_TEMPLATES.has(x.template)),
    email: { enabled: caps.email, from: caps.emailFrom },
  };
}

/** Checkboxes for each channel, and email addresses when email is set up. */
function channelPicker(
  sources: ChannelSources,
  chosen: Channels,
): { el: HTMLElement; read: () => Channels } {
  const picked = new Set(chosen.destinations ?? []);
  const boxes = sources.destinations.map((d) =>
    toggle({
      checked: picked.has(d.id),
      label: h(
        'span',
        {},
        h('strong', {}, d.name),
        h('span', { class: 'muted small' }, ` ${d.template}`),
      ),
      onChange: (c) => (c ? picked.add(d.id) : picked.delete(d.id)),
    }),
  );
  const emails = h('textarea', {
    rows: 2,
    placeholder: 'ann@acme.com, bob@acme.com',
    'aria-label': 'Email addresses',
  }) as HTMLTextAreaElement;
  emails.value = (chosen.emails ?? []).join(', ');
  const none = sources.destinations.length
    ? null
    : h(
        'p',
        { class: 'muted small' },
        'No Slack, Discord, Teams or webhook channels yet. ',
        h('a', { href: href('settings') }, 'Add one in Settings'),
        '.',
      );
  const mail = sources.email.enabled
    ? h('label', { class: 'field' }, h('span', {}, `Email (from ${sources.email.from})`), emails)
    : h(
        'p',
        { class: 'muted small' },
        'Email needs Cloudflare Email Sending: run ',
        h('code', {}, 'dataflare email enable --from …'),
        '.',
      );
  return {
    el: h('div', { class: 'stack tight channel-picker' }, boxes, none, mail),
    read: () => ({
      destinations: [...picked],
      emails: emails.value
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean),
    }),
  };
}

// ── Schedules ───────────────────────────────────────────────────────────────

type Schedule = {
  frequency: string;
  every?: number;
  time?: string;
  minute?: number;
  weekday?: string;
  monthDay?: number | 'last';
  ordinal?: { nth: number | 'last'; weekday: string };
};

const WEEKDAYS: [string, string][] = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

const PRESETS: Record<string, Schedule> = {
  daily: { frequency: 'daily', time: '09:00' },
  weekly: { frequency: 'weekly', weekday: 'mon', time: '09:00' },
  monthly: { frequency: 'monthly', ordinal: { nth: 1, weekday: 'mon' }, time: '09:00' },
  hourly: { frequency: 'hourly', minute: 0 },
};

function scheduleWords(s: Schedule): string {
  const at = `at ${s.time ?? '09:00'}`;
  if (s.frequency === 'hourly') return `Every hour at :${String(s.minute ?? 0).padStart(2, '0')}`;
  if (s.frequency === 'daily') return `Every day ${at}`;
  const day =
    WEEKDAYS.find(([k]) => k === (s.ordinal?.weekday ?? s.weekday ?? 'mon'))?.[1] ?? 'Monday';
  if (s.frequency === 'weekly') return `Every ${day} ${at}`;
  return s.ordinal
    ? `The first ${day} of each month ${at}`
    : `Monthly on day ${s.monthDay ?? 1} ${at}`;
}

/** Frequency, day and time; `hourly` only where it makes sense (alerts). */
function scheduleEditor(
  initial: Schedule,
  hourly: boolean,
): { el: HTMLElement; read: () => Schedule } {
  let s: Schedule = structuredClone(initial);
  const el = h('div', { class: 'row schedule-editor' });
  const options = [
    ...(hourly ? [{ value: 'hourly', label: 'Every hour' }] : []),
    { value: 'daily', label: 'Every day' },
    { value: 'weekly', label: 'Every week' },
    { value: 'monthly', label: 'Every month' },
  ];
  const time = h('input', {
    type: 'time',
    value: s.time ?? '09:00',
    'aria-label': 'Time',
  }) as HTMLInputElement;
  time.addEventListener('change', () => (s.time = time.value || '09:00'));
  const paint = () =>
    mount(
      el,
      selectMenu({
        value: s.frequency,
        label: 'How often',
        options,
        width: 160,
        onChange: (v) => {
          s = { ...PRESETS[v]!, time: s.time };
          paint();
        },
      }),
      s.frequency === 'weekly' || s.frequency === 'monthly'
        ? selectMenu({
            value: s.ordinal?.weekday ?? s.weekday ?? 'mon',
            label: 'Day',
            options: WEEKDAYS.map(([value, label]) => ({
              value,
              label: s.frequency === 'monthly' ? `First ${label}` : label,
            })),
            width: 170,
            onChange: (v) => {
              if (s.frequency === 'monthly') s.ordinal = { nth: 1, weekday: v };
              else s.weekday = v;
            },
          })
        : null,
      s.frequency === 'hourly' ? h('span', { class: 'muted small' }, 'on the hour') : time,
    );
  paint();
  return { el, read: () => s };
}

// ── Reports ─────────────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  name: string;
  channels: Channels;
  schedule: Schedule;
  tiles: string[];
  message: string;
  lastStatus: string | null;
  lastError: string | null;
  nextRun: string;
  when: string;
}

export interface ReportTarget {
  kind: 'dashboard' | 'insight';
  id: string;
  name: string;
  /** Dashboard tiles that can go in a report: [id, title]. */
  tiles?: [string, string][];
}

async function sendNow(project: string | undefined, id: string): Promise<void> {
  const r = await api.post<{ status: string; error: string | null }>(
    `/api/subscriptions/${id}/send`,
    { project },
  );
  if (r.status === 'sent') toast('Report sent');
  else toast(`Not sent: ${r.error ?? 'unknown error'}`, 'error');
}

function reportRow(project: string | undefined, s: Subscription, reload: () => void): HTMLElement {
  const status =
    s.lastStatus === 'failed'
      ? h('span', { class: 'badge bad', title: s.lastError ?? '' }, 'Last failed')
      : null;
  return h(
    'li',
    { class: 'report-row' },
    h(
      'div',
      {},
      h('strong', {}, s.when),
      status,
      h('div', { class: 'muted small' }, `Next: ${new Date(s.nextRun).toLocaleString()}`),
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { type: 'button', class: 'small', onclick: () => void sendNow(project, s.id) },
        icon('send', 13),
        'Send now',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'small ghost',
          onclick: async () => {
            await api.delete(`/api/subscriptions/${s.id}`, { project });
            toast('Report deleted');
            reload();
          },
        },
        'Delete',
      ),
    ),
  );
}

/** Tiles to include: the first 20 ticked, with a search box when there are many. */
function tilePicker(tiles: [string, string][]): { el: HTMLElement; read: () => string[] } {
  const chosen = new Set(tiles.slice(0, 20).map(([id]) => id));
  const list = h('div', { class: 'tile-checklist' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Search tiles',
    'aria-label': 'Search tiles',
  }) as HTMLInputElement;
  const paint = () =>
    mount(
      list,
      tiles
        .filter(([, title]) => title.toLowerCase().includes(search.value.toLowerCase()))
        .map(([id, title]) =>
          toggle({
            checked: chosen.has(id),
            label: title,
            onChange: (c) => {
              if (c && chosen.size >= 20) return toast('A report holds at most 20 tiles', 'error');
              if (c) chosen.add(id);
              else chosen.delete(id);
            },
          }),
        ),
    );
  search.addEventListener('input', paint);
  paint();
  return {
    el: h('div', { class: 'stack tight' }, tiles.length > 10 ? search : null, list),
    read: () => [...chosen],
  };
}

async function reportForm(
  target: ReportTarget,
  close: () => void,
  reload: () => void,
): Promise<Child> {
  const project = scope().project;
  const sources = await channelSources(project);
  const channels = channelPicker(sources, {});
  const schedule = scheduleEditor(PRESETS.weekly!, false);
  const tiles = target.tiles?.length ? tilePicker(target.tiles) : null;
  const message = h('input', {
    type: 'text',
    placeholder: 'Optional line at the top, e.g. "Monday numbers"',
    'aria-label': 'Message',
  }) as HTMLInputElement;
  const error = h('div', {});
  const save = async (andSend: boolean) => {
    try {
      const r = await api.post<{ id: string; nextRun: string }>('/api/subscriptions', {
        project,
        target: target.kind,
        targetId: target.id,
        channels: channels.read(),
        schedule: schedule.read(),
        ...(tiles ? { tiles: tiles.read() } : {}),
        message: message.value.trim() || undefined,
      });
      toast(
        `Scheduled: ${scheduleWords(schedule.read())}. Next ${new Date(r.nextRun).toLocaleString()}.`,
      );
      if (andSend) await sendNow(project, r.id);
      reload();
      close();
    } catch (err) {
      mount(error, errorState(err));
    }
  };
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'field' }, h('span', {}, 'Send to'), channels.el),
    h('div', { class: 'field' }, h('span', {}, 'When'), schedule.el),
    tiles ? h('div', { class: 'field' }, h('span', {}, 'Tiles'), tiles.el) : null,
    h('label', { class: 'field' }, h('span', {}, 'Message'), message),
    error,
    h(
      'div',
      { class: 'form-actions' },
      h(
        'button',
        { type: 'button', class: 'primary', onclick: () => void save(false) },
        'Schedule report',
      ),
      h('button', { type: 'button', onclick: () => void save(true) }, 'Schedule and send now'),
    ),
  );
}

/** "Subscribe": the reports of a dashboard or analysis, and a form for a new one. */
export function subscribeDialog(target: ReportTarget): void {
  const project = scope().project;
  const existing = h('div', {});
  const loadExisting = () =>
    mount(
      existing,
      later(async () => {
        const q = target.kind === 'dashboard' ? { dashboard: target.id } : { insight: target.id };
        const r = await api.get<{ subscriptions: Subscription[] }>('/api/subscriptions', {
          project,
          ...q,
        });
        if (!r.subscriptions.length) return null;
        return h(
          'div',
          { class: 'stack tight' },
          h('h3', { class: 'section-title' }, 'Scheduled'),
          h(
            'ul',
            { class: 'report-list' },
            r.subscriptions.map((s) => reportRow(project, s, loadExisting)),
          ),
        );
      }),
    );
  loadExisting();
  const form = h('div', {});
  const close = modal({
    title: `Reports of ${target.name}`,
    body: h('div', { class: 'stack' }, existing, form),
    width: 620,
  });
  mount(
    form,
    later(() => reportForm(target, close, loadExisting)),
  );
}

// ── Alerts ──────────────────────────────────────────────────────────────────

interface AlertView {
  id: string;
  name: string;
  state: string;
  lastValue: number | null;
  lastCheckedAt: number | null;
  describe: string;
  when: string;
}

export interface AlertTarget {
  key: string;
  name: string;
  kind: string;
  /** Trends: the series labels (A, B…); funnels: the step labels. */
  parts: string[];
}

const STATE_CLASS: Record<string, string> = {
  firing: 'bad',
  ok: 'good',
  errored: 'warn',
  disabled: '',
};

async function alertHistory(project: string | undefined, id: string): Promise<Child> {
  const r = await api.get<{ history: { at: number; value: number | null; fired: boolean }[] }>(
    `/api/alerts/${id}`,
    { project, days: 30 },
  );
  const values = r.history.map((x) => x.value ?? 0);
  if (values.length < 2)
    return h(
      'span',
      { class: 'muted small' },
      `${r.history.length} check${r.history.length === 1 ? '' : 's'} so far`,
    );
  return h(
    'div',
    { class: 'row' },
    sparkline(values, { height: 28 }),
    h(
      'span',
      { class: 'muted small' },
      `${r.history.filter((x) => x.fired).length} of ${values.length} checks fired`,
    ),
  );
}

function alertRow(project: string | undefined, a: AlertView, reload: () => void): HTMLElement {
  const check = async () => {
    const r = await api.post<{ summary: string }>(`/api/alerts/${a.id}/check`, { project });
    toast(r.summary);
    reload();
  };
  const remove = async () => {
    await api.delete(`/api/alerts/${a.id}`, { project });
    toast('Alert deleted');
    reload();
  };
  return h(
    'li',
    { class: 'report-row' },
    h(
      'div',
      { class: 'stack tight' },
      h(
        'div',
        {},
        h('strong', {}, a.name),
        ' ',
        h('span', { class: `badge ${STATE_CLASS[a.state] ?? ''}` }, a.state),
      ),
      h(
        'span',
        { class: 'muted small' },
        `${a.describe} · ${a.when}${a.lastCheckedAt ? ` · checked ${ago(a.lastCheckedAt)}` : ''}`,
      ),
      later(() => alertHistory(project, a.id)),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'small', onclick: () => void check() }, 'Check now'),
      h('button', { type: 'button', class: 'small ghost', onclick: () => void remove() }, 'Delete'),
    ),
  );
}

type ConditionType = 'above' | 'below' | 'increase' | 'decrease';

/** "When [series A] [is above] [1,000] [%]": the alert's condition as a sentence. */
function conditionEditor(target: AlertTarget) {
  const funnel = target.kind === 'funnel';
  let part = funnel ? target.parts.length : 0;
  let type: ConditionType = funnel ? 'below' : 'above';
  let unit: 'absolute' | 'percent' = 'percent';
  const amount = h('input', {
    type: 'number',
    step: 'any',
    value: funnel ? 10 : 1000,
    class: 'short',
    'aria-label': 'Threshold',
  }) as HTMLInputElement;
  const el = h('div', { class: 'row condition-editor' });
  const paint = () =>
    mount(
      el,
      selectMenu({
        value: String(part),
        label: funnel ? 'Step' : 'Series',
        options: target.parts
          .map((label, i) => ({ value: String(funnel ? i + 1 : i), label }))
          .filter((o) => !funnel || Number(o.value) > 1),
        width: 200,
        onChange: (v) => (part = Number(v)),
      }),
      selectMenu<ConditionType>({
        value: type,
        label: 'Condition',
        options: [
          { value: 'above', label: 'is above' },
          { value: 'below', label: 'is below' },
          ...(funnel
            ? []
            : [
                { value: 'increase' as const, label: 'rises by' },
                { value: 'decrease' as const, label: 'falls by' },
              ]),
        ],
        width: 140,
        onChange: (v) => {
          type = v;
          paint();
        },
      }),
      amount,
      funnel
        ? h('span', {}, '% conversion')
        : type === 'increase' || type === 'decrease'
          ? selectMenu({
              value: unit,
              label: 'Unit',
              options: [
                { value: 'percent', label: '%' },
                { value: 'absolute', label: 'in count' },
              ],
              width: 110,
              onChange: (v) => (unit = v as typeof unit),
            })
          : null,
    );
  paint();
  const read = () => {
    const n = Number(amount.value);
    const value = funnel ? n / 100 : n;
    const condition =
      type === 'above'
        ? { type: 'value', above: value }
        : type === 'below'
          ? { type: 'value', below: value }
          : { type, by: n, unit };
    return { condition, target: funnel ? { step: part } : { series: part } };
  };
  return { el, read };
}

async function alertForm(
  target: AlertTarget,
  close: () => void,
  reload: () => void,
): Promise<Child> {
  const project = scope().project;
  const sources = await channelSources(project);
  const name = h('input', {
    type: 'text',
    value: `${target.name} alert`,
    'aria-label': 'Alert name',
  }) as HTMLInputElement;
  const condition = conditionEditor(target);
  const schedule = scheduleEditor(PRESETS.hourly!, true);
  const channels = channelPicker(sources, {});
  let ongoing = false;
  let skipWeekends = false;
  const quietFrom = h('input', { type: 'time', 'aria-label': 'Quiet from' }) as HTMLInputElement;
  const quietTo = h('input', { type: 'time', 'aria-label': 'Quiet until' }) as HTMLInputElement;
  const error = h('div', {});
  const save = async () => {
    try {
      const quiet =
        quietFrom.value && quietTo.value
          ? [{ from: quietFrom.value, to: quietTo.value }]
          : undefined;
      await api.post('/api/alerts', {
        project,
        name: name.value.trim() || `${target.name} alert`,
        insightKey: target.key,
        ...condition.read(),
        schedule: schedule.read(),
        ongoing,
        skipWeekends,
        ...(quiet ? { quiet } : {}),
        channels: channels.read(),
      });
      toast('Alert saved: it notifies when it starts firing and when it resolves');
      reload();
      close();
    } catch (err) {
      mount(error, errorState(err));
    }
  };
  return h(
    'div',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Name'), name),
    h('div', { class: 'field' }, h('span', {}, 'Alert when'), condition.el),
    h('div', { class: 'field' }, h('span', {}, 'Check'), schedule.el),
    h(
      'div',
      { class: 'row gap-lg' },
      toggle({
        checked: false,
        label: 'Check the period still filling up',
        onChange: (c) => (ongoing = c),
      }),
      toggle({ checked: false, label: 'Skip weekends', onChange: (c) => (skipWeekends = c) }),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Quiet hours (optional)'),
      h('div', { class: 'row' }, quietFrom, h('span', { class: 'muted' }, 'to'), quietTo),
    ),
    h('div', { class: 'field' }, h('span', {}, 'Send to'), channels.el),
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => void save() }, 'Save alert'),
    ),
  );
}

/** The alerts on a saved analysis, and a form for a new one. */
export function alertDialog(target: AlertTarget): void {
  const project = scope().project;
  if (target.kind !== 'trends' && target.kind !== 'funnel') {
    toast('Alerts work on trends and funnels', 'error');
    return;
  }
  const existing = h('div', {});
  const loadExisting = () =>
    mount(
      existing,
      later(async () => {
        const r = await api.get<{ alerts: AlertView[] }>('/api/alerts', {
          project,
          insight: target.key,
        });
        if (!r.alerts.length)
          return empty('No alerts on this analysis yet.', undefined, { icon: 'bell' });
        return h(
          'ul',
          { class: 'report-list' },
          r.alerts.map((a) => alertRow(project, a, loadExisting)),
        );
      }),
    );
  loadExisting();
  const form = h('div', {});
  const close = modal({
    title: `Alerts on ${target.name}`,
    body: h('div', { class: 'stack' }, existing, form),
    width: 640,
  });
  mount(
    form,
    later(() => alertForm(target, close, loadExisting)),
  );
}
