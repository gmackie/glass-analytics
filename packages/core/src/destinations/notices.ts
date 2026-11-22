/**
 * Notices: reports and alerts sent to a chat channel or webhook, as each tool lays out a rich
 * message — Slack Block Kit (split at 50 blocks), Discord embeds (10 per message), a Teams
 * Adaptive Card, or plain JSON for webhooks. A notice is a title, an intro and items, each
 * with a value, a change, a chart image and a link.
 */

import type { DeliveryRequest } from './types.ts';

export interface NoticeItem {
  title: string;
  /** "1,234", "4.2%". */
  value?: string;
  /** "▲ 8% vs the week before". */
  delta?: string;
  /** A short line under it ("Firing: above 1,000"). */
  note?: string;
  /** A public PNG of the chart. */
  imageUrl?: string;
  link?: string;
}

export interface Notice {
  kind: 'report' | 'alert';
  title: string;
  intro?: string;
  items: NoticeItem[];
  link?: string;
  linkLabel?: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SLACK_BLOCKS = 50;
const SLACK_TEXT = 3000;
const DISCORD_EMBEDS = 10;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Slack mrkdwn needs &, < and > escaped. */
const slackEscape = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function slackItem(item: NoticeItem): object[] {
  const head = item.link
    ? `*<${item.link}|${slackEscape(item.title)}>*`
    : `*${slackEscape(item.title)}*`;
  const line = [
    head,
    item.value ? `*${slackEscape(item.value)}*` : '',
    item.delta ? slackEscape(item.delta) : '',
  ]
    .filter(Boolean)
    .join('   ');
  const text = item.note ? `${line}\n${slackEscape(item.note)}` : line;
  const blocks: object[] = [
    { type: 'section', text: { type: 'mrkdwn', text: cut(text, SLACK_TEXT) } },
  ];
  if (item.imageUrl)
    blocks.push({ type: 'image', image_url: item.imageUrl, alt_text: cut(item.title, 1900) });
  return blocks;
}

function slackOpening(n: Notice): object[] {
  const blocks: object[] = [
    { type: 'header', text: { type: 'plain_text', text: cut(n.title, 150) } },
  ];
  if (n.intro)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: cut(slackEscape(n.intro), SLACK_TEXT) },
    });
  return blocks;
}

function slackButton(n: Notice): object[] {
  if (!n.link) return [];
  return [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: n.linkLabel ?? 'Open in Dataflare' },
          url: n.link,
        },
      ],
    },
  ];
}

/** Block Kit messages: the items, with dividers, split so none has more than 50 blocks. */
export function slackNotice(n: Notice, url: string): DeliveryRequest[] {
  const messages: object[][] = [slackOpening(n)];
  for (const item of n.items) {
    const blocks = [{ type: 'divider' }, ...slackItem(item)];
    if (messages[messages.length - 1]!.length + blocks.length > SLACK_BLOCKS - 1) messages.push([]);
    messages[messages.length - 1]!.push(...blocks);
  }
  messages[messages.length - 1]!.push(...slackButton(n));
  return messages.map((blocks, i) => ({
    url,
    method: 'POST' as const,
    headers: JSON_HEADERS,
    body: JSON.stringify({ text: i ? `${n.title} (continued)` : n.title, blocks }),
  }));
}

function discordEmbed(item: NoticeItem): object {
  const description = [item.value ? `**${item.value}**` : '', item.delta ?? '', item.note ?? '']
    .filter(Boolean)
    .join('  ·  ');
  return {
    title: cut(item.title, 256),
    ...(description ? { description: cut(description, 4096) } : {}),
    ...(item.link ? { url: item.link } : {}),
    ...(item.imageUrl ? { image: { url: item.imageUrl } } : {}),
    color: 0x2a7a67,
  };
}

/** Discord messages of up to 10 embeds; the first carries the title and intro. */
export function discordNotice(n: Notice, url: string): DeliveryRequest[] {
  const out: DeliveryRequest[] = [];
  for (let i = 0; i < Math.max(1, n.items.length); i += DISCORD_EMBEDS) {
    const first = i === 0;
    const content = first
      ? [`**${n.title}**`, n.intro ?? '', n.link ?? ''].filter(Boolean).join('\n')
      : undefined;
    out.push({
      url,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ...(content ? { content: cut(content, 2000) } : {}),
        embeds: n.items.slice(i, i + DISCORD_EMBEDS).map(discordEmbed),
      }),
    });
  }
  return out;
}

function teamsItem(item: NoticeItem): object[] {
  const line = [item.value, item.delta].filter(Boolean).join('   ');
  return [
    {
      type: 'TextBlock',
      text: item.title,
      weight: 'Bolder',
      wrap: true,
      spacing: 'Large',
      separator: true,
    },
    ...(line ? [{ type: 'TextBlock', text: line, wrap: true, size: 'Large' }] : []),
    ...(item.note ? [{ type: 'TextBlock', text: item.note, wrap: true, isSubtle: true }] : []),
    ...(item.imageUrl
      ? [
          {
            type: 'Image',
            url: item.imageUrl,
            altText: item.title,
            ...(item.link ? { selectAction: { type: 'Action.OpenUrl', url: item.link } } : {}),
          },
        ]
      : []),
  ];
}

/** One Adaptive Card. */
export function teamsNotice(n: Notice, url: string): DeliveryRequest[] {
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: n.title, weight: 'Bolder', size: 'Large', wrap: true },
      ...(n.intro ? [{ type: 'TextBlock', text: n.intro, wrap: true }] : []),
      ...n.items.flatMap(teamsItem),
    ],
    ...(n.link
      ? {
          actions: [
            { type: 'Action.OpenUrl', title: n.linkLabel ?? 'Open in Dataflare', url: n.link },
          ],
        }
      : {}),
  };
  return [
    {
      url,
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
      }),
    },
  ];
}

/** Webhooks get the notice as JSON. */
export function webhookNotice(n: Notice, config: Record<string, unknown>): DeliveryRequest[] {
  const url = String(config.url ?? '');
  if (!/^https?:\/\//.test(url)) return [];
  const headers = {
    ...JSON_HEADERS,
    ...((config.headers as Record<string, string> | undefined) ?? {}),
  };
  const method = String(config.method || 'POST') as 'POST';
  return [{ url, method, headers, body: JSON.stringify({ type: `dataflare.${n.kind}`, ...n }) }];
}

/** Destination templates that can carry a notice, and how. */
export const NOTICE_RENDERERS: Record<
  string,
  (n: Notice, config: Record<string, unknown>) => DeliveryRequest[]
> = {
  slack: (n, c) => slackNotice(n, String(c.url ?? '')),
  discord: (n, c) => discordNotice(n, String(c.url ?? '')),
  teams: (n, c) => teamsNotice(n, String(c.url ?? '')),
  webhook: webhookNotice,
  zapier: webhookNotice,
  make: webhookNotice,
  n8n: webhookNotice,
};

/** The notice as plain text (email text part, logs). */
export function noticeText(n: Notice): string {
  const items = n.items.map((i) =>
    [
      `- ${i.title}${i.value ? `: ${i.value}` : ''}${i.delta ? ` (${i.delta})` : ''}`,
      i.note ? `  ${i.note}` : '',
      i.link ? `  ${i.link}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    n.title,
    n.intro ?? '',
    ...items,
    n.link ? `\n${n.linkLabel ?? 'Open in Dataflare'}: ${n.link}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
