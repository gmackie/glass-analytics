/**
 * Report and alert emails: a table-based HTML body with inline styles (what mail clients
 * render reliably), charts as inline attachments referenced by cid:, a plain-text part, and
 * an unsubscribe link. The shape matches Cloudflare Email Sending's structured `send()`.
 */

import { type Notice, noticeText } from './destinations/notices.ts';

export interface EmailAttachment {
  /** Base64. */
  content: string;
  filename: string;
  type: string;
  disposition: 'inline' | 'attachment';
  contentId?: string;
}

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

/** At most this many recipients per message (to + cc + bcc). */
export const MAX_RECIPIENTS = 50;

const escapeHtml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif";

function itemHtml(item: Notice['items'][number], cid: string | undefined): string {
  const title = escapeHtml(item.title);
  const head = item.link
    ? `<a href="${escapeHtml(item.link)}" style="color:#16201c;text-decoration:none">${title}</a>`
    : title;
  const value = item.value
    ? `<span style="font-size:22px;font-weight:650;color:#16201c">${escapeHtml(item.value)}</span>`
    : '';
  const delta = item.delta
    ? ` <span style="font-size:13px;color:#64746d">${escapeHtml(item.delta)}</span>`
    : '';
  const note = item.note
    ? `<div style="font-size:13px;color:#64746d;margin-top:2px">${escapeHtml(item.note)}</div>`
    : '';
  const image = cid
    ? `<div style="margin-top:10px"><img src="cid:${cid}" width="560" alt="${title}" style="display:block;width:100%;max-width:560px;height:auto;border:0"></div>`
    : '';
  return `<tr><td style="padding:18px 24px;border-top:1px solid #e2e8e5">
<div style="font-size:14px;font-weight:600;color:#16201c;margin-bottom:4px">${head}</div>
<div>${value}${delta}</div>${note}${image}</td></tr>`;
}

/**
 * The email for a notice. `images` holds a PNG per item index; `unsubscribe` is a link that
 * takes this address off the report.
 */
export function noticeEmail(
  n: Notice,
  o: { from: string; to: string[]; images?: Map<number, Uint8Array>; unsubscribe?: string },
): EmailMessage {
  const attachments: EmailAttachment[] = [];
  const rows = n.items.map((item, i) => {
    const png = o.images?.get(i);
    if (!png) return itemHtml(item, undefined);
    const cid = `chart-${i}@dataflare`;
    attachments.push({
      content: toBase64(png),
      filename: `chart-${i + 1}.png`,
      type: 'image/png',
      disposition: 'inline',
      contentId: cid,
    });
    return itemHtml(item, cid);
  });
  const button = n.link
    ? `<tr><td style="padding:20px 24px;border-top:1px solid #e2e8e5"><a href="${escapeHtml(n.link)}" style="display:inline-block;background:#2a7a67;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px">${escapeHtml(n.linkLabel ?? 'Open in Dataflare')}</a></td></tr>`
    : '';
  const footer = o.unsubscribe
    ? `<p style="font-size:12px;color:#64746d;margin:16px 0 0;text-align:center">You get this from Dataflare. <a href="${escapeHtml(o.unsubscribe)}" style="color:#64746d">Unsubscribe</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f4f6f5;${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:608px;margin:0 auto;background:#ffffff;border:1px solid #e2e8e5;border-radius:12px;border-collapse:separate">
<tr><td style="padding:22px 24px 14px"><div style="font-size:18px;font-weight:650;color:#16201c">${escapeHtml(n.title)}</div>${n.intro ? `<div style="font-size:14px;color:#364540;margin-top:6px">${escapeHtml(n.intro)}</div>` : ''}</td></tr>
${rows.join('\n')}
${button}
</table>${footer}</body></html>`;
  const text = `${noticeText(n)}${o.unsubscribe ? `\n\nUnsubscribe: ${o.unsubscribe}` : ''}`;
  return {
    from: o.from,
    to: o.to,
    subject: n.title,
    html,
    text,
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Recipients in groups the sender accepts. */
export function recipientBatches(to: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < to.length; i += MAX_RECIPIENTS) out.push(to.slice(i, i + MAX_RECIPIENTS));
  return out;
}
