/**
 * Feature flags: list, create and edit.
 */

import type { FlagDefinition } from '@dataflare/core/flags';
import { api } from '../api.ts';
import { lineChart } from '../components/charts.ts';
import { icon } from '../components/icons.ts';
import { knownGroupTypes } from '../components/insight-options.ts';
import { toggle } from '../components/menu.ts';
import { payloadEditors } from '../components/payload-editors.ts';
import { cleanFlagRules, type FlagRuleRow, flagRulesEditor } from '../components/rich-editors.ts';
import {
  copyButton,
  empty,
  errorState,
  later,
  pageHeader,
  panel,
  table,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, dateTime } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

const field = (label: string, ...control: Child[]) =>
  h('label', { class: 'field' }, h('span', {}, label), ...control);

function rolloutField(flag: FlagDefinition | null) {
  const input = h('input', {
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    value: flag?.rollout ?? 100,
  });
  const shown = h('output', {}, `${flag?.rollout ?? 100}%`);
  input.addEventListener('input', () => {
    shown.textContent = `${input.value}%`;
  });
  return {
    el: field('Rollout', h('div', { class: 'range' }, input, shown)),
    value: () => Number(input.value),
  };
}

/** "control:50, test:50" → variants; empty for an on/off flag. */
function parseVariants(text: string): { key: string; weight: number }[] {
  if (!text.trim()) return [];
  return text.split(',').map((part) => {
    const [k, w] = part.trim().split(':');
    return { key: k!.trim(), weight: Number(w ?? 1) };
  });
}

function bucketField(flag: FlagDefinition | null, project: string | undefined) {
  const option = (v: string, label: string) =>
    h('option', { value: v, selected: (flag?.bucketBy ?? 'device') === v }, label);
  const select = h(
    'select',
    {},
    option('device', 'Device (default)'),
    option('person', 'Person (same value on every device)'),
  );
  const addType = (t: string) => {
    if (![...select.options].some((o) => o.value === t)) select.append(option(t, `${t} (group)`));
  };
  for (const t of knownGroupTypes(project, () =>
    knownGroupTypes(project, () => {}).forEach(addType),
  ))
    addType(t);
  if (flag?.bucketBy) addType(flag.bucketBy);
  return {
    el: field('Same value for the same', select),
    value: () => (select.value === 'device' ? null : select.value),
  };
}

function earlyAccessSection(flag: FlagDefinition | null) {
  const ea = flag?.earlyAccess;
  let on = Boolean(ea);
  const text = (value: string | undefined, placeholder: string, type = 'text') =>
    h('input', { type, value: value ?? '', placeholder });
  const name = text(ea?.name, 'New editor');
  const description = text(ea?.description, 'What people get by opting in');
  const docs = text(ea?.docsUrl, 'https://… (optional)', 'url');
  const stage = h(
    'select',
    {},
    ['concept', 'alpha', 'beta'].map((v) =>
      h('option', { value: v, selected: (ea?.stage ?? 'beta') === v }, v),
    ),
  );
  const fields = h(
    'div',
    { class: 'stack tight', hidden: !on },
    field('Name shown to people', name),
    field('Description', description),
    h('div', { class: 'grid-2' }, field('Stage', stage), field('Docs', docs)),
  );
  const el = h(
    'div',
    { class: 'stack tight' },
    toggle({
      checked: on,
      label: 'Early access: people can opt in themselves (glass.earlyAccessFeatures())',
      onChange: (c) => {
        on = c;
        fields.hidden = !c;
      },
    }),
    fields,
  );
  const value = () => {
    if (!on) return null;
    if (!name.value.trim())
      throw new Error('Give the early access feature a name people will see.');
    return {
      name: name.value.trim(),
      stage: stage.value,
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      ...(docs.value.trim() ? { docsUrl: docs.value.trim() } : {}),
    };
  };
  return { el, value };
}

function enabledToggle(checked: boolean) {
  const input = h('input', { type: 'checkbox', checked });
  const el = h(
    'label',
    { class: 'toggle' },
    input,
    h(
      'span',
      { class: 'toggle-track', 'aria-hidden': 'true' },
      h('span', { class: 'toggle-thumb' }),
    ),
    h('span', { class: 'toggle-label' }, 'Enabled'),
  );
  return { el, value: () => input.checked };
}

function editor(flag: FlagDefinition | null): HTMLElement {
  const project = scope().project;
  const key = h('input', {
    type: 'text',
    value: flag?.key ?? '',
    required: true,
    pattern: '[A-Za-z0-9][A-Za-z0-9_.-]*',
    disabled: Boolean(flag),
    placeholder: 'new-checkout',
  });
  const description = h('input', {
    type: 'text',
    value: flag?.description ?? '',
    placeholder: 'What this flag controls',
  });
  const enabled = enabledToggle(flag?.enabled ?? true);
  const rollout = rolloutField(flag);
  const variants = h('input', {
    type: 'text',
    value: (flag?.variants ?? []).map((v) => `${v.key}:${v.weight}`).join(', '),
    placeholder: 'control:50, test:50 (leave empty for on/off)',
  });
  const variantKeys = () =>
    parseVariants(variants.value)
      .map((v) => v.key)
      .filter(Boolean);
  const ruleRows = structuredClone((flag?.rules ?? []) as FlagRuleRow[]);
  const rules = flagRulesEditor(ruleRows, variantKeys, project);
  const valuesNow = () => (variantKeys().length ? variantKeys() : ['on']);
  const payloads = payloadEditors(flag?.payloads, valuesNow());
  variants.addEventListener('input', () => payloads.sync(valuesNow()));
  const bucketBy = bucketField(flag, project);
  const earlyAccess = earlyAccessSection(flag);
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    field('Key', key),
    field('Description', description),
    enabled.el,
    rollout.el,
    field('Variants', variants),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Targeting rules (first match wins; everyone else gets the rollout above)'),
      rules,
      h(
        'small',
        { class: 'muted' },
        'Conditions can use person and event properties, group.<type>.<property>, cohort, and flag.<key> (another flag’s value).',
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Payloads (optional)'),
      h(
        'small',
        { class: 'muted' },
        'JSON per value, read with glass.flagPayload(key): copy, prices, config, or page changes for a web experiment.',
      ),
      payloads.el,
    ),
    bucketBy.el,
    earlyAccess.el,
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, flag ? 'Save changes' : 'Create flag'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const collected = payloads.collect();
      if (!collected.ok) {
        collected.focus();
        throw new Error(collected.message);
      }
      const parsedVariants = parseVariants(variants.value);
      await api.put(`/api/flags/${encodeURIComponent(key.value)}`, {
        project,
        description: description.value || undefined,
        enabled: enabled.value(),
        rollout: rollout.value(),
        variants: parsedVariants.length ? parsedVariants : undefined,
        rules: cleanFlagRules(ruleRows),
        payloads: collected.payloads,
        bucketBy: bucketBy.value(),
        earlyAccess: earlyAccess.value(),
      });
      toast(flag ? 'Flag saved' : 'Flag created');
      go('flags');
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

/** Who has seen the flag, by value (from $exposure events). */
function usagePanel(key: string): HTMLElement {
  return later(async () => {
    const r = await api.get<{
      buckets: number[];
      interval: string;
      series: {
        label: string;
        breakdown: string | null;
        values: number[];
        total: number;
        seriesIndex: number;
      }[];
      summary: string;
    }>(`/api/flags/${encodeURIComponent(key)}/usage`, { project: scope().project, from: '-30d' });
    const people = r.series.filter((x) => x.seriesIndex === 1 && x.total > 0);
    return panel(
      'Exposures',
      people.length
        ? lineChart(
            r.buckets,
            people.map((x) => ({ label: x.breakdown ?? x.label, values: x.values })),
            r.interval,
            { height: 160 },
          )
        : h(
            'p',
            { class: 'muted' },
            `No one has seen it yet. It counts once your code reads glass.flag('${key}').`,
          ),
      {
        icon: 'users',
        subtitle: people.length ? 'People who saw each value, last 30 days' : undefined,
      },
    );
  });
}

function describeChange(c: Record<string, unknown>): string {
  if (c.enabled === true) return 'Turn on';
  if (c.enabled === false) return 'Turn off';
  return c.rollout !== undefined ? `Rollout ${c.rollout}%` : JSON.stringify(c);
}

interface Schedule {
  id: string;
  runAt: string;
  change: Record<string, unknown>;
  status: string;
  error?: string;
}

const reloadFlag = (key: string) =>
  go(`flags/${encodeURIComponent(key)}`, { t: String(Date.now()) });

function scheduleTable(
  schedules: Schedule[],
  key: string,
  project: string | undefined,
): HTMLElement | null {
  if (!schedules.length) return null;
  const cancel = (x: Schedule) =>
    h(
      'button',
      {
        type: 'button',
        class: 'link-button',
        onclick: async () => {
          await api.delete(`/api/flags/schedules/${x.id}`, { project });
          reloadFlag(key);
        },
      },
      'Cancel',
    );
  return table(
    ['When', 'Change', 'Status', ''],
    schedules.map((x) => [
      h('span', { class: 'nowrap' }, dateTime(x.runAt)),
      describeChange(x.change),
      x.error ? `${x.status}: ${x.error}` : x.status,
      x.status === 'pending' ? cancel(x) : '',
    ]),
  );
}

function schedulesPanel(key: string): HTMLElement {
  const project = scope().project;
  return later(async () => {
    const r = await api.get<{
      schedules: {
        id: string;
        runAt: string;
        change: Record<string, unknown>;
        status: string;
        error?: string;
      }[];
    }>('/api/flags/schedules', { project, key });
    const when = h('input', { type: 'datetime-local', required: true });
    const what = h(
      'select',
      {},
      [
        ['enable', 'Turn on'],
        ['disable', 'Turn off'],
        ['rollout', 'Set rollout to…'],
      ].map(([v, label]) => h('option', { value: v }, label)),
    );
    const percent = h('input', {
      type: 'number',
      min: 0,
      max: 100,
      value: 50,
      class: 'short',
      hidden: true,
    });
    what.addEventListener('change', () => {
      percent.hidden = what.value !== 'rollout';
    });
    const error = h('div', {});
    const form = h(
      'form',
      { class: 'row' },
      when,
      what,
      percent,
      h('button', { type: 'submit' }, 'Schedule'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const change =
          what.value === 'rollout'
            ? { rollout: Number(percent.value) }
            : { enabled: what.value === 'enable' };
        await api.post(`/api/flags/${encodeURIComponent(key)}/schedule`, {
          project,
          at: new Date(when.value).toISOString(),
          change,
        });
        toast('Change scheduled');
        go(`flags/${encodeURIComponent(key)}`, { t: String(Date.now()) });
      } catch (err) {
        mount(error, errorState(err));
      }
    });
    return panel('Scheduled changes', [scheduleTable(r.schedules, key, project), form, error], {
      icon: 'clock',
    });
  });
}

function historyPanel(key: string): HTMLElement {
  return later(async () => {
    const r = await api.get<{
      history: { at: string; action: string; actor: string; changed: string[] }[];
    }>(`/api/flags/${encodeURIComponent(key)}/history`, { project: scope().project });
    return panel(
      'History',
      r.history.length
        ? table(
            ['When', 'Change', 'By'],
            r.history
              .slice(0, 20)
              .map((x) => [
                h('span', { class: 'nowrap', title: dateTime(x.at) }, ago(x.at)),
                x.action === 'update' && x.changed.length
                  ? `Changed ${x.changed.join(', ')}`
                  : x.action,
                x.actor || '—',
              ]),
          )
        : h('p', { class: 'muted' }, 'No changes recorded yet.'),
      { icon: 'clock' },
    );
  });
}

export function flagsPage(route: Route): Node[] {
  const project = scope().project;
  const target = route.rest[0];
  if (target === 'new')
    return [pageHeader('New flag', undefined), panel('Definition', editor(null), { icon: 'flag' })];
  if (target) {
    return [
      pageHeader(
        target,
        'Read it in code with glass.flag(key): "on", a variant key, or null.',
        copyButton(`glass.flag('${target}')`, 'Copy code'),
      ),
      later(async () => {
        const { flag } = await api.get<{ flag: FlagDefinition }>(
          `/api/flags/${encodeURIComponent(target)}`,
          { project },
        );
        return h(
          'div',
          { class: 'flag-detail' },
          panel('Definition', editor(flag), { icon: 'flag' }),
          h(
            'div',
            { class: 'flag-side' },
            usagePanel(target),
            schedulesPanel(target),
            historyPanel(target),
          ),
        );
      }),
    ];
  }
  return [
    pageHeader(
      'Flags',
      'Evaluated in your Worker. Assignment is stable per device.',
      h('a', { class: 'button primary', href: href('flags/new') }, icon('plus', 15), 'New flag'),
    ),
    later(
      async () => {
        const { flags } = await api.get<{ flags: FlagDefinition[] }>('/api/flags', { project });
        if (flags.length === 0) {
          return empty(
            'Create one here, or ask your agent to use the save_flag tool.',
            h(
              'a',
              { class: 'button primary', href: href('flags/new') },
              icon('plus', 15),
              'New flag',
            ),
            { icon: 'flag', title: 'No flags yet' },
          );
        }
        const on = flags.filter((f) => f.enabled).length;
        return panel(
          `${flags.length} ${flags.length === 1 ? 'flag' : 'flags'}`,
          table(
            ['Flag', 'Enabled', 'Rollout', 'Variants', 'Targeting'],
            flags.map((f) => [
              h(
                'a',
                { class: 'flag-cell', href: href(`flags/${encodeURIComponent(f.key)}`) },
                h('span', { class: 'flag-key' }, f.key),
                f.description ? h('span', { class: 'muted small' }, f.description) : null,
              ),
              toggle({
                checked: f.enabled,
                label: h('span', { class: 'visually-hidden' }, `${f.key} enabled`),
                title: f.enabled ? 'On: click to turn off' : 'Off: click to turn on',
                onChange: async (checked) => {
                  try {
                    await api.put(`/api/flags/${encodeURIComponent(f.key)}`, {
                      project,
                      description: f.description || undefined,
                      enabled: checked,
                      rollout: f.rollout,
                      variants: f.variants?.length ? f.variants : undefined,
                      rules: f.rules ?? [],
                    });
                    toast(`${f.key} turned ${checked ? 'on' : 'off'}`);
                    go('flags', { t: String(Date.now()) });
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'error');
                    go('flags', { t: String(Date.now()) });
                  }
                },
              }),
              h(
                'div',
                { class: 'rollout' },
                h(
                  'div',
                  { class: 'meter' },
                  h('span', { style: `width:${f.enabled ? f.rollout : 0}%` }),
                ),
                h('span', { class: 'num' }, `${f.rollout}%`),
              ),
              h(
                'span',
                { class: 'chip-list' },
                (f.variants?.length ? f.variants.map((v) => v.key) : ['on', 'off']).map((v) =>
                  h('span', { class: 'value-pill' }, v),
                ),
              ),
              f.rules?.length
                ? h(
                    'span',
                    { class: 'badge' },
                    `${f.rules.length} ${f.rules.length === 1 ? 'rule' : 'rules'}`,
                  )
                : h('span', { class: 'muted' }, 'Everyone'),
            ]),
            { class: 'flags-table' },
          ),
          { icon: 'flag', subtitle: `${on} on, ${flags.length - on} off` },
        );
      },
      'Loading flags',
      'table',
    ),
  ];
}
