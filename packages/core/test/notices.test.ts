/**
 * Notices in each tool's format, inside each tool's limits, and as an email.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  discordNotice,
  NOTICE_RENDERERS,
  type Notice,
  slackNotice,
  teamsNotice,
} from '../src/destinations/notices.ts';
import { noticeEmail, recipientBatches } from '../src/email.ts';

const notice = (items: number): Notice => ({
  kind: 'report',
  title: 'Weekly: Product health',
  intro: '20 Nov 2026, last 7 days',
  items: Array.from({ length: items }, (_, i) => ({
    title: `Chart <${i}> & co`,
    value: '1,234',
    delta: '▲ 8%',
    imageUrl: `https://glass.test/r/run/${i}.png?e=1&s=x`,
    link: `https://glass.test/app#/insights/k${i}`,
  })),
  link: 'https://glass.test/app#/dashboards/d1',
  linkLabel: 'Open dashboard',
});

const bodies = (r: { body?: string }[]) => r.map((x) => JSON.parse(x.body!));

describe('notices', () => {
  it('Slack: Block Kit with images and a button, split under 50 blocks, mrkdwn escaped', () => {
    const one = bodies(slackNotice(notice(2), 'https://hooks.slack.test/x'));
    assert.equal(one.length, 1);
    const blocks = one[0].blocks as { type: string; text?: { text: string }; image_url?: string }[];
    assert.equal(blocks[0]!.type, 'header');
    assert.equal(blocks.filter((b) => b.type === 'image').length, 2);
    assert.equal(blocks.at(-1)!.type, 'actions');
    assert.match(
      blocks.find((b) => b.type === 'section' && b.text?.text.includes('Chart'))!.text!.text,
      /&lt;0&gt; &amp; co/,
    );
    const many = bodies(slackNotice(notice(20), 'https://hooks.slack.test/x'));
    assert.ok(many.length > 1);
    for (const m of many) assert.ok(m.blocks.length <= 50, `${m.blocks.length} blocks`);
    assert.equal(
      many.flatMap((m) => m.blocks).filter((b: { type: string }) => b.type === 'image').length,
      20,
    );
  });

  it('Discord: up to 10 embeds a message, with images', () => {
    const msgs = bodies(discordNotice(notice(12), 'https://discord.test/x'));
    assert.deepEqual(
      msgs.map((m) => m.embeds.length),
      [10, 2],
    );
    assert.match(msgs[0].content, /Weekly/);
    assert.equal(msgs[1].content, undefined);
    assert.equal(msgs[0].embeds[0].image.url, 'https://glass.test/r/run/0.png?e=1&s=x');
  });

  it('Teams: one Adaptive Card; webhooks: the notice as JSON', () => {
    const card = bodies(teamsNotice(notice(2), 'https://teams.test/x'))[0].attachments[0].content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.equal(card.body.filter((b: { type: string }) => b.type === 'Image').length, 2);
    assert.equal(card.actions[0].url, 'https://glass.test/app#/dashboards/d1');
    const hook = NOTICE_RENDERERS.webhook!(notice(1), {
      url: 'https://example.com/hook',
      headers: { 'X-Key': 'k' },
    });
    assert.equal(hook[0]!.headers['X-Key'], 'k');
    assert.equal(JSON.parse(hook[0]!.body!).type, 'dataflare.report');
    assert.deepEqual(NOTICE_RENDERERS.webhook!(notice(1), { url: 'ftp://x' }), []);
  });

  it('email: escaped HTML, inline charts by cid, a text part, unsubscribe', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const mail = noticeEmail(notice(2), {
      from: 'reports@acme.com',
      to: ['a@acme.com'],
      images: new Map([[1, png]]),
      unsubscribe: 'https://glass.test/u/abc',
    });
    assert.equal(mail.subject, 'Weekly: Product health');
    assert.match(mail.html, /Chart &lt;0&gt; &amp; co/);
    assert.match(mail.html, /src="cid:chart-1@dataflare"/);
    assert.doesNotMatch(mail.html, /cid:chart-0/);
    assert.deepEqual(mail.attachments, [
      {
        content: 'iVBORw==',
        filename: 'chart-2.png',
        type: 'image/png',
        disposition: 'inline',
        contentId: 'chart-1@dataflare',
      },
    ]);
    assert.match(mail.text, /Unsubscribe: https:\/\/glass.test\/u\/abc/);
    assert.deepEqual(
      recipientBatches(Array.from({ length: 120 }, (_, i) => `${i}@x.com`)).map((b) => b.length),
      [50, 50, 20],
    );
  });
});
