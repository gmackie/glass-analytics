/**
 * Settings › Notification channels: the Slack, Discord, Teams and webhook channels scheduled
 * reports and alerts go to. They are rows in the destinations table (so they share its
 * encrypted secrets, test sends and delivery log), created paused and matching only `$report`,
 * an event nothing sends, so they never forward events. Pipelines leaves them out.
 */

import { api } from '../api.ts';
import { h, mount } from '../dom.ts';
import { scope } from '../state.ts';
import { selectMenu } from './menu.ts';
import { channelSources } from './report-dialogs.ts';
import { empty, errorState, later, panel, toast } from './ui.ts';

/** What a channel matches: an event no one sends. */
const CHANNEL_EVENTS = ['$report'];

/** A notification channel, as opposed to a destination that forwards events. */
export const isChannel = (d: { match?: { events?: string[] } }): boolean =>
  d.match?.events?.length === 1 && d.match.events[0] === CHANNEL_EVENTS[0];

const KINDS = [
  { value: 'slack', label: 'Slack (incoming webhook)' },
  { value: 'discord', label: 'Discord (webhook)' },
  { value: 'teams', label: 'Microsoft Teams (Workflows webhook)' },
  { value: 'webhook', label: 'Webhook (JSON)' },
];

async function testChannel(id: string): Promise<void> {
  const r = await api.post<{ ok: boolean; error?: string }>(`/api/destinations/${id}/test`, {
    project: scope().project,
  });
  if (r.ok) toast('Test sent');
  else toast(`Test failed: ${r.error ?? 'unknown error'}`, 'error');
}

function addForm(reload: () => void): HTMLElement {
  let template = 'slack';
  const name = h('input', {
    type: 'text',
    placeholder: '#growth',
    'aria-label': 'Channel name',
  }) as HTMLInputElement;
  const url = h('input', {
    type: 'password',
    placeholder: 'https://hooks.slack.com/services/…',
    autocomplete: 'off',
    'aria-label': 'Webhook URL',
  }) as HTMLInputElement;
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack tight' },
    h(
      'div',
      { class: 'row' },
      selectMenu({
        value: template,
        label: 'Kind',
        options: KINDS,
        width: 260,
        onChange: (v) => (template = v),
      }),
      name,
    ),
    url,
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Add channel'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/destinations', {
        project: scope().project,
        name:
          name.value.trim() || KINDS.find((k) => k.value === template)!.label.replace(/ \(.*$/, ''),
        template,
        enabled: false,
        events: CHANNEL_EVENTS,
        filters: [],
        inputs: { url: url.value.trim() },
      });
      toast('Channel added: send a test to check it');
      reload();
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

export function notificationChannelsPanel(): HTMLElement {
  const holder = h('div', {});
  const load = () =>
    mount(
      holder,
      later(async () => {
        const sources = await channelSources(scope().project);
        const list = sources.destinations.length
          ? h(
              'ul',
              { class: 'report-list' },
              sources.destinations.map((d) =>
                h(
                  'li',
                  { class: 'report-row' },
                  h(
                    'div',
                    {},
                    h('strong', {}, d.name),
                    h('span', { class: 'muted small' }, ` ${d.template}`),
                  ),
                  h(
                    'button',
                    { type: 'button', class: 'small', onclick: () => void testChannel(d.id) },
                    'Send a test',
                  ),
                ),
              ),
            )
          : empty(
              'Add a channel, then pick it when you subscribe to a dashboard or set an alert.',
              null,
              { icon: 'bell' },
            );
        const email = sources.email.enabled
          ? h(
              'p',
              { class: 'muted small' },
              `Email is set up: reports can also go from ${sources.email.from}.`,
            )
          : h(
              'p',
              { class: 'muted small' },
              'Email reports need Cloudflare Email Sending: run dataflare email enable --from reports@yourdomain.com.',
            );
        return [list, addForm(load), email];
      }),
    );
  load();
  return panel('Notification channels', holder, {
    icon: 'bell',
    subtitle: 'Where scheduled reports and alerts go',
  });
}
