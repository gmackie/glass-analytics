/** Every page except the homepage. */

import { Marked, type Tokens } from 'marked';
import { FACTS_CHECKED, INSTALL, REPO } from './config.ts';
import { COMPETITORS, type Competitor, GLASS, ROWS } from './content/compare.ts';
import { GUIDES, type Guide } from './content/guides.ts';
import { command, esc, layout, stripTags } from './layout.ts';

export function slugify(text: string): string {
  return stripTags(text.toLowerCase())
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Docs, in reading order. */
export const DOCS: { slug: string; file: string; title: string; summary: string }[] = [
  {
    slug: 'getting-started',
    file: 'getting-started.md',
    title: 'Getting started',
    summary: 'Install, frameworks, custom domains, EU data, upgrading.',
  },
  {
    slug: 'sdk',
    file: 'sdk.md',
    title: 'Browser SDK',
    summary: 'init, capture, identify, flags, replay and consent.',
  },
  {
    slug: 'agents',
    file: 'agents.md',
    title: 'Agents: MCP, CLI and HTTP',
    summary: 'Every MCP tool, CLI command and API endpoint, with recipes.',
  },
  {
    slug: 'queries',
    file: 'queries.md',
    title: 'Queries',
    summary: 'Properties, filters, time ranges, every query type and SQL.',
  },
  {
    slug: 'dashboards',
    file: 'dashboards.md',
    title: 'Dashboards and reports',
    summary: 'Dashboards, scheduled reports to Slack and email, chart images.',
  },
  {
    slug: 'alerts',
    file: 'alerts.md',
    title: 'Alerts',
    summary: 'Alerts on any trends series or funnel step.',
  },
  {
    slug: 'experiments',
    file: 'experiments.md',
    title: 'Flags and experiments',
    summary: 'Flags, assignment, and how results are computed.',
  },
  {
    slug: 'privacy',
    file: 'privacy.md',
    title: 'Privacy',
    summary: "What's stored, cookieless mode, deletion, EU data.",
  },
  {
    slug: 'architecture',
    file: 'architecture.md',
    title: 'Architecture',
    summary: 'Request paths, identity, portable SQL, packages.',
  },
  {
    slug: 'lake',
    file: 'lake.md',
    title: 'The lake store',
    summary: 'Iceberg tables on R2 for high volume.',
  },
  {
    slug: 'extending',
    file: 'extending.md',
    title: 'Extending Dataflare',
    summary: 'Add a query type, MCP tool, storage engine or framework.',
  },
];

const DOC_LINKS = new Map(DOCS.map((d) => [d.file, `/docs/${d.slug}/`]));

/** Markdown → HTML with heading anchors and site-relative links. */
export function markdown(md: string): { html: string; headings: { id: string; text: string }[] } {
  const headings: { id: string; text: string }[] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(
        this: { parser: { parseInline(t: Tokens.Generic[]): string } },
        token: Tokens.Heading,
      ) {
        const text = this.parser.parseInline(token.tokens);
        const id = slugify(token.text);
        if (token.depth === 2) headings.push({ id, text: stripTags(text) });
        if (token.depth === 1) return '';
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${text}</h${token.depth}>\n`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
        let href = token.href;
        const [file, hash] = href.split('#');
        if (file && DOC_LINKS.has(file)) href = `${DOC_LINKS.get(file)}${hash ? `#${hash}` : ''}`;
        else if (file?.startsWith('../'))
          href = `${REPO}/blob/main/${file.slice(3)}${hash ? `#${hash}` : ''}`;
        const external = /^https?:/.test(href) && !href.includes('glass-site');
        return `<a href="${esc(href)}"${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(token.tokens)}</a>`;
      },
      table(this: unknown, token: Tokens.Table) {
        const cell = (c: Tokens.TableCell) => new Marked().parseInline(c.text) as string;
        return `<div class="table-wrap"><table><thead><tr>${token.header.map((h) => `<th>${cell(h)}</th>`).join('')}</tr></thead><tbody>${token.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      },
    },
  });
  return { html: marked.parse(md) as string, headings };
}

function toc(headings: { id: string; text: string }[]): string {
  if (headings.length < 2) return '';
  return `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${headings.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></nav>`;
}

function ctaBox(): string {
  return `<aside class="cta-box"><h2>Try Dataflare</h2><p>Deploys into your Cloudflare account in about two minutes.</p>${command(INSTALL)}<p><a href="/demo/">Or click through the live demo →</a></p></aside>`;
}

// ── Docs ─────────────────────────────────────────────────────────────────────

export function docsIndex(): string {
  return layout({
    path: '/docs/',
    title: 'Dataflare Analytics documentation',
    description:
      'Documentation for Dataflare: install it in your Cloudflare account, the browser SDK, MCP tools for agents, queries, experiments, privacy and architecture.',
    crumbs: [{ name: 'Docs', path: '/docs/' }],
    body: `<div class="page-head"><p class="eyebrow">Documentation</p><h1>Dataflare docs</h1><p class="lede">Everything about installing, using and extending Dataflare. Agents can read the same docs as one file at <a href="/llms-full.txt">/llms-full.txt</a>.</p></div>
<div class="card-grid">${DOCS.map((d) => `<a class="card" href="/docs/${d.slug}/"><h2>${esc(d.title)}</h2><p>${esc(d.summary)}</p></a>`).join('')}</div>
<div class="narrow">${ctaBox()}</div>`,
  });
}

export function docPage(doc: (typeof DOCS)[number], md: string): string {
  const { html, headings } = markdown(md);
  const lead =
    md
      .split('\n')
      .find((l) => l.trim() && !l.startsWith('#'))
      ?.replace(/[`*_[\]]|\(.*?\)/g, '') ?? doc.summary;
  const i = DOCS.indexOf(doc);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  return layout({
    path: `/docs/${doc.slug}/`,
    title: `${doc.title} · Dataflare Analytics docs`,
    description: lead.slice(0, 155),
    markdown: `/docs/${doc.slug}.md`,
    crumbs: [
      { name: 'Docs', path: '/docs/' },
      { name: doc.title, path: `/docs/${doc.slug}/` },
    ],
    body: `<div class="doc-layout">
  <nav class="doc-nav" aria-label="Docs"><p>Docs</p><ul>${DOCS.map((d) => `<li><a href="/docs/${d.slug}/"${d === doc ? ' aria-current="page"' : ''}>${esc(d.title)}</a></li>`).join('')}</ul><p>Guides</p><ul>${GUIDES.filter(
    (g) => g.kind === 'topic',
  )
    .map((g) => `<li><a href="/guides/${g.slug}/">${esc(g.label)}</a></li>`)
    .join('')}</ul></nav>
  <article class="prose">
    <h1>${esc(doc.title)}</h1>
    ${html}
    <nav class="doc-pager" aria-label="Previous and next">${prev ? `<a href="/docs/${prev.slug}/"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="/docs/${next.slug}/"><span>Next</span>${esc(next.title)}</a>` : ''}</nav>
    <p class="edit"><a href="${REPO}/edit/main/docs/${doc.file}">Edit this page on GitHub</a> · <a href="/docs/${doc.slug}.md">Markdown</a></p>
  </article>
  ${toc(headings)}
</div>`,
  });
}

// ── Comparisons ──────────────────────────────────────────────────────────────

function compareTable(cols: Competitor[]): string {
  return `<div class="table-wrap"><table class="compare-table"><thead><tr><th scope="col"><span class="visually-hidden">Feature</span></th><th scope="col" class="glass-col">Dataflare</th>${cols.map((c) => `<th scope="col">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${ROWS.map(([key, label]) => `<tr><th scope="row">${esc(label)}</th><td class="glass-col">${esc(GLASS[key])}</td>${cols.map((c) => `<td>${esc(c.table[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const inline = (text: string) => markdown(text).html.replace(/^<p>|<\/p>\n?$/g, '');

export function vsIndex(): string {
  return layout({
    path: '/vs/',
    title: 'Dataflare vs PostHog, Google Analytics, Plausible, Amplitude, Mixpanel and Umami',
    description:
      'How Dataflare compares with PostHog, Google Analytics, Plausible, Amplitude, Mixpanel, Umami and Cloudflare Web Analytics: where your data lives, licence, price, replay, flags and SQL.',
    crumbs: [{ name: 'Compare', path: '/vs/' }],
    body: `<div class="page-head"><p class="eyebrow">Compare</p><h1>How Dataflare compares</h1><p class="lede">Dataflare is open-source analytics that runs in your own Cloudflare account. Here's how it stacks up, including where the others are the better choice. Facts checked ${FACTS_CHECKED} from each product's own pages.</p></div>
${compareTable(COMPETITORS)}
<div class="card-grid">${COMPETITORS.map((c) => `<a class="card" href="/vs/${c.slug}/"><h2>Dataflare vs ${esc(c.name)}</h2><p>${esc(c.description)}</p></a>`).join('')}</div>
<p class="fine">Spotted something out of date? <a href="${REPO}/issues/new?title=Comparison%20page%20correction">Open an issue</a> and we'll fix it.</p>`,
  });
}

export function vsPage(c: Competitor): string {
  const others = COMPETITORS.filter((o) => o !== c);
  return layout({
    path: `/vs/${c.slug}/`,
    title: `Dataflare vs ${c.name}: open-source analytics in your Cloudflare account`,
    description: c.description,
    crumbs: [
      { name: 'Compare', path: '/vs/' },
      { name: `Dataflare vs ${c.name}`, path: `/vs/${c.slug}/` },
    ],
    body: `<article class="vs">
  <div class="page-head"><p class="eyebrow">Compare</p><h1>Dataflare vs ${esc(c.name)}</h1><p class="lede">${esc(c.name)} is ${esc(c.what)}. Dataflare is open-source analytics that runs in your own Cloudflare account.</p></div>
  <section class="verdict"><h2>The short answer</h2><p>${esc(c.verdict)}</p></section>
  <section><h2>Side by side</h2>${compareTable([c])}<p class="fine">Checked ${FACTS_CHECKED}. Sources: ${c.sources.map(([label, url]) => `<a href="${url}" rel="noopener">${esc(label)}</a>`).join(', ')}. Spotted something out of date? <a href="${REPO}/issues/new?title=${encodeURIComponent(`Correction: Dataflare vs ${c.name}`)}">Open an issue</a>.</p></section>
  <section class="two-col">
    <div class="col"><h2>Choose ${esc(c.name)} if you want</h2><ul>${c.theyWin.map((t) => `<li>${inline(t)}</li>`).join('')}</ul></div>
    <div class="col glass"><h2>Choose Dataflare if you want</h2><ul>${c.glassWins.map((t) => `<li>${inline(t)}</li>`).join('')}</ul></div>
  </section>
  <section><h2>Moving from ${esc(c.name)} to Dataflare</h2><ol class="numbered">${c.switching.map((t) => `<li>${inline(t)}</li>`).join('')}</ol></section>
  ${ctaBox()}
  <section><h2>Other comparisons</h2><ul class="link-list">${others.map((o) => `<li><a href="/vs/${o.slug}/">Dataflare vs ${esc(o.name)}</a></li>`).join('')}</ul></section>
</article>`,
  });
}

// ── Guides ───────────────────────────────────────────────────────────────────

export function guidesIndex(): string {
  const card = (g: Guide) =>
    `<a class="card" href="/guides/${g.slug}/"><h2>${esc(g.label)}</h2><p>${esc(g.description)}</p></a>`;
  return layout({
    path: '/guides/',
    title: 'Dataflare Analytics guides: Next.js, Astro, SvelteKit, agents, replay and A/B tests',
    description:
      'Step-by-step guides to adding Dataflare analytics to Next.js, Astro, SvelteKit, Nuxt, Remix, Vite and Cloudflare Workers, plus cookieless analytics, agent-readable replay and A/B tests.',
    crumbs: [{ name: 'Guides', path: '/guides/' }],
    body: `<div class="page-head"><p class="eyebrow">Guides</p><h1>Guides</h1><p class="lede">Set up Dataflare in your framework, or go deeper on one topic.</p></div>
<h2 class="group-title">By framework</h2><div class="card-grid">${GUIDES.filter(
      (g) => g.kind === 'framework',
    )
      .map(card)
      .join('')}</div>
<h2 class="group-title">Topics</h2><div class="card-grid">${GUIDES.filter((g) => g.kind === 'topic')
      .map(card)
      .join('')}</div>`,
  });
}

export function guidePage(g: Guide): string {
  const { html, headings } = markdown(g.body);
  return layout({
    path: `/guides/${g.slug}/`,
    title: `${g.title} · Dataflare`,
    description: g.description,
    markdown: `/guides/${g.slug}.md`,
    crumbs: [
      { name: 'Guides', path: '/guides/' },
      { name: g.label, path: `/guides/${g.slug}/` },
    ],
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': g.kind === 'framework' ? 'HowTo' : 'TechArticle',
        name: g.title,
        description: g.description,
        ...(g.kind === 'framework'
          ? {
              step: headings
                .filter((h) => /^\d\./.test(h.text))
                .map((h, i) => ({
                  '@type': 'HowToStep',
                  position: i + 1,
                  name: h.text.replace(/^\d\.\s*/, ''),
                })),
            }
          : {}),
      },
    ],
    body: `<div class="doc-layout">
  <nav class="doc-nav" aria-label="Guides"><p>Frameworks</p><ul>${GUIDES.filter(
    (x) => x.kind === 'framework',
  )
    .map(
      (x) =>
        `<li><a href="/guides/${x.slug}/"${x === g ? ' aria-current="page"' : ''}>${esc(x.label)}</a></li>`,
    )
    .join('')}</ul><p>Topics</p><ul>${GUIDES.filter((x) => x.kind === 'topic')
    .map(
      (x) =>
        `<li><a href="/guides/${x.slug}/"${x === g ? ' aria-current="page"' : ''}>${esc(x.label)}</a></li>`,
    )
    .join('')}</ul></nav>
  <article class="prose"><h1>${esc(g.title)}</h1>${html}${ctaBox()}</article>
  ${toc(headings)}
</div>`,
  });
}

// ── Pricing ──────────────────────────────────────────────────────────────────

export function pricingPage(checked: string): string {
  const faq: [string, string][] = [
    [
      'Why is there no Dataflare plan?',
      'Dataflare is software you run, not a service. It deploys into your Cloudflare account, so Cloudflare bills you directly for what it uses. There is nothing to pay the Dataflare project.',
    ],
    [
      'Is the $5 Workers Paid plan just for Dataflare?',
      "No. It's per Cloudflare account and covers every Worker in it, along with the included requests, D1 and other allowances. If you already pay it, Dataflare's extra cost is usually $0.",
    ],
    [
      'How accurate is this?',
      `It's an estimate from Cloudflare's published list prices (checked ${esc(checked)}) and Dataflare's own write pattern: about three Worker requests per page view, five D1 row writes per event (the row plus four indexes) and about 450 bytes stored per event. Your Cloudflare dashboard has the real numbers. Once Dataflare is installed, Data › Usage &amp; cost in the Dataflare dashboard makes the same estimate from your actual volume.`,
    ],
    [
      'What uses the most?',
      'For most sites, D1 row writes from events, then session replay uploads. Recording 10% of sessions instead of all of them, dropping events nobody looks at, and setting a retention period all reduce the bill; the calculator shows each line.',
    ],
    [
      'What about very high traffic?',
      'Above tens of millions of events a month, D1’s 10 GB database limit matters more than price. Keep a rolling window with GLASS_RETENTION_DAYS, or use the lake store (--lake), which streams events into Iceberg tables in R2 instead of D1.',
    ],
  ];
  return layout({
    path: '/pricing/',
    title: 'Dataflare pricing: what analytics costs on your Cloudflare bill',
    description:
      "Dataflare is free and open source; it runs in your Cloudflare account, so you pay Cloudflare's list prices. Estimate your monthly bill from page views, events and session replay.",
    scripts: ['/calculator.js'],
    crumbs: [{ name: 'Pricing', path: '/pricing/' }],
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map(([q, a]) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: {
            '@type': 'Answer',
            text: stripTags(a).replaceAll('&amp;', '&'),
          },
        })),
      },
    ],
    body: `<div class="page-head center"><p class="eyebrow">Pricing</p><h1>Dataflare is free. Cloudflare bills you for what it uses.</h1><p class="lede">There's no Dataflare subscription and no per-event price. Move the sliders to see what your traffic would add to your Cloudflare bill, line by line.</p></div>
<div class="calc full" data-calculator="full"><noscript><p>The calculator needs JavaScript. Short version: a small site fits Workers Free ($0); most others fit the $5/month Workers Paid plan.</p></noscript></div>
<p class="fine center">Indicative only: Cloudflare list prices checked ${esc(checked)} (<a href="https://developers.cloudflare.com/workers/platform/pricing/">Workers</a>, <a href="https://developers.cloudflare.com/d1/platform/pricing/">D1</a>, <a href="https://developers.cloudflare.com/r2/pricing/">R2</a>). Your Cloudflare dashboard has the real numbers.</p>
<section class="section faq narrow"><h2>About the numbers</h2><div class="faq-list">${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join('')}</div></section>
<div class="narrow">${ctaBox()}</div>`,
  });
}

// ── Changelog, 404 ───────────────────────────────────────────────────────────

export function changelogPage(md: string): string {
  const { html } = markdown(md.replace(/^# .*\n/, ''));
  return layout({
    path: '/changelog/',
    title: 'Changelog · Dataflare Analytics',
    description:
      'What changed in each Dataflare release: the CLI, Worker, dashboard and SDK share one version.',
    crumbs: [{ name: 'Changelog', path: '/changelog/' }],
    body: `<div class="page-head"><p class="eyebrow">Changelog</p><h1>What's new in Dataflare</h1><p class="lede">The CLI, Worker, dashboard and SDK share one version. Upgrade with <code>npx dataflare-cli@latest upgrade</code>, then let CI deploy it.</p></div><article class="prose narrow changelog">${html}</article>`,
  });
}

export function notFoundPage(): string {
  return layout({
    path: '/404.html',
    title: 'Not found · Dataflare Analytics',
    description: 'This page does not exist.',
    noindex: true,
    body: `<div class="page-head center"><p class="eyebrow">404</p><h1>Nothing here</h1><p class="lede">The page you asked for doesn't exist, or it moved. Try the <a href="/docs/">docs</a>, the <a href="/guides/">guides</a> or the <a href="/">homepage</a>.</p></div>`,
  });
}
