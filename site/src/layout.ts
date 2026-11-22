/** The page shell: head tags for search and sharing, header, footer. */

import { GLASS_HOST, GLASS_PROJECT, INSTALL, META_PIXEL_ID, REPO, SITE_URL } from './config.ts';

export function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Text with every tag removed. A scan, not a regex, so a fragment like `<scr<script>ipt>` can't
 * leave a tag behind; an unclosed `<` drops the rest. */
export function stripTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (inTag) inTag = ch !== '>';
    else out += ch;
  }
  return out;
}

export interface PageOptions {
  /** URL path, e.g. "/" or "/docs/sdk/". */
  path: string;
  /** Full <title>. */
  title: string;
  description: string;
  body: string;
  /** Structured data objects, each emitted as its own JSON-LD block. */
  jsonLd?: object[];
  /** Extra module scripts, e.g. "/calculator.js". */
  scripts?: string[];
  /** A markdown twin of this page, for agents. */
  markdown?: string;
  /** Breadcrumb trail (excluding Home), for structured data. */
  crumbs?: { name: string; path: string }[];
  /** Hide from search engines (404). */
  noindex?: boolean;
}

const NAV: [string, string][] = [
  ['Demo', '/demo/'],
  ['Docs', '/docs/'],
  ['Pricing', '/pricing/'],
  ['Compare', '/vs/'],
  ['Guides', '/guides/'],
];

export const FOOTER: { title: string; links: [string, string][] }[] = [
  {
    title: 'Product',
    links: [
      ['Live demo', '/demo/'],
      ['Pricing calculator', '/pricing/'],
      ['Changelog', '/changelog/'],
      ['Roadmap', `${REPO}/blob/main/ROADMAP.md`],
    ],
  },
  {
    title: 'Docs',
    links: [
      ['Getting started', '/docs/getting-started/'],
      ['Browser SDK', '/docs/sdk/'],
      ['Agents: MCP, CLI, HTTP', '/docs/agents/'],
      ['Queries', '/docs/queries/'],
      ['Flags and experiments', '/docs/experiments/'],
      ['Privacy', '/docs/privacy/'],
      ['Architecture', '/docs/architecture/'],
    ],
  },
  {
    title: 'Compare',
    links: [
      ['Dataflare vs PostHog', '/vs/posthog/'],
      ['Dataflare vs Google Analytics', '/vs/google-analytics/'],
      ['Dataflare vs Plausible', '/vs/plausible/'],
      ['Dataflare vs Amplitude', '/vs/amplitude/'],
      ['Dataflare vs Mixpanel', '/vs/mixpanel/'],
      ['Dataflare vs Umami', '/vs/umami/'],
      ['Dataflare vs Cloudflare Web Analytics', '/vs/cloudflare-web-analytics/'],
    ],
  },
  {
    title: 'Open source',
    links: [
      ['GitHub', REPO],
      ['Contributing', `${REPO}/blob/main/CONTRIBUTING.md`],
      ['Security', `${REPO}/blob/main/SECURITY.md`],
      ['llms.txt', '/llms.txt'],
    ],
  },
];

export const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="mk" x1="0" y1="0" x2="1" y2="1"><stop offset="0.58" stop-color="#fff"/><stop offset="0.58" stop-color="#cfe7df"/><stop offset="0.78" stop-color="#cfe7df"/><stop offset="0.78" stop-color="#2e7d6b"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="7" fill="url(#mk)" stroke="#5bbfa4" stroke-width="2.5"/></svg>`;

const GITHUB_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>`;

/** The Meta Pixel snippet as Meta supplies it: the head script and the body <noscript> fallback. */
export function metaPixel(): { head: string; body: string } {
  if (!META_PIXEL_ID) return { head: '', body: '' };
  return {
    head: `<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${META_PIXEL_ID}');
fbq('track', 'PageView');
</script>
<!-- End Meta Pixel Code -->`,
    body: `<noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${META_PIXEL_ID}&amp;ev=PageView&amp;noscript=1"></noscript>`,
  };
}

export function layout(o: PageOptions): string {
  const pixel = metaPixel();
  const url = `${SITE_URL}${o.path}`;
  const crumbs = o.crumbs?.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [{ name: 'Dataflare', path: '/' }, ...o.crumbs].map((c, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: c.name,
          item: `${SITE_URL}${c.path}`,
        })),
      }
    : null;
  const ld = [...(o.jsonLd ?? []), ...(crumbs ? [crumbs] : [])]
    .map(
      (d) =>
        `<script type="application/ld+json">${JSON.stringify(d).replaceAll('<', '\\u003c')}</script>`,
    )
    .join('\n');
  const glass = GLASS_HOST
    ? `<script defer src="${GLASS_HOST}/s.js" data-project="${GLASS_PROJECT}" data-persistence="cookieless" data-replay-sample-rate="1" data-replay-cookieless="true"></script>`
    : '';
  const active = (href: string) => (o.path.startsWith(href) ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${url}">
${o.noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dataflare Analytics">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/img/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0d1714">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
${o.markdown ? `<link rel="alternate" type="text/markdown" href="${o.markdown}" title="This page as markdown">` : ''}
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
${ld}
${glass}
${pixel.head}
<script type="module" src="/main.js"></script>
${(o.scripts ?? []).map((s) => `<script type="module" src="${s}"></script>`).join('\n')}
</head>
<body>
${pixel.body}
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/">${MARK}<span>Dataflare</span></a>
    <nav class="nav" aria-label="Site">
      ${NAV.map(([label, href]) => `<a href="${href}"${active(href)}>${label}</a>`).join('\n      ')}
    </nav>
    <div class="header-actions">
      <a class="icon-link" href="${REPO}" aria-label="Dataflare on GitHub">${GITHUB_ICON}</a>
      <a class="button small primary" href="/docs/getting-started/">Get started</a>
    </div>
    <button class="menu-button" type="button" aria-expanded="false" aria-controls="mobile-nav" aria-label="Menu"><span></span><span></span></button>
  </div>
  <nav class="mobile-nav" id="mobile-nav" aria-label="Site" hidden>
    ${NAV.map(([label, href]) => `<a href="${href}">${label}</a>`).join('\n    ')}
    <a href="${REPO}">GitHub</a>
  </nav>
</header>
<main id="main">
${o.body}
</main>
<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <a class="brand" href="/">${MARK}<span>Dataflare</span></a>
      <p>Open-source analytics that runs in your own Cloudflare account. MIT licensed.</p>
      <div class="command small" data-copy-source><code><span class="prompt" aria-hidden="true">$ </span>${INSTALL}</code><button type="button" class="copy" data-copy="${INSTALL}" data-event="install_command_copied">Copy</button></div>
    </div>
    ${FOOTER.map(
      (col) =>
        `<div class="footer-col"><h2>${col.title}</h2><ul>${col.links
          .map(([label, href]) => `<li><a href="${href}">${label}</a></li>`)
          .join('')}</ul></div>`,
    ).join('\n    ')}
  </div>
  <p class="footer-note">Dataflare is an independent open-source project, not affiliated with Cloudflare. Prices on this site are Cloudflare's list prices; your bill comes from Cloudflare.</p>
</footer>
</body>
</html>
`;
}

/** A copyable shell command. */
export function command(text: string, event = 'install_command_copied'): string {
  return `<div class="command"><code><span class="prompt" aria-hidden="true">$ </span>${esc(text)}</code><button type="button" class="copy" data-copy="${esc(text)}" data-event="${event}">Copy</button></div>`;
}

/** A screenshot, with a dark variant when one exists. */
export function shot(
  name: string,
  alt: string,
  options: { dark?: boolean; eager?: boolean } = {},
): string {
  const loading = options.eager ? 'eager' : 'lazy';
  return `<picture>${options.dark ? `<source srcset="/img/${name}-dark.webp" media="(prefers-color-scheme: dark)">` : ''}<img src="/img/${name}-light.webp" alt="${esc(alt)}" width="1440" height="900" loading="${loading}" decoding="async"${options.eager ? ' fetchpriority="high"' : ''}></picture>`;
}
