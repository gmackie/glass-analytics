/**
 * Data pipelines: destinations (forward events as they arrive), transformations
 * (rules applied at ingest) and batch exports (hourly or daily files or rows).
 */

import type { WireEvent } from '@dataflare/core/events';
import {
  csvRecord,
  type ImportPreset,
  mapRecord,
  parseCsvLine,
} from '@dataflare/core/import-presets';
import { api } from '../api.ts';
import { lineChart } from '../components/charts.ts';
import { cleanFilters, type FilterRow, filterEditor } from '../components/filter-editor.ts';
import { icon } from '../components/icons.ts';
import { jsonEditor } from '../components/json-editor.ts';
import { toggle } from '../components/menu.ts';
import { isChannel } from '../components/notification-channels.ts';
import { eventPicker } from '../components/picker.ts';
import {
  cleanTransformationRule,
  eventListEditor,
  transformationRuleEditor,
} from '../components/rich-editors.ts';
import {
  empty,
  errorState,
  later,
  loading,
  pageHeader,
  panel,
  stageBanner,
  table,
  tabs,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, count, dateTime } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

type Tab = 'destinations' | 'transformations' | 'exports' | 'imports';

interface TemplateInput {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'boolean' | 'json' | 'select';
  required?: boolean;
  description?: string;
  default?: unknown;
  options?: string[];
}
interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  inputs: TemplateInput[];
  defaultEvents?: string[];
}
interface Destination {
  id: string;
  name: string;
  template: string;
  enabled: boolean;
  match: { events?: string[]; filters?: unknown[] };
  config: Record<string, unknown>;
  secretsSet: string[];
}

/** A <label> wraps one input (clicking the text focuses it); composite editors get a <div>. */
const labelable = (control: unknown) =>
  control instanceof HTMLInputElement ||
  control instanceof HTMLSelectElement ||
  control instanceof HTMLTextAreaElement;

const field = (label: string, control: HTMLElement, hint?: string) =>
  h(
    labelable(control) ? 'label' : 'div',
    { class: 'field' },
    h('span', {}, label),
    control,
    hint ? h('small', { class: 'muted' }, hint) : null,
  );

// ── Destinations ───────────────────────────────────────────────────────────

/** A destination setting's control, and how to read its value back (undefined: leave unset). */
interface InputControl {
  el: HTMLElement;
  read: () => unknown;
}

/** JSON settings get the JSON editor: highlighted, checked as you type. */
function jsonInput(i: TemplateInput, current: unknown): InputControl {
  const editor = jsonEditor({ value: current, label: i.label, emptyText: 'Empty: not set' });
  return {
    el: editor.el,
    read: () => {
      const st = editor.state();
      if (!st.ok) {
        editor.focus();
        throw new Error(`${i.label}: ${st.message}`);
      }
      return st.empty ? undefined : st.value;
    },
  };
}

function textInput(i: TemplateInput, current: unknown, existing: Destination | null): InputControl {
  const secret = i.type === 'secret';
  const isSet = secret && Boolean(existing?.secretsSet.includes(i.key));
  const el = h('input', {
    type: secret ? 'password' : 'text',
    value: secret || current === undefined ? '' : String(current),
    placeholder: isSet ? '•••••• (set; leave empty to keep)' : '',
    required: Boolean(i.required) && !isSet,
    autocomplete: 'off',
  });
  return { el, read: () => (el.value === '' ? undefined : el.value) };
}

function inputControl(i: TemplateInput, existing: Destination | null): InputControl {
  const current = existing?.config[i.key] ?? i.default;
  if (i.type === 'boolean') {
    const el = h('input', { type: 'checkbox', checked: current === true });
    return { el, read: () => el.checked };
  }
  if (i.type === 'select') {
    const el = h(
      'select',
      {},
      (i.options ?? []).map((o) => h('option', { value: o, selected: o === current }, o)),
    );
    return { el, read: () => (el.value === '' ? undefined : el.value) };
  }
  if (i.type === 'json') return jsonInput(i, current);
  return textInput(i, current, existing);
}

function templateSelect(
  templates: Template[],
  t: Template,
  onPick: (id: string) => void,
): HTMLElement {
  const sel = h(
    'select',
    {},
    templates.map((x) => h('option', { value: x.id, selected: x.id === t.id }, x.name)),
  );
  sel.addEventListener('change', () => onPick(sel.value));
  return field('Destination', sel, t.description);
}

async function saveDestination(
  existing: Destination | null,
  body: Record<string, unknown>,
): Promise<void> {
  const r = existing
    ? await api.put<{ destination: Destination }>(`/api/destinations/${existing.id}`, body)
    : await api.post<{ destination: Destination }>('/api/destinations', body);
  toast(existing ? 'Destination saved' : 'Destination created: send a test event to check it');
  go(`pipelines/destinations/${r.destination.id}`);
}

function destinationFields(
  t: Template,
  existing: Destination | null,
  project: string | undefined,
): { fields: HTMLElement[]; body: () => Record<string, unknown> } {
  const name = h('input', { type: 'text', value: existing?.name ?? t.name, required: true });
  const eventList = [...(existing?.match.events ?? t.defaultEvents ?? [])];
  if (eventList.length === 0) eventList.push('');
  const filterRows = structuredClone((existing?.match.filters ?? []) as FilterRow[]);
  const controls = t.inputs.map((i) => ({ i, c: inputControl(i, existing) }));
  const fields = [
    field('Name', name),
    field(
      'Events to send',
      eventListEditor(eventList, project, { allLabel: 'All events (except bookkeeping)' }),
    ),
    field(
      'Only events matching (optional)',
      filterEditor(filterRows, () => {}, { project }),
      'e.g. paid plans only.',
    ),
    ...controls.map(({ i, c }) =>
      field(`${i.label}${i.required ? '' : ' (optional)'}`, c.el, i.description),
    ),
  ];
  const body = () => {
    const inputs: Record<string, unknown> = {};
    for (const { i, c } of controls) {
      const v = c.read();
      if (v !== undefined) inputs[i.key] = v;
    }
    return {
      project,
      name: name.value,
      template: t.id,
      events: eventList.filter(Boolean),
      filters: cleanFilters(filterRows) ?? [],
      inputs,
    };
  };
  return { fields, body };
}

function destinationForm(
  templates: Template[],
  existing: Destination | null,
  initial: string,
): HTMLElement {
  const project = scope().project;
  const holder = h('div', {});
  const paint = (templateId: string) => {
    const t = templates.find((x) => x.id === templateId) ?? templates[0]!;
    const { fields, body } = destinationFields(t, existing, project);
    const error = h('div', {});
    const form = h(
      'form',
      { class: 'stack' },
      existing ? null : templateSelect(templates, t, paint),
      fields,
      error,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'submit', class: 'primary' }, existing ? 'Save' : 'Create destination'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await saveDestination(existing, body());
      } catch (err) {
        mount(error, errorState(err));
      }
    });
    mount(holder, form);
  };
  paint(existing?.template ?? initial);
  return holder;
}

function destinationDetail(id: string): HTMLElement {
  const project = scope().project;
  return later(async () => {
    const [{ templates }, r] = await Promise.all([
      api.get<{ templates: Template[] }>('/api/destinations/templates'),
      api.get<{
        destination: Destination;
        activity: {
          totals: { delivered: number; failed: number; skipped: number };
          pending: number;
          byHour: { hour: string; delivered: number; failed: number; skipped: number }[];
          failures: {
            id: string;
            event_id: string;
            at: string;
            status: number | null;
            error: string;
          }[];
        };
        summary: string;
      }>(`/api/destinations/${id}`, { project }),
    ]);
    const d = r.destination;
    const out = h('div', {});
    const test = h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          try {
            const res = await api.post<{
              ok: boolean;
              skipped?: boolean;
              error?: string;
              status?: number;
              response?: string;
              summary: string;
            }>(`/api/destinations/${id}/test`, { project });
            mount(
              out,
              h(
                'div',
                { class: `state ${res.ok ? 'ok' : 'error'}` },
                h('p', {}, res.summary),
                res.response ? h('pre', { class: 'code-inline' }, res.response) : null,
              ),
            );
          } catch (err) {
            mount(out, errorState(err));
          }
        },
      },
      icon('play', 14),
      'Send a test event',
    );
    const retry = r.activity.failures.length
      ? h(
          'button',
          {
            type: 'button',
            onclick: async () => {
              const res = await api.post<{ summary: string }>(`/api/destinations/${id}/retry`, {
                project,
              });
              toast(res.summary);
            },
          },
          'Retry failed',
        )
      : null;
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete "${d.name}"?`)) return;
          await api.delete(`/api/destinations/${id}`, { project });
          toast('Destination deleted');
          go('pipelines/destinations');
        },
      },
      'Delete',
    );
    const hours = r.activity.byHour;
    return [
      pageHeader(
        d.name,
        `${templates.find((t) => t.id === d.template)?.name ?? d.template} · ${r.summary}`,
        [test, retry, remove],
      ),
      out,
      hours.length
        ? panel(
            'Deliveries',
            lineChart(
              hours.map((x) => Date.parse(x.hour)),
              [
                { label: 'Delivered', values: hours.map((x) => x.delivered) },
                { label: 'Failed', values: hours.map((x) => x.failed) },
                { label: 'Skipped', values: hours.map((x) => x.skipped) },
              ],
              'hour',
              { type: 'bar', height: 180 },
            ),
            { icon: 'zap', subtitle: `${r.activity.pending} waiting` },
          )
        : null,
      r.activity.failures.length
        ? panel(
            'Recent failures',
            table(
              ['When', 'Event', 'Status', 'Error'],
              r.activity.failures.map((f) => [
                dateTime(f.at),
                h('code', {}, f.event_id),
                f.status ?? '—',
                f.error,
              ]),
            ),
            { icon: 'alert' },
          )
        : null,
      panel('Settings', destinationForm(templates, d, d.template), { icon: 'settings' }),
    ];
  });
}

function destinations(route: Route): Child {
  const project = scope().project;
  const sub = route.rest[1];
  if (sub === 'new') {
    return later(async () => {
      const { templates } = await api.get<{ templates: Template[] }>('/api/destinations/templates');
      return panel(
        'New destination',
        destinationForm(templates, null, route.params.get('template') ?? 'slack'),
        { icon: 'zap' },
      );
    });
  }
  if (sub) return destinationDetail(sub);
  return later(async () => {
    const [{ destinations: all, delivery }, { templates }] = await Promise.all([
      api.get<{ destinations: Destination[]; delivery: 'queue' | 'outbox' }>('/api/destinations', {
        project,
      }),
      api.get<{ templates: Template[] }>('/api/destinations/templates'),
    ]);
    const list = all.filter((d) => !isChannel(d));
    const channels = channelsNote(all.length - list.length);
    const newButton = h(
      'a',
      { class: 'button primary', href: href('pipelines/destinations/new') },
      icon('plus', 15),
      'New destination',
    );
    const gallery = h(
      'div',
      { class: 'template-grid' },
      templates.map((t) =>
        h(
          'a',
          { class: 'template-card', href: href('pipelines/destinations/new', { template: t.id }) },
          h('strong', {}, t.name),
          h('span', { class: 'muted small' }, t.description),
        ),
      ),
    );
    if (!list.length)
      return [
        panel('Pick a destination', gallery, {
          icon: 'zap',
          subtitle:
            'No destinations yet. Forward events as they arrive: chat alerts, ad platforms (with hashed identifiers), CRMs, other analytics tools or your own webhook.',
        }),
        channels,
      ];
    return [
      panel(
        `${list.length} ${list.length === 1 ? 'destination' : 'destinations'}`,
        table(
          ['Destination', 'Type', 'Events', 'On'],
          list.map((d) => [
            h('a', { href: href(`pipelines/destinations/${d.id}`) }, d.name),
            templates.find((t) => t.id === d.template)?.name ?? d.template,
            (d.match.events ?? []).join(', ') || 'default events',
            toggle({
              checked: d.enabled,
              label: h('span', { class: 'visually-hidden' }, `${d.name} on`),
              onChange: async (checked) => {
                await api.put(`/api/destinations/${d.id}`, { project, enabled: checked });
                toast(`${d.name} turned ${checked ? 'on' : 'off'}`);
              },
            }),
          ]),
        ),
        {
          icon: 'zap',
          subtitle:
            delivery === 'queue'
              ? 'Events are delivered within seconds through Cloudflare Queues, with retries.'
              : 'Events are delivered every five minutes, with retries (no queue: run dataflare upgrade to add one).',
          actions: newButton,
        },
      ),
      panel('Add another', gallery, {}),
      channels,
    ];
  });
}

/** Report and alert channels live in Settings; say so when some exist. */
function channelsNote(n: number): Child {
  if (!n) return null;
  return h(
    'p',
    { class: 'muted small' },
    `${count(n)} notification ${n === 1 ? 'channel' : 'channels'} for reports and alerts ${n === 1 ? 'is' : 'are'} in `,
    h('a', { href: href('settings') }, 'Settings'),
    '.',
  );
}

// ── Transformations ────────────────────────────────────────────────────────

/** A rule in a few words, e.g. "Rename planName → plan". */
function describeRule(rule: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
  switch (rule.kind) {
    case 'drop_event':
      return 'Drop the event';
    case 'drop_properties':
      return `Drop ${list(rule.properties)}`;
    case 'rename_property':
      return `Rename ${rule.from} → ${rule.to}`;
    case 'set_property':
      return `Set ${rule.property} = ${JSON.stringify(rule.value)}`;
    case 'hash_properties':
      return `Hash ${list(rule.properties)}`;
    case 'redact':
      return `Redact ${list(rule.patterns) || 'email, phone'}${Array.isArray(rule.custom) && rule.custom.length ? ' and custom patterns' : ''}`;
    default:
      return String(rule.kind);
  }
}

function transformations(): Child {
  const project = scope().project;
  return later(async () => {
    const r = await api.get<{
      transformations: {
        id: string;
        position: number;
        enabled: boolean;
        applied: number;
        rule: { kind: string; name?: string; events?: string[] } & Record<string, unknown>;
      }[];
      summary: string;
    }>('/api/transformations', { project });
    const rule: Record<string, unknown> & { kind: string } = {
      kind: 'redact',
      patterns: ['email', 'phone'],
    };
    let sampleEvent = 'signup';
    const sampleProps = jsonInput(
      { key: 'props', label: 'Sample properties', type: 'json' },
      { note: 'mail ann@example.com', plan: 'pro' },
    );
    const out = h('div', {});
    const run = async (save: boolean) => {
      try {
        const parsed = cleanTransformationRule(rule);
        if (save) {
          await api.post('/api/transformations', {
            project,
            rule: parsed,
            position: (r.transformations.at(-1)?.position ?? 0) + 1,
          });
          toast('Rule added: it applies to events from now on');
          go('pipelines/transformations', { t: String(Date.now()) });
          return;
        }
        const res = await api.post<{ dropped: boolean; after: unknown; summary: string }>(
          '/api/transformations/test',
          {
            project,
            rule: parsed,
            event: {
              event: sampleEvent,
              props: sampleProps.read() ?? {},
            },
          },
        );
        mount(
          out,
          h(
            'div',
            { class: 'state ok' },
            h('p', {}, res.summary),
            res.after
              ? h('pre', { class: 'code-inline' }, JSON.stringify(res.after, null, 2))
              : null,
          ),
        );
      } catch (err) {
        mount(out, errorState(err));
      }
    };
    return [
      r.transformations.length
        ? panel(
            'Rules, in order',
            table(
              ['#', 'Rule', 'Applies to', 'Changed', 'On', ''],
              r.transformations.map((t, i) => [
                String(i + 1),
                t.rule.name
                  ? h(
                      'span',
                      {},
                      h('strong', {}, t.rule.name),
                      h('span', { class: 'muted' }, ` · ${describeRule(t.rule)}`),
                    )
                  : describeRule(t.rule),
                t.rule.events?.join(', ') ?? 'all events',
                count(t.applied),
                toggle({
                  checked: t.enabled,
                  label: h('span', { class: 'visually-hidden' }, 'on'),
                  onChange: async (checked) => {
                    await api.put(`/api/transformations/${t.id}`, {
                      project,
                      enabled: checked,
                      rule: t.rule,
                    });
                    toast(checked ? 'Rule on' : 'Rule off');
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-button',
                    'aria-label': 'Delete rule',
                    onclick: async () => {
                      await api.delete(`/api/transformations/${t.id}`, { project });
                      go('pipelines/transformations', { t: String(Date.now()) });
                    },
                  },
                  icon('trash', 14),
                ),
              ]),
              { numeric: [3] },
            ),
            {
              icon: 'filter',
              subtitle:
                'Applied to every event at ingest, top to bottom, before it is stored or forwarded.',
            },
          )
        : empty(
            'Rules run on every event at ingest, before it is stored or forwarded: keep personal data out, drop noise, fix property names without a deploy.',
            null,
            {
              icon: 'filter',
              title: 'No transformations',
            },
          ),
      panel(
        'Add a rule',
        h(
          'div',
          { class: 'stack' },
          transformationRuleEditor(rule, project),
          field(
            'Try it on a sample event',
            h(
              'div',
              { class: 'stack tight' },
              eventPicker({
                value: sampleEvent,
                project,
                label: 'Sample event',
                onChange: (v) => {
                  sampleEvent = v;
                },
              }),
              sampleProps.el,
            ),
            'The sample’s properties, as JSON.',
          ),
          h(
            'div',
            { class: 'form-actions' },
            h('button', { type: 'button', onclick: () => run(false) }, 'Try it'),
            h('button', { type: 'button', class: 'primary', onclick: () => run(true) }, 'Add rule'),
          ),
          out,
        ),
        { icon: 'plus' },
      ),
    ];
  });
}

// ── Batch exports ──────────────────────────────────────────────────────────

const TARGET_FIELDS: Record<
  string,
  { key: string; label: string; secret?: boolean; placeholder?: string; json?: boolean }[]
> = {
  s3: [
    {
      key: 'endpoint',
      label: 'Endpoint',
      placeholder: 'https://<account>.r2.cloudflarestorage.com',
    },
    { key: 'bucket', label: 'Bucket' },
    { key: 'region', label: 'Region', placeholder: 'auto' },
    { key: 'prefix', label: 'Prefix', placeholder: 'dataflare/' },
    { key: 'accessKeyId', label: 'Access key id', secret: true },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true },
  ],
  bigquery: [
    { key: 'projectId', label: 'Google Cloud project' },
    { key: 'dataset', label: 'Dataset' },
    { key: 'table', label: 'Table', placeholder: 'events' },
    { key: 'serviceAccount', label: 'Service account key (JSON)', secret: true, json: true },
  ],
  http: [
    { key: 'url', label: 'URL', secret: true, placeholder: 'https://etl.example.com/dataflare' },
    {
      key: 'headers',
      label: 'Headers (JSON)',
      secret: true,
      json: true,
      placeholder: '{"Authorization":"Bearer …"}',
    },
  ],
};

interface ExportRow {
  id: string;
  name: string;
  target: string;
  format: string;
  frequency: string;
  enabled: boolean;
  watermark: string;
  running: boolean;
}

interface ExportRun {
  status: string;
  window: { from: string; to: string };
  rows: number;
  files: number;
  error?: string;
  startedAt: string;
}

type TargetField = (typeof TARGET_FIELDS)[string][number];

const options = (values: string[], label: (v: string) => string) =>
  values.map((v) => h('option', { value: v }, label(v)));

const TARGET_LABELS: Record<string, string> = {
  s3: 'S3 or R2 (files)',
  bigquery: 'BigQuery (rows)',
  http: 'HTTP (NDJSON)',
};

/** One target setting: request headers get the JSON editor, the rest are text. */
function targetControl(f: TargetField): InputControl {
  if (f.key === 'headers')
    return jsonInput({ key: f.key, label: f.label, type: 'json' }, undefined);
  const el = f.json
    ? h('textarea', { rows: 3, spellcheck: false, placeholder: f.placeholder ?? '' })
    : h('input', {
        type: f.secret ? 'password' : 'text',
        placeholder: f.placeholder ?? '',
        autocomplete: 'off',
      });
  return { el, read: () => el.value.trim() || undefined };
}

function exportForm(project: string | undefined): HTMLElement {
  const target = h(
    'select',
    {},
    options(['s3', 'bigquery', 'http'], (t) => TARGET_LABELS[t]!),
  );
  const format = h(
    'select',
    {},
    options(['jsonl', 'csv'], (t) => t.toUpperCase()),
  );
  const frequency = h(
    'select',
    {},
    options(['hour', 'day'], (t) => `Every ${t}`),
  );
  const from = h('input', { type: 'text', value: '-7d', placeholder: '-30d' });
  const fields = h('div', { class: 'stack' });
  let controls: { f: TargetField; c: InputControl }[] = [];
  const paint = () => {
    controls = TARGET_FIELDS[target.value]!.map((f) => ({ f, c: targetControl(f) }));
    mount(
      fields,
      controls.map(({ f, c }) => field(f.label, c.el)),
    );
  };
  target.addEventListener('change', paint);
  paint();
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h(
      'div',
      { class: 'grid-3' },
      field('Target', target),
      field('Format', format),
      field('How often', frequency),
    ),
    fields,
    field('Start with events received since', from),
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Create export'),
    ),
  );
  const settings = () => {
    const out: Record<string, unknown> = {};
    for (const { f, c } of controls) {
      const v = c.read();
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/exports', {
        project,
        target: target.value,
        format: format.value,
        frequency: frequency.value,
        settings: settings(),
        from: from.value || undefined,
      });
      toast('Export created: files appear after the first full period');
      go('pipelines/exports', { t: String(Date.now()) });
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

async function showRuns(
  x: ExportRow,
  project: string | undefined,
  into: HTMLElement,
): Promise<void> {
  const res = await api.get<{ runs: ExportRun[] }>(`/api/exports/${x.id}/runs`, { project });
  const list = res.runs.length
    ? table(
        ['Started', 'Window', 'Status', 'Rows', 'Files'],
        res.runs.map((u) => [
          ago(u.startedAt),
          `${dateTime(u.window.from)} → ${dateTime(u.window.to)}`,
          u.error ? `${u.status}: ${u.error}` : u.status,
          count(u.rows),
          String(u.files),
        ]),
        { numeric: [3, 4] },
      )
    : empty('No runs yet.');
  mount(into, panel(`Runs of ${x.name}`, list, { icon: 'clock' }));
}

async function backfill(x: ExportRow, project: string | undefined): Promise<void> {
  const since = prompt('Re-export everything received since (e.g. -30d or 2026-01-01):', '-30d');
  if (!since) return;
  const res = await api.post<{ summary: string }>(`/api/exports/${x.id}/backfill`, {
    project,
    from: since,
  });
  toast(res.summary);
}

function exportRow(x: ExportRow, project: string | undefined, runs: HTMLElement): Child[] {
  return [
    h(
      'button',
      { type: 'button', class: 'link-button', onclick: () => showRuns(x, project, runs) },
      x.name,
    ),
    `${x.target} · ${x.format}`,
    x.frequency,
    `${dateTime(x.watermark)}${x.running ? ' (sending)' : ''}`,
    toggle({
      checked: x.enabled,
      label: h('span', { class: 'visually-hidden' }, 'on'),
      onChange: async (checked) => {
        await api.put(`/api/exports/${x.id}`, { project, enabled: checked });
        toast(checked ? 'Export on' : 'Export paused');
      },
    }),
    h('button', { type: 'button', onclick: () => backfill(x, project) }, 'Backfill'),
  ];
}

function exportList(
  list: ExportRow[],
  project: string | undefined,
  runs: HTMLElement,
): HTMLElement {
  if (!list.length)
    return empty(
      'Send events to your warehouse every hour or day: gzipped JSONL/CSV files in S3 or R2 (Snowflake, Databricks and Spark read these), rows in BigQuery, or NDJSON to your own endpoint.',
      null,
      { icon: 'database', title: 'No exports' },
    );
  return panel(
    'Exports',
    table(
      ['Export', 'Target', 'Every', 'Sent up to', 'On', ''],
      list.map((x) => exportRow(x, project, runs)),
    ),
    {
      icon: 'database',
      subtitle:
        'Each run sends the events received in a closed hour or day; runs pick up where the last one stopped.',
    },
  );
}

function exports(): Child {
  const project = scope().project;
  return later(async () => {
    const r = await api.get<{ exports: ExportRow[]; summary: string }>('/api/exports', { project });
    const runs = h('div', {});
    return [
      exportList(r.exports, project, runs),
      runs,
      panel('New export', exportForm(project), {
        icon: 'plus',
        subtitle: 'Credentials are encrypted and never shown again.',
      }),
    ];
  });
}

// ── Imports ────────────────────────────────────────────────────────────────

const SOURCES: { value: ImportPreset; label: string; hint: string }[] = [
  { value: 'posthog', label: 'PostHog', hint: 'Event export (JSON lines or CSV).' },
  { value: 'mixpanel', label: 'Mixpanel', hint: 'Raw event export (JSON lines).' },
  { value: 'amplitude', label: 'Amplitude', hint: 'Export API files, unzipped (JSON lines).' },
  { value: 'segment', label: 'Segment', hint: 'Track, page and identify messages (JSON lines).' },
  { value: 'ga4', label: 'Google Analytics 4', hint: 'The BigQuery export, as JSON lines.' },
  {
    value: 'raw',
    label: 'Dataflare events',
    hint: 'Events in Dataflare’s own shape: event, ts, distinct_id, props…',
  },
];
const IMPORT_BATCH = 1000;
/** Bigger files go through the CLI, which streams them. */
const MAX_BROWSER_BYTES = 50 * 1024 * 1024;

/** Records from a file: a JSON array, JSON lines, or CSV with a header row. */
function readRecords(
  text: string,
  name: string,
): { records: Record<string, unknown>[]; bad: number } {
  const trimmed = text.trimStart();
  if (name.endsWith('.json') || trimmed.startsWith('[')) {
    const all = JSON.parse(text) as unknown;
    return { records: (Array.isArray(all) ? all : [all]) as Record<string, unknown>[], bad: 0 };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (name.endsWith('.csv')) {
    const header = parseCsvLine(lines[0] ?? '').map((x) => x.trim());
    return {
      records: lines.slice(1).map((l) => csvRecord(header, parseCsvLine(l))),
      bad: 0,
    };
  }
  let bad = 0;
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      bad++;
    }
  }
  return { records, bad };
}

/** Send the events in batches, showing progress; returns what the server kept. */
async function sendImport(
  project: string | undefined,
  events: WireEvent[],
  progress: HTMLElement,
): Promise<{ accepted: number; dropped: number }> {
  let accepted = 0;
  let dropped = 0;
  for (let i = 0; i < events.length; i += IMPORT_BATCH) {
    const r = await api.post<{ accepted: number; dropped: number }>('/api/import', {
      project,
      events: events.slice(i, i + IMPORT_BATCH),
    });
    accepted += r.accepted;
    dropped += r.dropped;
    progress.textContent = `Imported ${count(accepted)} of ${count(events.length)}…`;
  }
  progress.textContent = '';
  toast(`Imported ${count(accepted)} events${dropped ? ` (${count(dropped)} rejected)` : ''}`);
  return { accepted, dropped };
}

function importedNotice(
  { accepted, dropped }: { accepted: number; dropped: number },
  fileName: string,
): HTMLElement {
  const rejected = dropped ? `; ${count(dropped)} were rejected` : '';
  return h(
    'div',
    { class: 'notice good' },
    icon('check', 16),
    h(
      'span',
      {},
      `Imported ${count(accepted)} events from ${fileName}${rejected}. Importing the same file again won’t double count.`,
    ),
  );
}

function importPreview(
  fileName: string,
  events: WireEvent[],
  skipped: number,
  format: string,
): Child[] {
  const skippedNote = skipped
    ? h(
        'span',
        { class: 'muted' },
        `, ${count(skipped)} ${skipped === 1 ? 'record' : 'records'} skipped (no event, time or id the ${format} format could read)`,
      )
    : null;
  const sample = events.length
    ? table(
        ['Time', 'Event', 'Person', 'Page'],
        events
          .slice(0, 5)
          .map((e) => [
            h('span', { class: 'nowrap muted' }, dateTime(Number(e.ts))),
            h('span', { class: 'event-pill' }, e.event),
            h('span', { class: 'cell-clip' }, e.user_id ?? e.distinct_id ?? ''),
            h('span', { class: 'cell-clip' }, e.url ?? ''),
          ]),
      )
    : null;
  return [
    h(
      'p',
      {},
      h('strong', {}, fileName),
      `: ${count(events.length)} event${events.length === 1 ? '' : 's'} to import`,
      skippedNote,
      '.',
    ),
    sample,
    events.length > 5
      ? h('p', { class: 'muted small' }, `The first 5 of ${count(events.length)}.`)
      : null,
  ];
}

function imports(): Child {
  const project = scope().project;
  let preset: ImportPreset = 'posthog';
  let events: WireEvent[] = [];
  let skipped = 0;
  let fileName = '';
  const preview = h('div', { class: 'import-preview' });
  const file = h('input', {
    type: 'file',
    accept: '.ndjson,.jsonl,.json,.csv,application/json,text/csv',
    class: 'visually-hidden',
  });
  const sourceHint = h('small', { class: 'muted' }, SOURCES[0]!.hint);
  const source = h(
    'select',
    { 'aria-label': 'Where the file comes from' },
    SOURCES.map((x) => h('option', { value: x.value, selected: x.value === preset }, x.label)),
  );
  const paintPreview = () => {
    if (!fileName) {
      mount(preview);
      return;
    }
    const button = h(
      'button',
      { type: 'button', class: 'primary', disabled: !events.length },
      icon('arrowUp', 15),
      `Import ${count(events.length)} event${events.length === 1 ? '' : 's'}`,
    );
    const progress = h('p', { class: 'muted small', 'aria-live': 'polite' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const done = await sendImport(project, events, progress);
        mount(preview, importedNotice(done, fileName));
      } catch (err) {
        mount(progress, errorState(err));
        button.disabled = false;
      }
    });
    const format = SOURCES.find((x) => x.value === preset)?.label ?? preset;
    mount(
      preview,
      importPreview(fileName, events, skipped, format),
      h('div', { class: 'form-actions' }, button, progress),
    );
  };
  const load = async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > MAX_BROWSER_BYTES) {
      fileName = '';
      mount(
        preview,
        h(
          'div',
          { class: 'notice' },
          icon('alert', 16),
          h(
            'span',
            {},
            `${f.name} is over 50 MB: import it with the CLI below, which streams the file.`,
          ),
        ),
      );
      return;
    }
    mount(preview, loading('Reading the file', 'table'));
    try {
      const { records, bad } = readRecords(await f.text(), f.name.toLowerCase());
      const mapped = await Promise.all(records.map((r) => mapRecord(preset, r)));
      events = mapped.filter((e): e is WireEvent => e !== null);
      skipped = bad + mapped.length - events.length;
      fileName = f.name;
      paintPreview();
    } catch (err) {
      fileName = '';
      mount(preview, errorState(err));
    }
  };
  file.addEventListener('change', () => void load());
  source.addEventListener('change', () => {
    preset = source.value as ImportPreset;
    sourceHint.textContent = SOURCES.find((x) => x.value === preset)?.hint ?? '';
    if (file.files?.[0]) void load();
  });
  return [
    panel(
      'Import events',
      h(
        'div',
        { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'From'), source, sourceHint),
        h(
          'div',
          { class: 'field' },
          h('span', {}, 'File'),
          h(
            'div',
            { class: 'row' },
            h('label', { class: 'button' }, icon('arrowUp', 14), 'Choose a file', file),
            h('span', { class: 'muted small' }, 'JSON lines, a JSON array or CSV, up to 50 MB.'),
          ),
        ),
        preview,
      ),
      {
        icon: 'inbox',
        subtitle:
          'Events keep their timestamps. Each record gets a stable id, so importing the same file twice doesn’t double count. Nothing is sent to destinations.',
      },
    ),
    panel(
      'From the command line',
      [
        h(
          'p',
          { class: 'muted' },
          'For big files, or to script it. The CLI streams the file in batches:',
        ),
        h(
          'pre',
          { class: 'code-inline' },
          'npx dataflare-cli import export.ndjson --preset posthog   # mixpanel, amplitude, segment, ga4, raw',
        ),
        h('p', { class: 'muted' }, 'Payments from Stripe have their own importer:'),
        h('pre', { class: 'code-inline' }, 'npx dataflare-cli stripe import --api-key rk_live_…'),
      ],
      { icon: 'code' },
    ),
  ];
}

export function pipelinesPage(route: Route): Node[] {
  const tab = (route.rest[0] ?? 'destinations') as Tab;
  return [
    pageHeader(
      'Pipelines',
      'Send events to other tools as they arrive, clean them at ingest, and export them to your warehouse.',
    ),
    ...[stageBanner('alpha', 'pipelines')].filter((n) => n !== null),
    tabs(
      [
        { value: 'destinations', label: 'Destinations', icon: 'zap' },
        { value: 'transformations', label: 'Transformations', icon: 'filter' },
        { value: 'exports', label: 'Exports', icon: 'database' },
        { value: 'imports', label: 'Imports', icon: 'inbox' },
      ],
      tab,
      (v) => go(`pipelines/${v}`),
      'page-tabs',
    ),
    h(
      'div',
      { class: 'tab-body' },
      tab === 'transformations'
        ? transformations()
        : tab === 'exports'
          ? exports()
          : tab === 'imports'
            ? imports()
            : destinations(route),
    ),
  ];
}
