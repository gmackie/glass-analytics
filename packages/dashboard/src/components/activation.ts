import {
  type ActivationInsight,
  type ActivationMapping,
  activationKey,
  activationMapping,
  activationPair,
} from '@dataflare/core/activation';
import type { FunnelResult } from '@dataflare/core/insights/funnel';
import { parseDuration } from '@dataflare/core/time';
import { api } from '../api.ts';
import type { CatalogEvent } from '../catalog.ts';
import { h } from '../dom.ts';
import { count, percent } from '../format.ts';
import { href, scope } from '../state.ts';
import { later, panel, table } from './ui.ts';

function configure(project: string, names: string[], mapping?: ActivationMapping) {
  const picker = (label: string, value?: string) =>
    h(
      'label',
      { class: 'field' },
      label,
      h(
        'select',
        { name: label, required: true },
        h('option', { value: '' }, 'Choose event'),
        names.map((name) => h('option', { value: name, selected: name === value }, name)),
      ),
    );
  const status = h('p', { role: 'status' });
  const form = h(
    'form',
    { class: 'stack' },
    picker('Completed signup', mapping?.steps[0].event),
    picker('First value-producing action', mapping?.steps[1].event),
    h(
      'label',
      { class: 'field' },
      'Conversion window',
      h('input', { name: 'window', value: mapping?.window ?? '7d', required: true }),
    ),
    h('button', { class: 'btn', type: 'submit' }, 'Save mapping'),
    status,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const signup = String(data.get('Completed signup'));
    const action = String(data.get('First value-producing action'));
    if (signup === action) {
      status.textContent = 'Choose two different events.';
      return;
    }
    try {
      const spec = activationPair(signup, action, String(data.get('window')));
      if (parseDuration(spec.window) <= 0) throw new Error('Choose a positive conversion window.');
      await api.post('/api/insights', {
        project,
        key: activationKey,
        name: 'Signup to activation',
        kind: 'funnel',
        spec,
      });
      location.reload();
    } catch (error) {
      status.textContent = String(error);
    }
  };
  return h('details', {}, h('summary', {}, 'Configure activation steps'), form);
}

export function activation(project: string, insights: ActivationInsight[]) {
  const period = scope();
  return later(async () => {
    const catalog = await api.get<{ events: CatalogEvent[] }>('/api/events', {
      project,
      days: 365,
    });
    const names = catalog.events
      .filter((e) => !e.system && e.count > 0)
      .map((e) => e.event)
      .sort();
    const mapping = activationMapping(project, insights, names);
    const config = configure(project, names, mapping);
    const title = 'Signup to activation';
    if (!mapping)
      return panel(
        title,
        h(
          'div',
          {},
          h(
            'p',
            {},
            'Activation mapping unavailable. Choose the observed events for completed signup and first value.',
          ),
          config,
        ),
      );
    const spec = { ...mapping, ...period, project, kind: 'funnel' };
    const result = await api.post<FunnelResult>('/api/query', spec);
    const [signup, action] = result.steps;
    const dropped = signup!.count - action!.count;
    const link = href('insights/funnel', {
      project,
      ...result.range,
      spec: JSON.stringify(mapping),
    });
    return panel(
      title,
      h(
        'div',
        { class: 'stack' },
        table(
          ['Ordered step', 'Event', 'Distinct people'],
          [
            ['Completed signup', signup!.event, count(signup!.count)],
            ['First value', action!.event, count(action!.count)],
          ],
        ),
        h(
          'p',
          {},
          signup!.count
            ? [
                action!.count ? 'Activated' : 'No activations observed',
                percent(action!.conversionFromStart) + ' converted',
                count(dropped) + ' dropped off (' + percent(dropped / signup!.count) + ')',
              ].join(' · ')
            : 'No signups in this cohort. Conversion is unavailable.',
        ),
        h('a', { href: link }, 'Inspect underlying funnel'),
        config,
      ),
      {
        subtitle:
          project +
          ' · Signup cohort ' +
          result.range.from +
          ' to ' +
          result.range.to +
          ' (end exclusive). Later actions count within ' +
          mapping.window +
          ' of signup, including after the reporting period. Each person counts once at their furthest attempt.',
        sql: result.sql,
      },
    );
  }, 'Loading signup cohort');
}
