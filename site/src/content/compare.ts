/**
 * Comparison pages (/vs/<slug>/) and the homepage comparison table.
 *
 * Rules for this file: every claim about another product comes from that
 * product's own pages (linked in `sources`) or is long-standing public fact,
 * and FACTS_CHECKED in config.ts says when. Say where the other product is
 * better. When a fact can't be confirmed, leave it out rather than guess.
 */

export interface Competitor {
  slug: string;
  name: string;
  /** One line: what it is. */
  what: string;
  /** Meta description for /vs/<slug>/. */
  description: string;
  /** The short answer, two or three sentences. */
  verdict: string;
  table: Record<Row, string>;
  /** Where the other product is the better choice. */
  theyWin: string[];
  /** Where Dataflare is the better choice. */
  glassWins: string[];
  /** Moving over: concrete steps. */
  switching: string[];
  sources: [string, string][];
}

export type Row =
  | 'data'
  | 'license'
  | 'pricing'
  | 'cookieless'
  | 'web'
  | 'product'
  | 'replay'
  | 'flags'
  | 'sql';

export const ROWS: [Row, string][] = [
  ['data', 'Where your data lives'],
  ['license', 'Source code'],
  ['pricing', 'What you pay'],
  ['cookieless', 'Cookieless mode'],
  ['web', 'Web analytics'],
  ['product', 'Funnels and retention'],
  ['replay', 'Session replay'],
  ['flags', 'Feature flags and A/B tests'],
  ['sql', 'Raw SQL on your events'],
];

export const GLASS: Record<Row, string> = {
  data: 'Your own Cloudflare account (D1 and R2)',
  license: 'Open source, MIT',
  pricing:
    'Your Cloudflare bill: $0 on Workers Free for small sites, $5/month Workers Paid above that',
  cookieless: 'Yes',
  web: 'Yes, with Core Web Vitals, error tracking and revenue',
  product:
    'Yes: trends, funnels, retention, user paths, cohorts, correlation, group (account) analytics, dashboards with scheduled Slack and email reports, and alerts',
  replay: 'Yes, with a text transcript for agents',
  flags:
    'Yes: payloads, targeting, schedules and early access; experiments with several metrics, holdouts, Bayesian or frequentist',
  sql: 'Yes, read-only SQL in the dashboard, CLI and MCP',
};

export const COMPETITORS: Competitor[] = [
  {
    slug: 'posthog',
    name: 'PostHog',
    what: 'an all-in-one product platform: analytics, replay, flags, experiments, surveys and more',
    description:
      'Dataflare vs PostHog: both are open source with analytics, session replay, flags and experiments. PostHog is a hosted platform; Dataflare runs in your own Cloudflare account.',
    verdict:
      'PostHog is the closest product to Dataflare and does more: surveys, a data warehouse, LLM analytics, mobile SDKs and a hosted cloud with a team behind it. Choose Dataflare if you want the core of that (web and product analytics, replay, flags and experiments) running in your own Cloudflare account, with no vendor, no usage-based bill and an agent that can query it from the first minute.',
    table: {
      data: 'PostHog Cloud (US or EU), or your own servers',
      license: 'Open source (MIT, with some paid features under a separate licence)',
      pricing: 'Free monthly allowance, then usage-based per product',
      cookieless: 'Yes (configurable persistence)',
      web: 'Yes',
      product: 'Yes, extensive',
      replay: 'Yes, web and mobile',
      flags: 'Yes',
      sql: 'Yes (HogQL / SQL insights)',
    },
    theyWin: [
      'More products in one place: surveys, a data warehouse, LLM analytics, heatmaps, a visual editor for web experiments.',
      'Mobile SDKs (iOS, Android, React Native, Flutter) and many server SDKs.',
      'A hosted cloud with support, SSO and team permissions.',
      'Years of production use at very large scale.',
    ],
    glassWins: [
      'There is no Dataflare server: the Worker, database and recordings are in your Cloudflare account, under your contracts and your data region.',
      "No usage-based bill from a vendor. You pay Cloudflare's list prices, which for most sites means $0 or the $5 Workers Paid plan.",
      'Self-hosting needs no servers, Docker or ClickHouse cluster. One command deploys it, and CI upgrades it.',
      '`dataflare init` writes agent instructions, a Claude Code skill and an MCP config, and every query result carries its SQL and a dashboard link.',
    ],
    switching: [
      'Run `npx dataflare-cli init` and add the script tag next to PostHog for a week, so you can compare numbers.',
      'Rename `posthog.capture(...)` calls to `glass.capture(...)`; event names and properties carry over unchanged. `posthog.identify(id, props)` becomes `glass.identify(id, props)`.',
      'Recreate your key funnels and retention charts in Insights, or ask your agent to (the MCP tools take the same shapes).',
      'Move flags: `posthog.getFeatureFlag(key)` becomes `glass.flag(key)`. Create the flag with the same key in Dataflare first.',
    ],
    sources: [
      ['PostHog pricing', 'https://posthog.com/pricing'],
      ['PostHog self-hosting', 'https://posthog.com/docs/self-host'],
      ['PostHog licence', 'https://github.com/PostHog/posthog/blob/master/LICENSE'],
    ],
  },
  {
    slug: 'google-analytics',
    name: 'Google Analytics',
    what: "Google's free web and app analytics (GA4)",
    description:
      'Dataflare vs Google Analytics 4: GA4 is free and tied into Google Ads. Dataflare is open source, keeps data in your Cloudflare account, and adds funnels, session replay and A/B tests.',
    verdict:
      "Google Analytics is free, everywhere, and the right tool if you buy Google Ads and want conversions to flow into them. Choose Dataflare if you'd rather not send visitor data to Google, want a dashboard you can read without training, need session replay or A/B tests, or want your coding agent to answer questions about your traffic.",
    table: {
      data: "Google's servers",
      license: 'Proprietary',
      pricing: 'Free (GA4); Analytics 360 is a paid enterprise tier',
      cookieless: 'No; uses cookies (consent mode can limit them)',
      web: 'Yes',
      product: 'Yes (explorations)',
      replay: 'No',
      flags: 'No',
      sql: 'Through BigQuery export',
    },
    theyWin: [
      'Free at any volume for most sites.',
      'Tight integration with Google Ads, Search Console and BigQuery.',
      'Demographics and audiences built from Google signals.',
      'Every marketer already knows it.',
    ],
    glassWins: [
      "Visitor data stays in your Cloudflare account and isn't used by an ad network.",
      'Cookieless mode stores nothing on the device.',
      'Session replay, feature flags and A/B tests in the same place as your analytics.',
      'Every number shows the SQL behind it, and raw events are yours to query without an export pipeline.',
      'Loads nothing from third-party domains when you serve Dataflare from your own domain with `--route`.',
    ],
    switching: [
      'Run `npx dataflare-cli init` and add the script tag; keep GA4 running in parallel while you compare.',
      'Map your GA4 key events to `glass.capture()` calls. Pageviews, referrers, UTM tags, countries and devices are collected automatically.',
      'Mark your conversions as key events so Reports show conversion by source.',
      "When you're happy, remove the gtag snippet (and, if you can, your cookie banner's analytics category).",
    ],
    sources: [
      ['GA4 data retention', 'https://support.google.com/analytics/answer/7667196'],
      ['Google Analytics 360', 'https://marketingplatform.google.com/about/analytics-360/'],
    ],
  },
  {
    slug: 'plausible',
    name: 'Plausible',
    what: 'simple, privacy-friendly web analytics, hosted in the EU',
    description:
      'Dataflare vs Plausible: both are cookieless and open source. Plausible is hosted web analytics; Dataflare adds product analytics, session replay, flags and A/B tests, and runs in your Cloudflare account.',
    verdict:
      "Plausible is a lovely, focused product: one page of web stats, hosted in the EU, with nothing to run. Choose Dataflare if you've outgrown web stats and need product analytics (funnels, retention, people), session replay or experiments, or if you'd rather keep the data in your own Cloudflare account than pay a subscription.",
    table: {
      data: 'Plausible Cloud (EU), or your own servers (Community Edition)',
      license: 'Open source (AGPL-3.0, Community Edition)',
      pricing: 'From $9/month for 10k monthly pageviews; 30-day free trial',
      cookieless: 'Yes, always',
      web: 'Yes',
      product: 'Goals, funnels and user journeys, scroll depth, revenue attribution, segments',
      replay: 'No',
      flags: 'No',
      sql: 'No (Stats API)',
    },
    theyWin: [
      'Nothing to deploy or maintain on the hosted plans.',
      'A single, very simple dashboard, with email and Slack reports and embeddable shared dashboards.',
      'Google Analytics import and a Looker Studio connector.',
      'EU-owned infrastructure, a mature product and a long track record.',
    ],
    glassWins: [
      'Product analytics on any event and person: trends, retention, cohorts, people and accounts, beyond web funnels.',
      'Session replay, feature flags and A/B tests.',
      "No subscription: you pay Cloudflare's list prices, often $0.",
      'Raw SQL on every event, and an MCP server so your agent can query it.',
    ],
    switching: [
      'Run `npx dataflare-cli init` and add the script tag alongside Plausible.',
      '`plausible("Signup", { props: { plan } })` becomes `glass.capture("signup_completed", { plan })`.',
      'Use cookieless mode (`data-persistence="cookieless"`) if you want the same no-cookie behaviour as Plausible.',
    ],
    sources: [
      ['Plausible pricing', 'https://plausible.io/#pricing'],
      ['Plausible features', 'https://plausible.io/'],
      ['Plausible Community Edition', 'https://github.com/plausible/analytics'],
    ],
  },
  {
    slug: 'amplitude',
    name: 'Amplitude',
    what: 'an enterprise product analytics platform',
    description:
      'Dataflare vs Amplitude: Amplitude is a hosted analytics platform with a free plan. Dataflare is open source, runs in your Cloudflare account, and is queried by your coding agent.',
    verdict:
      'Amplitude is the reference for behavioural analytics: deep charts, governance and a large team behind it. Choose Dataflare if you want the essentials (trends, funnels, retention, cohorts, replay and experiments) in your own Cloudflare account, without per-event pricing or a sales call, and with SQL you can read under every number.',
    table: {
      data: "Amplitude's cloud (US or EU)",
      license: 'Proprietary',
      pricing: 'Free plan (2M events/month); paid plans scale with events or users',
      cookieless: 'Configurable',
      web: 'Yes',
      product: 'Yes, extensive',
      replay: 'Yes',
      flags: 'Yes (Amplitude Experiment)',
      sql: 'Through data exports and warehouse syncs',
    },
    theyWin: [
      'More analysis types, governance, a data dictionary with approvals, and enterprise permissions.',
      'Mobile and server SDKs for most platforms.',
      'Support, SLAs and onboarding from a large vendor.',
    ],
    glassWins: [
      'Your events stay in your Cloudflare account, and you can read every row.',
      "No event-based price tiers: you pay Cloudflare's list prices.",
      'Open source and MIT licensed, so you can change it, from a new query type to a new MCP tool.',
      'Built for coding agents from install: instructions, a skill and an MCP server are written for you.',
    ],
    switching: [
      'Run `npx dataflare-cli init` and add the script tag.',
      '`amplitude.track(name, props)` becomes `glass.capture(name, props)`; `setUserId` plus `identify` becomes `glass.identify(id, props)`.',
      'Recreate key charts in Insights; the filter editor and breakdowns work the same way (where/and on any event or person property).',
    ],
    sources: [['Amplitude pricing', 'https://amplitude.com/pricing']],
  },
  {
    slug: 'mixpanel',
    name: 'Mixpanel',
    what: 'a hosted product analytics platform',
    description:
      'Dataflare vs Mixpanel: Mixpanel is hosted product analytics with a free plan. Dataflare is open source, runs in your Cloudflare account, and includes session replay, flags and experiments.',
    verdict:
      "Mixpanel is fast, polished event analytics with a generous free plan. Choose Dataflare if you want your events in your own Cloudflare account, prefer Cloudflare's prices to per-event tiers, or want an agent to answer analytics questions with the SQL to back them up.",
    table: {
      data: "Mixpanel's cloud (US or EU)",
      license: 'Proprietary',
      pricing: 'Free plan (1M events/month); Growth plan priced by events',
      cookieless: 'Configurable',
      web: 'Yes',
      product: 'Yes, extensive',
      replay: 'Yes',
      flags: 'Yes',
      sql: 'Through data pipelines and warehouse connectors',
    },
    theyWin: [
      'A mature, fast analysis UI with years of polish.',
      'SDKs for mobile and most server languages.',
      'Hosted, with support and enterprise controls.',
    ],
    glassWins: [
      'Data stays in your Cloudflare account.',
      "No per-event tiers: Cloudflare's list prices instead.",
      'Open source (MIT): read and change everything.',
      'An MCP server and CLI written into your project by `dataflare init`, so your agent can query and instrument straight away.',
    ],
    switching: [
      'Run `npx dataflare-cli init` and add the script tag.',
      '`mixpanel.track(name, props)` becomes `glass.capture(name, props)`; `mixpanel.identify(id)` plus `people.set(props)` becomes `glass.identify(id, props)`.',
      'Recreate funnels and retention in Insights or ask your agent to.',
    ],
    sources: [['Mixpanel pricing', 'https://mixpanel.com/pricing/']],
  },
  {
    slug: 'umami',
    name: 'Umami',
    what: 'open-source, cookieless web analytics, self-hosted or on Umami Cloud',
    description:
      'Dataflare vs Umami: both are open source and cookieless. Umami needs a server and database to self-host; Dataflare deploys into your Cloudflare account with one command and adds feature flags and A/B tests.',
    verdict:
      'Umami is a clean, open-source analytics tool that has grown well beyond web stats: funnels, journeys, retention, cohorts, revenue, error tracking, replays and heatmaps, with a free cloud tier. Choose Dataflare if you want to self-host without running a server or database, or need feature flags and A/B tests.',
    table: {
      data: 'Umami Cloud, or your own server and database',
      license: 'Open source (MIT)',
      pricing: 'Cloud: free up to 100k events/month, Pro $20/month; self-hosting is free',
      cookieless: 'Yes',
      web: 'Yes',
      product: 'Funnels, journeys, retention, cohorts, segments, revenue and attribution',
      replay: 'Yes, with heatmaps',
      flags: 'No',
      sql: 'Direct database access when self-hosted',
    },
    theyWin: [
      'A free hosted tier with nothing to deploy.',
      'A long-standing, popular project with a large community.',
    ],
    glassWins: [
      'Self-hosting without a server, Docker or Postgres: Dataflare is a Worker, D1 and R2 in your Cloudflare account.',
      'Feature flags and A/B tests, and session replay with agent-readable transcripts.',
      'People and accounts: identify() links anonymous visits to users, so funnels span signup, and groups count companies.',
    ],
    switching: [
      'Run `npx dataflare-cli init` and add the script tag.',
      '`umami.track(name, data)` becomes `glass.capture(name, data)`.',
    ],
    sources: [
      ['Umami pricing', 'https://umami.is/pricing'],
      ['Umami features', 'https://umami.is/features'],
      ['Umami on GitHub', 'https://github.com/umami-software/umami'],
    ],
  },
  {
    slug: 'cloudflare-web-analytics',
    name: 'Cloudflare Web Analytics',
    what: "Cloudflare's free, privacy-first web analytics",
    description:
      'Dataflare vs Cloudflare Web Analytics: both run on Cloudflare. Web Analytics is free page-view stats with no custom events; Dataflare adds events, funnels, people, session replay and A/B tests in your own account.',
    verdict:
      "Cloudflare Web Analytics is free and needs no setup if your site is already behind Cloudflare. It counts page views and visitors, and doesn't support custom events. Dataflare runs on the same platform, in your account, and covers what comes next: events, funnels, retention, people, replay and experiments.",
    table: {
      data: "Cloudflare's analytics platform",
      license: 'Proprietary',
      pricing: 'Free',
      cookieless: 'Yes',
      web: 'Yes (page views, visitors, performance)',
      product: 'No (no custom events)',
      replay: 'No',
      flags: 'No',
      sql: 'GraphQL API on sampled data',
    },
    theyWin: ['Free, and on by default for proxied sites.', 'Nothing to deploy or upgrade.'],
    glassWins: [
      'Custom events, people, funnels, retention and cohorts.',
      'Unsampled, row-level events in your own D1 database.',
      'Session replay, feature flags and A/B tests.',
      'An MCP server for your coding agent.',
    ],
    switching: [
      'Keep Web Analytics if you like; Dataflare runs alongside it.',
      'Run `npx dataflare-cli init`, add the script tag, and add `glass.capture()` for the actions that matter.',
    ],
    sources: [
      ['About Cloudflare Web Analytics', 'https://developers.cloudflare.com/web-analytics/about/'],
      ['Web Analytics FAQ', 'https://developers.cloudflare.com/web-analytics/faq/'],
    ],
  },
];
