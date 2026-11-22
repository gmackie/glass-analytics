/** The homepage. Numbers on it (SDK size, MCP tools, version) are measured at build time. */

import { AGENT_PROMPT, INSTALL, REPO, SITE_URL } from './config.ts';
import { COMPETITORS, GLASS, ROWS } from './content/compare.ts';
import { command, esc, layout, shot, stripTags } from './layout.ts';

export interface Facts {
  version: string;
  sdkKb: string;
  mcpTools: number;
  mcpToolNames: string[];
  /** The real query behind the demo's Visitors chart. */
  heroSql: string;
  /** Where the chart and SQL switch sit in the hero screenshot, in % (from scripts/site-assets.ts). */
  heroLayout: HeroLayout;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HeroLayout {
  sql: Box;
  chart: Box;
}

export const FAQ: [string, string][] = [
  [
    'Is Dataflare free?',
    'The software is free and MIT licensed. It runs in your Cloudflare account, so you pay Cloudflare\'s list prices and nothing else. A small site fits in the Workers Free plan ($0). Above that, the Workers Paid plan is $5 a month and includes 10 million requests and 50 million D1 rows written; most sites never go past it. The <a href="/pricing/">calculator</a> shows your number.',
  ],
  [
    'Where is my data stored?',
    'In a D1 database and an R2 bucket in your own Cloudflare account. There is no Dataflare server: nothing is sent to the Dataflare project or any third party. Add <code>--eu</code> at install to keep data in the EU jurisdiction.',
  ],
  [
    'Does my site have to be on Cloudflare?',
    'No. Any website or app can send events to the Dataflare Worker on its <code>workers.dev</code> address. If your domain is on Cloudflare, you can also serve Dataflare from a path on it (<code>--route example.com</code> serves it at <code>/_glass</code>), which keeps it first-party and out of reach of most ad blockers.',
  ],
  [
    'Do I need a cookie banner?',
    'In cookieless mode Dataflare stores nothing on the device and never stores IP addresses. Whether you need consent depends on your jurisdiction and on everything else your site does, so take your own legal advice. <a href="/guides/cookieless-analytics/">How cookieless mode works</a>.',
  ],
  [
    'What happens when I outgrow D1?',
    'A D1 database holds up to 10 GB on Workers Paid, which is tens of millions of events. Set <code>GLASS_RETENTION_DAYS</code> to keep a rolling window, or install with <code>--lake</code> to stream events into Apache Iceberg tables in R2, which have no size limit.',
  ],
  [
    'Can my coding agent use it?',
    '<code>dataflare init</code> writes <code>AGENTS.md</code>, a Claude Code skill and an MCP server entry into your project. The agent can then query trends, funnels, retention, people and replays, run read-only SQL, and create flags and experiments. Every answer comes with the SQL that produced it and a dashboard link.',
  ],
  [
    'How is it different from PostHog?',
    'PostHog is a hosted platform with many more products. Dataflare covers the core (web and product analytics, replay, flags and experiments) and runs in your own Cloudflare account, with no vendor bill. <a href="/vs/posthog/">Full comparison</a>.',
  ],
  [
    'Can I get my data out?',
    'It is already yours: a SQLite database in your account. Query it with SQL in the dashboard or CLI, export it with <code>wrangler d1 export</code>, or point any Iceberg reader at the lake tables.',
  ],
  [
    'Is it ready for production?',
    'Dataflare is new (0.x) and used in production by its authors. The D1 store, SDK, dashboard, MCP server and CLI are covered by unit, integration and browser end-to-end tests. The lake store is load-tested at 30 million events on Cloudflare Basin SQL.',
  ],
];

const TOUR: {
  id: string;
  label: string;
  title: string;
  text: string;
  bullets: string[];
  shot: string;
  dark: boolean;
  alt: string;
  demo: string;
  docs: string;
}[] = [
  {
    id: 'web',
    label: 'Web analytics',
    title: 'Every visitor, source and page, at a glance',
    text: 'The numbers you check every morning: visitors, page views, sessions, bounce rate and time on site against the previous period, with sources, campaigns, pages, countries and devices. Click any row to filter the whole report.',
    bullets: [
      'Core Web Vitals and JavaScript errors on the same page',
      'UTM campaigns and channels, with conversion per source',
      'Cookieless mode: nothing stored on the device',
    ],
    shot: 'web',
    dark: true,
    alt: 'Dataflare web analytics report: visitors, page views, sessions and bounce rate with a 30-day chart against the previous period, and tables of pages, countries and devices.',
    demo: '/demo/#/reports?project=demo&from=-30d',
    docs: '/docs/queries/#web',
  },
  {
    id: 'product',
    label: 'Product analytics',
    title: 'Funnels, retention and trends on any event',
    text: 'Ask product questions without a data team: where people drop out of signup, which week’s users stick around, how revenue splits by plan. Filter and break down by any event or person property, or a saved cohort.',
    bullets: [
      'Trends, funnels and retention, with the previous period overlaid',
      'People and cohorts: identify() joins anonymous visits to accounts',
      'Read-only SQL on raw events when a chart isn’t enough',
    ],
    shot: 'funnel',
    dark: true,
    alt: 'A Dataflare funnel from visit to signup to payment, with conversion and drop-off at each step.',
    demo: '/demo/#/insights?project=demo&from=-30d',
    docs: '/docs/queries/',
  },
  {
    id: 'replay',
    label: 'Session replay',
    title: 'Watch the session, or read it',
    text: 'Recordings with every input masked, plus a timeline of what went wrong: rage and dead clicks, errors with stack frames, failed requests and console errors. Each session is also a text transcript your agent can read.',
    bullets: [
      'Record a sample of sessions, and every session with an error',
      'Search by what happened: errors, rage clicks, events, pages',
      'Patterns across sessions: the most frustrating elements and errors',
    ],
    shot: 'replay',
    dark: true,
    alt: 'A Dataflare session replay: the recorded page on the left and a timeline of clicks, a TypeError, a failed request and rage clicks on the right.',
    demo: '/demo/#/replays?project=demo&from=-7d',
    docs: '/docs/sdk/#session-replay',
  },
  {
    id: 'experiments',
    label: 'Flags and A/B tests',
    title: 'Ship behind a flag, then prove it worked',
    text: 'Feature flags evaluated in your own Worker, with rollouts and targeting. Experiments on the same events as your analytics, with conversion per variant, the probability to beat control, lift intervals and sample-ratio checks.',
    bullets: [
      'Bayesian results you can read without a statistics course',
      'Ship the winner in one click: the flag serves it to everyone',
      'Your agent can create, start and read experiments',
    ],
    shot: 'experiment',
    dark: true,
    alt: 'A Dataflare experiment: the test variant converts at 23.9% against 16.8% for control, with a 98% chance to beat control.',
    demo: '/demo/#/experiments/pricing-page-v2?project=demo&from=-30d',
    docs: '/docs/experiments/',
  },
  {
    id: 'sql',
    label: 'SQL',
    title: 'Every number shows the query behind it',
    text: 'Turn on the SQL switch and every panel shows the query that produced it. Copy it, change it, or start from scratch in the SQL editor. The same SQL runs on D1 and on the lake store.',
    bullets: [
      'Read-only SQL in the dashboard, the CLI and MCP',
      'Schema browser, results as a table or a chart, copy as CSV',
      'Nothing is hidden: the Worker in your account is the open-source code',
    ],
    shot: 'sql',
    dark: true,
    alt: 'The Dataflare SQL editor with a query grouping events by name, and the results as a table.',
    demo: '/demo/#/sql?project=demo&from=-7d',
    docs: '/docs/queries/#sql',
  },
];

function heroFigure(sql: string, layout: HeroLayout): string {
  const vars = (name: string, b: Box) =>
    `--${name}-l:${b.left}%;--${name}-t:${b.top}%;--${name}-w:${b.width}%;--${name}-h:${b.height}%`;
  return `<figure class="hero-shot" data-seethrough>
  <div class="frame">
    <div class="frame-bar" aria-hidden="true"><span></span><span></span><span></span><em>glass.your-domain.workers.dev/app</em></div>
    <div class="frame-body" style="${vars('sql', layout.sql)};${vars('chart', layout.chart)}">
      ${shot('web', 'The Dataflare dashboard: a web analytics report with visitors, page views, sessions and bounce rate, a 30-day chart, and tables of pages, countries and devices.', { dark: true, eager: true })}
      <button type="button" class="sql-hotspot" aria-pressed="false" aria-controls="hero-sql" data-event="hero_sql_toggled"><span class="visually-hidden">Show the SQL behind this chart</span></button>
      <div class="sql-glass" id="hero-sql" hidden>
        <div class="sql-glass-head"><span>The query behind this chart</span><button type="button" class="sql-close" aria-label="Hide the SQL">×</button></div>
        <pre><code>${esc(sql)}</code></pre>
      </div>
    </div>
  </div>
  <figcaption><span class="hint-dot" aria-hidden="true"></span>Every number in Dataflare comes with the SQL that produced it. Flip the <strong>SQL</strong> switch to look through the chart.</figcaption>
</figure>`;
}

const DIAGRAM = `<svg class="diagram" viewBox="0 0 760 330" role="img" aria-labelledby="diagram-title diagram-desc">
  <title id="diagram-title">How Dataflare is deployed</title>
  <desc id="diagram-desc">Browsers, coding agents and you talk to a Dataflare Worker inside your own Cloudflare account. The Worker stores events, people, flags and experiments in D1 and session recordings in R2.</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker>
  </defs>
  <g class="d-sources" font-size="14">
    <rect x="8" y="34" width="170" height="64" rx="12"/><text x="93" y="62" text-anchor="middle" font-weight="600">Your site</text><text x="93" y="82" text-anchor="middle" class="d-muted">/s.js · events · replays</text>
    <rect x="8" y="133" width="170" height="64" rx="12"/><text x="93" y="161" text-anchor="middle" font-weight="600">Your coding agent</text><text x="93" y="181" text-anchor="middle" class="d-muted">MCP · CLI · HTTP</text>
    <rect x="8" y="232" width="170" height="64" rx="12"/><text x="93" y="260" text-anchor="middle" font-weight="600">You</text><text x="93" y="280" text-anchor="middle" class="d-muted">the dashboard</text>
  </g>
  <rect class="d-account" x="236" y="10" width="516" height="310" rx="18"/>
  <text x="256" y="38" class="d-label" font-size="13">YOUR CLOUDFLARE ACCOUNT</text>
  <g class="d-lines">
    <path d="M178 66 C 230 66, 240 160, 296 160" marker-end="url(#arrow)"/>
    <path d="M178 165 L 296 165" marker-end="url(#arrow)"/>
    <path d="M178 264 C 230 264, 240 170, 296 170" marker-end="url(#arrow)"/>
    <path d="M466 150 C 510 150, 520 96, 560 96" marker-end="url(#arrow)"/>
    <path d="M466 180 C 510 180, 520 238, 560 238" marker-end="url(#arrow)"/>
  </g>
  <g font-size="14">
    <rect class="d-worker" x="298" y="118" width="168" height="94" rx="14"/>
    <text x="382" y="152" text-anchor="middle" font-weight="700" class="d-on">Dataflare Worker</text>
    <text x="382" y="174" text-anchor="middle" class="d-on-muted">ingest · flags · API</text>
    <text x="382" y="193" text-anchor="middle" class="d-on-muted">dashboard · MCP</text>
    <rect class="d-store" x="562" y="62" width="172" height="70" rx="12"/>
    <text x="648" y="91" text-anchor="middle" font-weight="600">D1</text>
    <text x="648" y="112" text-anchor="middle" class="d-muted">events · people · flags</text>
    <rect class="d-store" x="562" y="204" width="172" height="70" rx="12"/>
    <text x="648" y="233" text-anchor="middle" font-weight="600">R2</text>
    <text x="648" y="254" text-anchor="middle" class="d-muted">session recordings</text>
  </g>
</svg>`;

export function homePage(f: Facts): string {
  const compareCols = COMPETITORS.filter((c) =>
    ['posthog', 'google-analytics', 'plausible', 'amplitude'].includes(c.slug),
  );
  const tools = f.mcpToolNames
    .slice(0, 18)
    .map((t) => `<li><code>${esc(t)}</code></li>`)
    .join('');
  const body = `
<section class="hero">
  <div class="hero-glow" aria-hidden="true"></div>
  <div class="hero-inner">
    <a class="pill" href="/changelog/"><span>New</span> Dataflare ${esc(f.version)}: explorable reports, key events and a cost page</a>
    <h1>Product analytics that lives in <em>your</em> Cloudflare account.</h1>
    <p class="lede">Web analytics, funnels and retention, session replay, feature flags and A/B tests. Open source, deployed with one command, and ready for your coding agent. Your data never leaves your account.</p>
    <div class="hero-actions">
      ${command(INSTALL)}
      <a class="button ghost-light" href="/demo/" data-event="demo_opened">Try the live demo <span aria-hidden="true">→</span></a>
    </div>
    <div class="agent-prompt">
      <p><span class="agent-label">Or paste this into your coding agent</span><span id="agent-prompt">${esc(AGENT_PROMPT)}</span></p>
      <button type="button" class="copy" data-copy-from="agent-prompt" data-event="agent_prompt_copied">Copy</button>
    </div>
    ${heroFigure(f.heroSql, f.heroLayout)}
  </div>
</section>

<section class="facts" aria-label="Dataflare at a glance">
  <ul>
    <li><strong>MIT</strong><span>open source</span></li>
    <li><strong>${esc(f.sdkKb)} KB</strong><span>browser SDK, gzipped</span></li>
    <li><strong>${f.mcpTools}</strong><span>MCP tools for agents</span></li>
    <li><strong>1</strong><span>command to deploy</span></li>
    <li><strong>$0</strong><span>on Workers Free for small sites</span></li>
  </ul>
</section>

<section class="section tour" id="product" aria-labelledby="tour-title">
  <div class="section-head">
    <p class="eyebrow">One event stream, five tools</p>
    <h2 id="tour-title">Everything a product team checks, in one place</h2>
    <p>Dataflare replaces the separate tools for web stats, product analytics, session replay and experiments. They share one event stream, so a funnel step links to the replays of the people who dropped out, and an experiment reads the same events as your reports.</p>
  </div>
  <div class="tabs" role="tablist" aria-label="Product tour">
    ${TOUR.map((t, i) => `<button type="button" role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${t.label}</button>`).join('\n    ')}
  </div>
  ${TOUR.map(
    (
      t,
      i,
    ) => `<div class="tour-panel" role="tabpanel" id="panel-${t.id}" aria-labelledby="tab-${t.id}"${i === 0 ? '' : ' data-inactive'}>
    <div class="tour-copy">
      <h3>${esc(t.title)}</h3>
      <p>${esc(t.text)}</p>
      <ul class="checks">${t.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      <p class="tour-links"><a class="button small" href="${t.demo}">Open in the demo</a> <a href="${t.docs}">Read the docs</a></p>
    </div>
    <div class="tour-shot frame">${shot(t.shot, t.alt, { dark: t.dark })}</div>
  </div>`,
  ).join('\n  ')}
</section>

<section class="section how" aria-labelledby="how-title">
  <div class="section-head">
    <p class="eyebrow">How it works</p>
    <h2 id="how-title">No Dataflare server. No Dataflare account. No Dataflare bill.</h2>
    <p>Dataflare is a Worker, a D1 database and an R2 bucket in your own Cloudflare account. The Worker that runs is the open-source code in the repository.</p>
  </div>
  <div class="how-grid">
    <ol class="steps">
      <li>
        <h3>Run one command</h3>
        <p><code>${INSTALL}</code> creates the database, the replay bucket and the Worker, sends a test event, and writes agent instructions and an MCP config into your project.</p>
      </li>
      <li>
        <h3>Add one script tag</h3>
        <p>Or let your agent do it. Page views, clicks, errors and Core Web Vitals arrive straight away. Custom events are one line: <code>glass.capture('signup_completed')</code>.</p>
      </li>
      <li>
        <h3>Ask</h3>
        <p>Open the dashboard, or ask your agent <em>"Why did signups drop last week?"</em> Upgrades ship from your CI, never from a laptop.</p>
      </li>
    </ol>
    <div class="diagram-wrap">${DIAGRAM}</div>
  </div>
</section>

<section class="section agents" aria-labelledby="agents-title">
  <div class="agents-grid">
    <div>
      <p class="eyebrow">Built for coding agents</p>
      <h2 id="agents-title">Your agent can install it, query it and act on it</h2>
      <p>Analytics usually stops at a dashboard. Dataflare gives your agent the same access you have, through an MCP server, a CLI with <code>--json</code> everywhere and an HTTP API. Every answer carries the SQL that produced it and a link to the same view, so you can check its work.</p>
      <ul class="tool-list" aria-label="Some of the MCP tools">${tools}<li class="more"><a href="/docs/agents/#tools">all ${f.mcpTools} tools</a></li></ul>
      <p><a href="/guides/coding-agents/">Add analytics with your coding agent →</a></p>
    </div>
    <div class="transcript" role="log" aria-label="An example session in a coding agent with the Dataflare MCP server">
      <p class="turn user">Signups dropped this week. Find out why.</p>
      <p class="turn tool">overview <span>from: "-7d"</span></p>
      <p class="turn result">Visitors steady (+2%). signup_completed down 31% vs the previous period.</p>
      <p class="turn tool">query_funnel <span>steps: pricing → signup_started → signup_completed · breakdown: browser</span></p>
      <p class="turn result">Safari: 412 started, 38 completed (9.2%). Chrome 64.0%, Firefox 61.5%.</p>
      <p class="turn tool">list_replays <span>did_event: signup_started · not_event: signup_completed</span></p>
      <p class="turn tool">summarise_replay <span>session: "01a2…"</span></p>
      <p class="turn result">00:41 Rage-clicked "Create account" (button) ×5<br>00:42 ERROR TypeError: crypto.randomUUID is not a function</p>
      <p class="turn agent">Safari 15 has no <code>crypto.randomUUID</code>, so the signup form throws on submit. I've added a fallback and a test. Want me to ship it behind a flag and watch the funnel?</p>
    </div>
  </div>
</section>

<section class="section cost" aria-labelledby="cost-title">
  <div class="cost-grid">
    <div>
      <p class="eyebrow">What it costs</p>
      <h2 id="cost-title">Your Cloudflare bill. That's it.</h2>
      <p>There is no Dataflare subscription. You pay Cloudflare's list prices for the Worker, database and storage Dataflare uses, and most sites fit inside the free plan or the $5 Workers Paid plan.</p>
      <p><a href="/pricing/">Full calculator, line by line →</a></p>
    </div>
    <div class="calc compact" data-calculator="compact">
      <noscript><p>The calculator needs JavaScript. Short version: $0 for small sites, $5 a month for most others. <a href="/pricing/">See the pricing page.</a></p></noscript>
    </div>
  </div>
</section>

<section class="section compare" aria-labelledby="compare-title">
  <div class="section-head">
    <p class="eyebrow">How it compares</p>
    <h2 id="compare-title">The core of PostHog or Amplitude, in your own account</h2>
    <p>Dataflare isn't the right tool for everyone, and each comparison says where the other product is the better choice.</p>
  </div>
  <div class="table-wrap">
    <table class="compare-table">
      <thead><tr><th scope="col"><span class="visually-hidden">Feature</span></th><th scope="col" class="glass-col">Dataflare</th>${compareCols.map((c) => `<th scope="col"><a href="/vs/${c.slug}/">${esc(c.name)}</a></th>`).join('')}</tr></thead>
      <tbody>
        ${ROWS.map(([key, label]) => `<tr><th scope="row">${esc(label)}</th><td class="glass-col">${esc(GLASS[key])}</td>${compareCols.map((c) => `<td>${esc(c.table[key])}</td>`).join('')}</tr>`).join('\n        ')}
      </tbody>
    </table>
  </div>
  <p class="compare-more">More: ${COMPETITORS.map((c) => `<a href="/vs/${c.slug}/">Dataflare vs ${esc(c.name)}</a>`).join(' · ')}</p>
</section>

<section class="section faq" aria-labelledby="faq-title">
  <div class="section-head"><p class="eyebrow">Questions</p><h2 id="faq-title">Frequently asked</h2></div>
  <div class="faq-list">
    ${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join('\n    ')}
  </div>
</section>

<section class="section oss" aria-labelledby="oss-title">
  <div class="oss-card">
    <div>
      <p class="eyebrow">Open source</p>
      <h2 id="oss-title">Read it, fork it, add to it</h2>
      <p>Dataflare is MIT licensed. Adding a query type, an MCP tool, a storage engine or a framework snippet is one file each, and the roadmap marks good first issues.</p>
    </div>
    <div class="oss-actions">
      <a class="button primary" href="${REPO}">Star on GitHub</a>
      <a class="button" href="${REPO}/blob/main/CONTRIBUTING.md">Contributing guide</a>
      <a class="button" href="${REPO}/blob/main/ROADMAP.md">Roadmap</a>
    </div>
  </div>
</section>

<section class="closing" aria-labelledby="start-title">
  <h2 id="start-title">Two minutes from here to your first chart</h2>
  <p>You need a Cloudflare account and an API token.</p>
  ${command(INSTALL)}
  <p class="closing-links"><a href="/docs/getting-started/">Getting started</a> · <a href="/demo/">Live demo</a> · <a href="/guides/">Framework guides</a></p>
</section>`;

  return layout({
    path: '/',
    title: 'Dataflare Analytics: open-source product analytics in your own Cloudflare account',
    description:
      'Open-source web analytics, product analytics, session replay, feature flags and A/B tests that run in your own Cloudflare account. One command to install, queried by your coding agent, $0 for small sites.',
    body,
    markdown: '/index.md',
    scripts: ['/calculator.js'],
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Dataflare Analytics',
        alternateName: 'Dataflare',
        url: SITE_URL,
        description:
          'Open-source web analytics, product analytics, session replay, feature flags and A/B tests that run in your own Cloudflare account.',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Cloudflare Workers',
        softwareVersion: f.version,
        license: 'https://opensource.org/licenses/MIT',
        image: `${SITE_URL}/img/og.png`,
        screenshot: `${SITE_URL}/img/web-light.webp`,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        featureList: [
          'Web analytics',
          'Funnels, retention and trends',
          'Session replay with text transcripts',
          'Feature flags',
          'A/B testing with Bayesian results',
          'MCP server for coding agents',
          'Read-only SQL',
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareSourceCode',
        name: 'Dataflare Analytics',
        codeRepository: REPO,
        programmingLanguage: 'TypeScript',
        license: 'https://opensource.org/licenses/MIT',
        runtimePlatform: 'Cloudflare Workers',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: FAQ.map(([q, a]) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: stripTags(a) },
        })),
      },
    ],
  });
}
