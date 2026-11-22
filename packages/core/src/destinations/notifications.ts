/**
 * Webhooks and chat notifications: a generic webhook (and Zapier, Make and n8n
 * presets of it), Slack, Discord and Microsoft Teams.
 */

import {
  type DeliveryEvent,
  type DestinationTemplate,
  interpolate,
  JSON_HEADERS,
  json,
  str,
  whoIs,
} from './types.ts';

const DEFAULT_MESSAGE = '{event} by {who} on {url}';

/** The message for chat destinations: the template with {who} filled in too. */
function message(event: DeliveryEvent, template: unknown): string {
  // Alerts (error tracking) carry their own text.
  if (event.event.startsWith('$') && typeof event.props.$alert_text === 'string')
    return event.props.$alert_text;
  const t = str(template) || DEFAULT_MESSAGE;
  return interpolate(t.replaceAll('{who}', whoIs(event)), event);
}

/** The event as a plain JSON object, as a webhook receives it by default. */
export function eventPayload(event: DeliveryEvent) {
  return {
    id: event.id,
    event: event.event,
    timestamp: new Date(event.ts_ms).toISOString(),
    distinct_id: event.distinct_id,
    user_id: event.user_id,
    person_id: event.person_id,
    session_id: event.session_id,
    url: event.url,
    path: event.path,
    referrer: event.referrer,
    utm: {
      source: event.utm_source,
      medium: event.utm_medium,
      campaign: event.utm_campaign,
      term: event.utm_term,
      content: event.utm_content,
    },
    geo: { country: event.country, region: event.region, city: event.city },
    device: { type: event.device, browser: event.browser, os: event.os },
    properties: event.props,
    person: event.person,
    flags: event.flags,
  };
}

function webhook(id: string, name: string, description: string): DestinationTemplate {
  return {
    id,
    name,
    description,
    category: id === 'webhook' ? 'custom' : 'automation',
    inputs: [
      {
        key: 'url',
        label: 'URL',
        type: 'secret',
        required: true,
        description: 'Where to POST each event.',
      },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        options: ['POST', 'PUT', 'PATCH'],
        default: 'POST',
      },
      {
        key: 'headers',
        label: 'Headers',
        type: 'json',
        description: 'Extra headers, e.g. {"X-Api-Key": "…"}. Stored encrypted.',
      },
      {
        key: 'body',
        label: 'Body template',
        type: 'string',
        description:
          'JSON with placeholders such as {"name":"{event}","email":"{person.email}","plan":"{props.plan}"}. Default: the whole event.',
      },
    ],
    async render(event, config) {
      const url = str(config.url);
      if (!url.startsWith('https://') && !url.startsWith('http://')) return null;
      const headers = { ...JSON_HEADERS, ...((config.headers as Record<string, string>) ?? {}) };
      const body = config.body
        ? interpolate(str(config.body), event, true)
        : json(eventPayload(event));
      return [{ url, method: (str(config.method) || 'POST') as 'POST', headers, body }];
    },
  };
}

export const WEBHOOK = webhook('webhook', 'Webhook', 'POST each event as JSON to any URL.');
export const ZAPIER = webhook('zapier', 'Zapier', 'Trigger a Zap with a “Catch Hook” URL.');
export const MAKE = webhook('make', 'Make', 'Trigger a Make scenario with a custom webhook URL.');
export const N8N = webhook('n8n', 'n8n', 'Trigger an n8n workflow with a Webhook node URL.');

const chatInputs = (what: string) => [
  { key: 'url', label: `${what} webhook URL`, type: 'secret' as const, required: true },
  {
    key: 'message',
    label: 'Message',
    type: 'string' as const,
    description:
      'With placeholders: {event}, {who}, {url}, {props.plan}, {person.email}… Default "{event} by {who} on {url}".',
  },
];

export const SLACK: DestinationTemplate = {
  id: 'slack',
  name: 'Slack',
  description: 'Post a message to a Slack channel (incoming webhook) for each event.',
  category: 'notifications',
  inputs: chatInputs('Slack incoming'),
  async render(event, config) {
    return [
      {
        url: str(config.url),
        method: 'POST',
        headers: JSON_HEADERS,
        body: json({ text: message(event, config.message) }),
      },
    ];
  },
};

export const DISCORD: DestinationTemplate = {
  id: 'discord',
  name: 'Discord',
  description: 'Post a message to a Discord channel (webhook) for each event.',
  category: 'notifications',
  inputs: chatInputs('Discord'),
  async render(event, config) {
    return [
      {
        url: str(config.url),
        method: 'POST',
        headers: JSON_HEADERS,
        body: json({ content: message(event, config.message).slice(0, 2000) }),
      },
    ];
  },
};

export const TEAMS: DestinationTemplate = {
  id: 'teams',
  name: 'Microsoft Teams',
  description: 'Post an adaptive card to a Teams channel (Workflows webhook) for each event.',
  category: 'notifications',
  inputs: chatInputs('Teams Workflows'),
  async render(event, config) {
    return [
      {
        url: str(config.url),
        method: 'POST',
        headers: JSON_HEADERS,
        body: json({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [{ type: 'TextBlock', text: message(event, config.message), wrap: true }],
              },
            },
          ],
        }),
      },
    ];
  },
};
