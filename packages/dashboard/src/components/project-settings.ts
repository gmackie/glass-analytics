/**
 * Project settings on the Settings page: time zone, internal traffic, currency
 * and revenue events, error tracking and alerts, flag overrides; and the Stripe
 * connection. Everything here is also an agent tool (update_settings,
 * connect_stripe).
 */

import { api } from '../api.ts';
import { type Child, h, mount } from '../dom.ts';
import { scope } from '../state.ts';
import { cleanFilters, type FilterRow, filterEditor } from './filter-editor.ts';
import { toggle } from './menu.ts';
import { completeRevenueRules, type RevenueRule, revenueEventsEditor } from './rich-editors.ts';
import { errorState, later, panel, toast } from './ui.ts';

interface Settings {
  timezone?: string;
  internalFilters?: unknown[];
  baseCurrency?: string;
  revenueEvents?: unknown[];
  inAppIncludes?: string[];
  allowFlagOverrides?: boolean;
  errorRateLimitPerMinute?: number;
  pathCleaning?: { match: string; alias: string }[];
  errorAlerts?: {
    destination: string;
    onNew?: boolean;
    onRegression?: boolean;
    spike?: { count: number; minutes: number };
  };
}

/** A <label> wraps one input (clicking the text focuses it); composite editors get a <div>. */
const labelable = (control: unknown) =>
  control instanceof HTMLInputElement ||
  control instanceof HTMLSelectElement ||
  control instanceof HTMLTextAreaElement;

const field = (label: string, control: HTMLElement, hint?: Child) =>
  h(
    labelable(control) ? 'label' : 'div',
    { class: 'field' },
    h('span', {}, label),
    control,
    hint ? h('small', { class: 'muted' }, hint) : null,
  );

/** A part of the settings form: its fields, and the settings it writes back. */
interface Section {
  fields: Child[];
  read: () => Record<string, unknown>;
}

const input = (attrs: Record<string, unknown>) =>
  h('input', { type: 'text', ...attrs }) as HTMLInputElement;
const numberOrNull = (el: HTMLInputElement) => (el.value ? Number(el.value) : null);
const listOrNull = (text: string) => {
  const list = text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return list.length ? list : null;
};

function reportsSection(settings: Settings, project: string | undefined): Section {
  const zones =
    (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    ) ?? [];
  const timezone = input({ value: settings.timezone ?? '', placeholder: 'UTC', list: 'tz-list' });
  const tzList = h(
    'datalist',
    { id: 'tz-list' },
    zones.map((z) => h('option', { value: z })),
  );
  const internalRows = structuredClone((settings.internalFilters ?? []) as FilterRow[]);
  return {
    fields: [
      h('h3', {}, 'Reports'),
      field(
        'Time zone',
        h('div', {}, timezone, tzList),
        'Day, week and month boundaries in every report (follows daylight saving).',
      ),
      field(
        'Internal traffic',
        filterEditor(internalRows, () => {}, { project }),
        'Events matching any of these are your own or test traffic; "Filter out internal traffic" leaves them out.',
      ),
    ],
    read: () => ({
      timezone: timezone.value.trim() || null,
      internalFilters: cleanFilters(internalRows) ?? null,
    }),
  };
}

function revenueSection(settings: Settings, project: string | undefined): Section {
  const currency = input({
    value: settings.baseCurrency ?? '',
    placeholder: 'USD',
    maxlength: 3,
    class: 'short',
  });
  const rules = structuredClone((settings.revenueEvents ?? []) as RevenueRule[]);
  return {
    fields: [
      h('h3', { id: 'revenue' }, 'Revenue'),
      field(
        'Base currency',
        currency,
        'Revenue is converted to it with the ECB rates of each payment’s day.',
      ),
      field(
        'Revenue events',
        revenueEventsEditor(rules, project),
        'Events that carry money. Amounts are converted to the base currency; a subscription property tracks MRR.',
      ),
    ],
    read: () => {
      const complete = completeRevenueRules(rules);
      return {
        baseCurrency: currency.value.trim().toUpperCase() || null,
        revenueEvents: complete.length ? complete : null,
      };
    },
  };
}

function alertsSection(
  alerts: Settings['errorAlerts'],
  destinations: { id: string; name: string }[],
): Section {
  const dest = h(
    'select',
    {},
    h('option', { value: '' }, 'No alerts'),
    destinations.map((d) =>
      h('option', { value: d.id, selected: d.id === alerts?.destination }, d.name),
    ),
  );
  let onNew = alerts?.onNew !== false;
  let onRegression = alerts?.onRegression !== false;
  const spikeCount = input({
    type: 'number',
    min: 2,
    value: alerts?.spike?.count ?? '',
    placeholder: '50',
    class: 'short',
  });
  const spikeMinutes = input({
    type: 'number',
    min: 1,
    value: alerts?.spike?.minutes ?? '',
    placeholder: '10',
    class: 'short',
  });
  const hint = destinations.length
    ? 'Sent through a destination (Slack, Discord, Teams or a webhook).'
    : 'Add a Slack, Discord, Teams or webhook destination under Pipelines first.';
  const read = () => {
    if (!dest.value) return { errorAlerts: null };
    const spike =
      spikeCount.value && spikeMinutes.value
        ? { count: Number(spikeCount.value), minutes: Number(spikeMinutes.value) }
        : undefined;
    return {
      errorAlerts: { destination: dest.value, onNew, onRegression, ...(spike ? { spike } : {}) },
    };
  };
  return {
    fields: [
      field(
        'Alerts',
        h(
          'div',
          { class: 'stack tight' },
          dest,
          h(
            'div',
            { class: 'row gap-lg' },
            toggle({ checked: onNew, label: 'New issues', onChange: (c) => (onNew = c) }),
            toggle({
              checked: onRegression,
              label: 'Regressions',
              onChange: (c) => (onRegression = c),
            }),
          ),
        ),
        hint,
      ),
      field(
        'Spike alert',
        h(
          'div',
          { class: 'row' },
          spikeCount,
          h('span', {}, 'exceptions within'),
          spikeMinutes,
          h('span', {}, 'minutes'),
        ),
        'Optional; at most one alert per window.',
      ),
    ],
    read,
  };
}

function errorsSection(settings: Settings, destinations: { id: string; name: string }[]): Section {
  const inApp = input({
    value: (settings.inAppIncludes ?? []).join(', '),
    placeholder: '/assets/app-, /static/js/main',
  });
  const rate = input({
    type: 'number',
    min: 1,
    value: settings.errorRateLimitPerMinute ?? '',
    placeholder: '100',
    class: 'short',
  });
  const alerts = alertsSection(settings.errorAlerts, destinations);
  return {
    fields: [
      h('h3', {}, 'Error tracking'),
      field(
        'Your code',
        inApp,
        'Path fragments of your own scripts, so their frames count as in-app (default: files on your site’s host).',
      ),
      field('Exceptions kept per issue per minute', rate),
      ...alerts.fields,
    ],
    read: () => ({
      inAppIncludes: listOrNull(inApp.value),
      errorRateLimitPerMinute: numberOrNull(rate),
      ...alerts.read(),
    }),
  };
}

type Rule = { match: string; alias: string };

function ruleRow(rules: Rule[], i: number, repaint: () => void): HTMLElement {
  const r = rules[i]!;
  const match = input({
    value: r.match,
    placeholder: '/users/*/settings',
    'aria-label': 'Paths matching',
  });
  const alias = input({
    value: r.alias,
    placeholder: '/users/:id/settings',
    'aria-label': 'Shown as',
  });
  match.addEventListener('change', () => (r.match = match.value.trim()));
  alias.addEventListener('change', () => (r.alias = alias.value.trim()));
  const remove = h(
    'button',
    {
      type: 'button',
      class: 'icon-button',
      'aria-label': 'Remove rule',
      onclick: () => {
        rules.splice(i, 1);
        repaint();
      },
    },
    '×',
  );
  return h(
    'div',
    { class: 'row path-rule' },
    match,
    h('span', { class: 'muted' }, '→'),
    alias,
    remove,
  );
}

/** Suggested rules for paths with ids, added below the current ones. */
async function suggestRules(
  project: string | undefined,
  rules: Rule[],
  repaint: () => void,
): Promise<void> {
  try {
    const r = await api.get<{ suggestions: Rule[]; summary: string }>('/api/paths/suggest-rules', {
      project,
    });
    const known = new Set(rules.map((x) => x.match));
    const fresh = r.suggestions.filter((x) => !known.has(x.match));
    rules.push(...fresh.map(({ match, alias }) => ({ match, alias })));
    repaint();
    toast(
      fresh.length
        ? `${fresh.length} rule${fresh.length === 1 ? '' : 's'} added: save to keep them`
        : r.summary,
    );
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function pathsSection(settings: Settings, project: string | undefined): Section {
  const rules: Rule[] = structuredClone(settings.pathCleaning ?? []);
  const list = h('div', { class: 'stack tight' });
  const repaint = () =>
    mount(
      list,
      rules.map((_, i) => ruleRow(rules, i, repaint)),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            type: 'button',
            class: 'link-button add-button',
            onclick: () => {
              rules.push({ match: '', alias: '' });
              repaint();
            },
          },
          'Add a rule',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'link-button',
            onclick: () => void suggestRules(project, rules, repaint),
          },
          'Suggest rules',
        ),
      ),
    );
  repaint();
  return {
    fields: [
      h('h3', {}, 'Paths'),
      field(
        'Path cleaning',
        list,
        'Pages whose paths carry ids show as one step in paths: "/users/*/settings" → "/users/:id/settings".',
      ),
    ],
    read: () => {
      const done = rules.filter((r) => r.match && r.alias);
      return { pathCleaning: done.length ? done : null };
    },
  };
}

function flagsSection(settings: Settings): Section {
  let overrides = Boolean(settings.allowFlagOverrides);
  return {
    fields: [
      h('h3', {}, 'Flags'),
      toggle({
        checked: overrides,
        label: 'Allow ?__glass_flags=key:variant in page URLs to override flags (for QA)',
        onChange: (c) => (overrides = c),
      }),
    ],
    read: () => ({ allowFlagOverrides: overrides }),
  };
}

function settingsForm(
  settings: Settings,
  destinations: { id: string; name: string }[],
): HTMLElement {
  const project = scope().project;
  const sections = [
    reportsSection(settings, project),
    revenueSection(settings, project),
    errorsSection(settings, destinations),
    pathsSection(settings, project),
    flagsSection(settings),
  ];
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    sections.map((x) => x.fields),
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Save settings'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.patch('/api/settings', {
        project,
        settings: Object.assign({}, ...sections.map((x) => x.read())),
      });
      toast('Settings saved');
      mount(error);
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

type StripeStatus = {
  connected: boolean;
  webhookUrl: string;
  events: string[];
  config?: { personKey?: string; groupType?: string; groupKey?: string; linkByEmail?: boolean };
  received?: number;
  lastEventAt?: string | null;
  customers?: { known: number; linked: number };
  summary: string;
};

function stripeSubtitle(status: StripeStatus): string {
  if (!status.connected)
    return 'Not connected. Record payments, refunds and subscriptions (MRR) from Stripe.';
  const last = status.lastEventAt
    ? `, the last ${new Date(status.lastEventAt).toLocaleString()}`
    : '';
  return `Connected · ${status.received ?? 0} webhooks received${last} · ${status.customers?.linked ?? 0} of ${status.customers?.known ?? 0} customers linked to people`;
}

async function disconnectStripe(project: string | undefined): Promise<void> {
  if (!confirm('Disconnect Stripe? Revenue already recorded stays.')) return;
  await api.delete('/api/stripe', { project });
  toast('Stripe disconnected');
  location.reload();
}

/** Only the keys with a value: secrets left empty keep what's stored. */
const nonEmpty = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v));

function stripePanel(status: StripeStatus): HTMLElement {
  const project = scope().project;
  const config = status.config ?? {};
  const secret = h('input', {
    type: 'password',
    placeholder: status.connected ? '•••••• (set; leave empty to keep)' : 'whsec_…',
    autocomplete: 'off',
    required: !status.connected,
  });
  const submit = h(
    'button',
    { type: 'submit', class: 'primary' },
    status.connected ? 'Save' : 'Connect Stripe',
  );
  const disconnect = status.connected
    ? h(
        'button',
        { type: 'button', class: 'danger', onclick: () => disconnectStripe(project) },
        'Disconnect',
      )
    : null;
  const apiKey = h('input', {
    type: 'password',
    placeholder: 'rk_live_… (optional: read access to Customers)',
    autocomplete: 'off',
  });
  const personKey = input({ value: config.personKey ?? '', placeholder: 'dataflare_id' });
  const groupType = input({ value: config.groupType ?? '', placeholder: 'company (optional)' });
  const groupKey = input({
    value: config.groupKey ?? '',
    placeholder: 'metadata key, default the customer id',
  });
  let byEmail = Boolean(config.linkByEmail);
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h('p', {}, 'In Stripe › Developers › Webhooks, add an endpoint:'),
    h('pre', { class: 'code-inline' }, status.webhookUrl),
    h('p', { class: 'muted small' }, `Events to send: ${status.events.join(', ')}.`),
    field('Signing secret', secret),
    field(
      'Restricted key',
      apiKey,
      'Optional: lets Dataflare look up who a customer is when their metadata is missing.',
    ),
    field(
      'Customer metadata key with your user id',
      personKey,
      'What you pass to glass.identify. Without it, revenue goes to stripe:<customer>.',
    ),
    h(
      'div',
      { class: 'grid-2' },
      field('Accounts: group type', groupType),
      field('Accounts: metadata key', groupKey),
    ),
    toggle({
      checked: byEmail,
      label: 'Match customers to people by email (the email is not stored)',
      onChange: (c) => (byEmail = c),
    }),
    error,
    h('div', { class: 'form-actions' }, submit, disconnect),
    h(
      'p',
      { class: 'muted small' },
      'Backfill history: npx @gmacko/dataflare-cli stripe import --api-key rk_…',
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post<{ summary: string }>('/api/stripe', {
        project,
        ...nonEmpty({ webhookSecret: secret.value, apiKey: apiKey.value }),
        personKey: personKey.value || undefined,
        groupType: groupType.value || undefined,
        groupKey: groupKey.value || undefined,
        linkByEmail: byEmail,
      });
      toast(r.summary);
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return panel('Stripe', form, { icon: 'dollar', subtitle: stripeSubtitle(status) });
}

export function projectSettingsPanels(): HTMLElement {
  const project = scope().project;
  return later(async () => {
    const [{ settings }, { destinations }, stripe] = await Promise.all([
      api.get<{ settings: Settings }>('/api/settings', { project }),
      api.get<{ destinations: { id: string; name: string; template: string }[] }>(
        '/api/destinations',
        { project },
      ),
      api.get<StripeStatus>('/api/stripe', { project }),
    ]);
    const chat = destinations.filter((d) =>
      ['slack', 'discord', 'teams', 'webhook', 'zapier', 'make', 'n8n'].includes(d.template),
    );
    return h(
      'div',
      { class: 'grid-2' },
      panel(`Project settings${project ? ` · ${project}` : ''}`, settingsForm(settings, chat), {
        icon: 'settings',
      }),
      stripePanel(stripe),
    );
  });
}
