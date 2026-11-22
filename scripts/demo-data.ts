/**
 * Synthetic demo data for screenshots and the public demo: ten weeks of a
 * made-up writing app, "Inkwell" (the same app as examples/demo-site).
 *
 * Everything goes through the real ingest endpoints of a dev server, so the
 * data is shaped exactly like production data. The random generator is seeded,
 * so the same run gives the same numbers (relative to the current date).
 *
 *   const server = await startDevServer({ memory: true, port: 0, demoPort: 0 });
 *   await seedDemo(server);
 */

import type { DevServer } from '../packages/worker/test/server.ts';

const DAY = 86_400_000;
const WEEKS = 10;
const SITE = 'https://inkwell.example';

let state = 20251104;
function rnd(): number {
  state = (state * 16807) % 2147483647;
  return state / 2147483647;
}
function pick<T>(options: [T, number][]): T {
  const total = options.reduce((sum, [, w]) => sum + w, 0);
  let r = rnd() * total;
  for (const [value, weight] of options) {
    r -= weight;
    if (r <= 0) return value;
  }
  return options[0]![0];
}
function hexId(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(rnd() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`;
}

const DEVICES: [string, number][] = [
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    34,
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    26,
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    12,
  ],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 8],
  [
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    11,
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    9,
  ],
];
const COUNTRIES: [string, number][] = [
  ['US', 31],
  ['GB', 18],
  ['DE', 9],
  ['IN', 7],
  ['FR', 6],
  ['CA', 6],
  ['NL', 4],
  ['AU', 4],
  ['BR', 3],
  ['SE', 3],
  ['ES', 3],
  ['JP', 2],
  ['IE', 2],
  ['PL', 2],
];
/** [referrer, utm query, signup propensity multiplier] */
const SOURCES: [[string | null, string, number], number][] = [
  [[null, '', 1.1], 26],
  [['https://www.google.com/', '', 1], 27],
  [['https://news.ycombinator.com/', '', 0.7], 8],
  [['https://www.reddit.com/r/writing/', '', 0.8], 6],
  [['https://duckduckgo.com/', '', 1], 4],
  [['https://www.bing.com/', '', 1], 3],
  [['https://github.com/', '', 0.6], 3],
  [['https://t.co/', '?utm_source=twitter&utm_medium=social&utm_campaign=launch-week', 0.8], 6],
  [[null, '?utm_source=newsletter&utm_medium=email&utm_campaign=october-digest', 1.6], 7],
  [
    [
      'https://www.facebook.com/',
      '?utm_source=meta&utm_medium=paid&utm_campaign=autumn-writers',
      0.9,
    ],
    6,
  ],
  [['https://www.producthunt.com/', '?utm_source=producthunt&utm_medium=referral', 1.2], 4],
];
const LANDING: [string, number][] = [
  ['/', 44],
  ['/blog/writing-every-day', 12],
  ['/templates', 10],
  ['/pricing', 9],
  ['/blog/markdown-for-writers', 8],
  ['/docs', 6],
  ['/changelog', 4],
  ['/features/focus-mode', 7],
];
const NEXT: [string, number][] = [
  ['/pricing', 24],
  ['/templates', 14],
  ['/features/focus-mode', 10],
  ['/docs', 9],
  ['/blog/writing-every-day', 6],
  ['/changelog', 6],
  ['/about', 4],
  ['/', 12],
];
/** Where people go next from each page, so paths have the shape real journeys do. */
const FLOW: Record<string, [string, number][]> = {
  '/': [
    ['/pricing', 30],
    ['/templates', 16],
    ['/features/focus-mode', 14],
    ['/blog/writing-every-day', 6],
    ['/docs', 6],
    ['/about', 4],
  ],
  '/pricing': [
    ['/docs', 14],
    ['/features/focus-mode', 10],
    ['/', 8],
    ['/templates', 8],
    ['/changelog', 4],
    ['/about', 3],
  ],
  '/templates': [
    ['/pricing', 18],
    ['/features/focus-mode', 8],
    ['/', 6],
    ['/docs', 4],
  ],
  '/features/focus-mode': [
    ['/pricing', 22],
    ['/templates', 6],
    ['/', 4],
  ],
  '/blog/writing-every-day': [
    ['/blog/markdown-for-writers', 10],
    ['/', 8],
    ['/templates', 8],
    ['/pricing', 6],
  ],
  '/blog/markdown-for-writers': [
    ['/templates', 10],
    ['/', 6],
    ['/pricing', 4],
  ],
  '/docs': [
    ['/changelog', 8],
    ['/pricing', 8],
    ['/', 4],
  ],
  '/changelog': [
    ['/docs', 6],
    ['/pricing', 6],
    ['/', 4],
  ],
};
const TITLES: Record<string, string> = {
  '/': 'Inkwell: a calm place to write',
  '/pricing': 'Pricing, Inkwell',
  '/templates': 'Templates, Inkwell',
  '/docs': 'Docs, Inkwell',
  '/changelog': 'Changelog, Inkwell',
  '/about': 'About, Inkwell',
  '/signup': 'Sign up, Inkwell',
  '/app': 'Inkwell',
  '/features/focus-mode': 'Focus mode, Inkwell',
  '/blog/writing-every-day': 'How to write every day, Inkwell',
  '/blog/markdown-for-writers': 'Markdown for writers, Inkwell',
};
const VITALS: Record<string, () => number> = {
  LCP: () => 900 + rnd() ** 2 * 3600,
  INP: () => 40 + rnd() ** 2 * 420,
  CLS: () => rnd() ** 3 * 0.32,
  FCP: () => 500 + rnd() ** 2 * 2600,
  TTFB: () => 80 + rnd() ** 2 * 1100,
};
const ERRORS: [{ type: string; message: string; path: string }, number][] = [
  [
    {
      type: 'TypeError',
      message: "Cannot read properties of undefined (reading 'wordCount')",
      path: '/app',
    },
    5,
  ],
  [{ type: 'TypeError', message: 'Failed to fetch', path: '/app' }, 3],
  [{ type: 'TypeError', message: 'crypto.randomUUID is not a function', path: '/signup' }, 2],
  [{ type: 'Error', message: 'ResizeObserver loop limit exceeded', path: '/templates' }, 2],
];
const TEMPLATES: [string, number][] = [
  ['blank', 40],
  ['daily-journal', 22],
  ['blog-post', 18],
  ['newsletter', 11],
  ['novel-chapter', 9],
];

type Wire = Record<string, unknown> & { event: string; ts: number };

interface Person {
  id: string;
  distinct: string;
  device: string;
  country: string;
  plan: string;
  signedUpAt: number;
  engagement: number;
}

export interface SeedResult {
  visitors: number;
  events: number;
  people: number;
}

/** Fill a dev server's "demo" project with ten weeks of data. */
export async function seedDemo(server: DevServer, now = Date.now()): Promise<SeedResult> {
  const G = server.glassUrl;
  const db = server.env.DB;
  const admin = { Authorization: 'Bearer dev-admin-key', 'Content-Type': 'application/json' };
  let sent = 0;
  let visitorCount = 0;

  async function api(method: string, path: string, body: unknown): Promise<void> {
    const r = await fetch(G + path, { method, headers: admin, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  }

  // Ingest pulls timestamps more than 7 days old up to that limit (a guard
  // against bad device clocks). The dev server runs in this process, so for
  // history we move its clock to each batch's time while it is sent.
  const realNow = Date.now;
  async function send(device: string, country: string, ip: string, events: Wire[]) {
    if (!events.length) return;
    for (let i = 0; i < events.length; i += 50) {
      const batch = events.slice(i, i + 50);
      const clock = Math.min(now, Math.max(...batch.map((e) => e.ts)) + 5_000);
      Date.now = () => clock;
      const r = await fetch(`${G}/e`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': device,
          'CF-IPCountry': country,
          'CF-Connecting-IP': ip,
        },
        body: JSON.stringify({ project: 'demo', sent_at: clock, lib: 'seed', events: batch }),
      }).finally(() => {
        Date.now = realNow;
      });
      if (!r.ok) throw new Error(`/e: ${r.status} ${await r.text()}`);
      sent += batch.length;
    }
  }

  await db.prepare("UPDATE projects SET name = 'Inkwell' WHERE id = 'demo'").run();

  // Revenue settings before any payment arrives, so payments are converted at ingest.
  await api('PATCH', '/api/settings', {
    project: 'demo',
    settings: {
      baseCurrency: 'USD',
      revenueEvents: [
        {
          event: 'subscription_started',
          amountProperty: 'amount',
          productProperty: 'plan',
          subscriptionProperty: 'subscription',
        },
      ],
      internalFilters: [{ property: 'person.email', op: 'contains', value: '@inkwell.test' }],
    },
  });

  // Flags and experiments first, so exposures line up with real definitions.
  await api('PUT', '/api/flags/new-editor', {
    project: 'demo',
    description: 'The rebuilt editor with inline comments.',
    enabled: true,
    rollout: 25,
  });
  await api('PUT', '/api/flags/ai-suggestions', {
    project: 'demo',
    description: 'Writing suggestions in the sidebar, for paying plans.',
    enabled: true,
    rollout: 0,
    rules: [
      { conditions: [{ property: 'person.plan', op: 'in', value: ['pro', 'team'] }], rollout: 100 },
    ],
  });
  await api('PUT', '/api/flags/offline-mode', {
    project: 'demo',
    description: 'Keep writing without a connection.',
    enabled: false,
    rollout: 0,
  });
  await api('POST', '/api/experiments', {
    project: 'demo',
    key: 'pricing-page-v2',
    goal: { event: 'signup_completed' },
    secondary: [{ kind: 'conversion', event: '$exception', goal: 'decrease', name: 'Errors' }],
    hypothesis: 'A shorter pricing page with one highlighted plan lifts signups.',
  });
  await api('POST', '/api/experiments/pricing-page-v2/start', { project: 'demo' });
  await api('POST', '/api/experiments', {
    project: 'demo',
    key: 'onboarding-checklist',
    goal: { event: 'document_created' },
    hypothesis: 'A three-step checklist gets new writers to their first document.',
  });
  await api('POST', '/api/experiments/onboarding-checklist/start', { project: 'demo' });
  await api('POST', '/api/experiments', {
    project: 'demo',
    key: 'annual-billing-nudge',
    goal: { event: 'subscription_started' },
    hypothesis: 'Showing the annual saving at checkout increases paid conversion.',
  });
  const pricingStart = now - 19 * DAY;
  const onboardingStart = now - 12 * DAY;
  await db
    .prepare("UPDATE experiments SET started_at = ? WHERE project = 'demo' AND key = ?")
    .bind(pricingStart, 'pricing-page-v2')
    .run();
  await db
    .prepare("UPDATE experiments SET started_at = ? WHERE project = 'demo' AND key = ?")
    .bind(onboardingStart, 'onboarding-checklist')
    .run();

  const people: Person[] = [];
  const start = now - WEEKS * 7 * DAY;

  for (let day = 0; day < WEEKS * 7; day++) {
    const dayStart = start + day * DAY;
    const weekday = new Date(dayStart).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // Growth, a weekly rhythm, a Product Hunt spike three weeks ago, and noise.
    const spike = day === WEEKS * 7 - 22 ? 2.3 : day === WEEKS * 7 - 21 ? 1.5 : 1;
    const visitors = Math.round(
      (46 + day * 1.05) * (weekend ? 0.62 : 1) * spike * (0.85 + rnd() * 0.3),
    );
    for (let v = 0; v < visitors; v++) {
      visitorCount++;
      const device = pick(DEVICES);
      const country = pick(COUNTRIES);
      const ip = `10.${visitorCount % 250}.${Math.floor(visitorCount / 250) % 250}.${(visitorCount * 7) % 250}`;
      const distinct = hexId();
      const session = hexId();
      const [referrer, utm, propensity] =
        spike > 1 && rnd() < 0.55
          ? ([
              'https://www.producthunt.com/',
              '?utm_source=producthunt&utm_medium=referral',
              1.2,
            ] as const)
          : pick(SOURCES);
      // Working hours in UTC-ish, with some night traffic.
      let t = dayStart + (6 + rnd() * 16) * 3_600_000;
      if (t > now - 60_000) continue;
      const events: Wire[] = [];
      const base = { distinct_id: distinct, session_id: session };
      const view = (path: string, first: boolean) => {
        events.push({
          ...base,
          id: hexId(),
          event: '$pageview',
          ts: t,
          url: SITE + path + (first ? utm : ''),
          referrer: first ? referrer : `${SITE}/`,
          title: TITLES[path] ?? 'Inkwell',
        });
        if (rnd() < 0.45) {
          const metric = pick<string>([
            ['LCP', 1],
            ['INP', 1],
            ['CLS', 1],
            ['FCP', 1],
            ['TTFB', 1],
          ]);
          events.push({
            ...base,
            id: hexId(),
            event: '$web_vitals',
            ts: t + 2500,
            url: SITE + path,
            props: { metric, value: Math.round(VITALS[metric]!() * 1000) / 1000 },
          });
        }
        t += 8_000 + rnd() ** 2 * 120_000;
      };

      let path = pick(LANDING);
      view(path, true);
      const depth = Math.floor(rnd() ** 1.6 * 5);
      let sawPricing = path === '/pricing';
      for (let p = 0; p < depth; p++) {
        path = pick(FLOW[path] ?? NEXT);
        sawPricing ||= path === '/pricing';
        view(path, false);
      }
      if (rnd() < 0.012) {
        const err = pick(ERRORS);
        events.push({
          ...base,
          id: hexId(),
          event: '$exception',
          ts: t,
          url: SITE + err.path,
          props: { type: err.type, message: err.message },
        });
      }

      // The pricing experiment: exposure on the pricing page, a lift for "test".
      let variant: string | null = null;
      if (sawPricing && t > pricingStart) {
        variant = rnd() < 0.5 ? 'control' : 'test';
        events.push({
          ...base,
          id: hexId(),
          event: '$exposure',
          ts: t - 4000,
          url: `${SITE}/pricing`,
          props: { flag: 'pricing-page-v2', variant },
        });
      }

      const startChance = (sawPricing ? 0.34 : 0.11) * propensity * (variant === 'test' ? 1.22 : 1);
      if (rnd() < startChance) {
        events.push({
          ...base,
          id: hexId(),
          event: 'signup_started',
          ts: t,
          url: `${SITE}/signup`,
          props: { source: sawPricing ? 'pricing' : 'header' },
        });
        t += 25_000 + rnd() * 60_000;
        const mobile = /iPhone|Android/.test(device);
        if (rnd() < (mobile ? 0.52 : 0.68)) {
          const id = `user_${people.length + 1001}`;
          const plan = pick<string>([
            ['free', 72],
            ['pro', 22],
            ['team', 6],
          ]);
          const size = pick<string>([
            ['1', 58],
            ['2-10', 24],
            ['11-50', 11],
            ['51-200', 5],
            ['200+', 2],
          ]);
          events.push({
            ...base,
            id: hexId(),
            event: '$identify',
            ts: t,
            user_id: id,
            props: {
              $set: { plan, email: `${id}@example.com`, company_size: size },
              $set_once: { signup_source: sawPricing ? 'pricing' : 'header' },
            },
          });
          events.push({
            ...base,
            id: hexId(),
            event: 'signup_completed',
            ts: t + 200,
            user_id: id,
            url: `${SITE}/welcome`,
            props: {
              plan,
              method: pick<string>([
                ['email', 55],
                ['google', 35],
                ['github', 10],
              ]),
            },
          });
          people.push({
            id,
            distinct,
            device,
            country,
            plan,
            signedUpAt: t,
            engagement: 0.25 + rnd() * 0.75,
          });
          if (plan !== 'free' && rnd() < 0.7) {
            const yearly = rnd() < 0.35;
            const monthly = plan === 'pro' ? 9 : 29;
            events.push({
              ...base,
              id: hexId(),
              event: 'subscription_started',
              ts: t + 90_000,
              user_id: id,
              url: `${SITE}/app/billing`,
              props: {
                plan,
                interval: yearly ? 'year' : 'month',
                amount: yearly ? monthly * 10 : monthly,
                // Monthly plans are subscriptions with MRR; yearly ones count as sales.
                ...(yearly ? {} : { subscription: `sub_${id}` }),
                ...(plan === 'team' ? { $groups: { company: `ws-${id}` } } : {}),
              },
            });
            if (plan === 'team')
              events.push({
                ...base,
                id: hexId(),
                event: '$groupidentify',
                ts: t + 95_000,
                user_id: id,
                props: {
                  $group_type: 'company',
                  $group_key: `ws-${id}`,
                  $group_set: {
                    name: pick<string>([
                      ['Northwind Press', 1],
                      ['Blue Heron Media', 1],
                      ['Fable & Co', 1],
                      ['Quillstone', 1],
                      ['Paperlight Studio', 1],
                    ]),
                    seats: 3 + Math.floor(rnd() * 20),
                  },
                },
              });
          }
        }
      }
      await send(device, country, ip, events);
    }
  }

  // Returning writers: weekly retention that decays, and engaged people stick.
  const checklistStart = onboardingStart;
  for (const person of people) {
    const ip = `10.200.${people.indexOf(person) % 250}.${Math.floor(people.indexOf(person) / 250)}`;
    let variant: string | null = null;
    const events: Wire[] = [];
    if (person.signedUpAt > checklistStart) {
      variant = rnd() < 0.5 ? 'control' : 'test';
      events.push({
        id: hexId(),
        event: '$exposure',
        ts: person.signedUpAt + 1000,
        distinct_id: person.distinct,
        user_id: person.id,
        url: `${SITE}/app`,
        props: { flag: 'onboarding-checklist', variant },
      });
    }
    // First document, same session.
    if (rnd() < (variant === 'test' ? 0.71 : 0.64)) {
      events.push({
        id: hexId(),
        event: 'document_created',
        ts: person.signedUpAt + 120_000 + rnd() * 600_000,
        distinct_id: person.distinct,
        user_id: person.id,
        url: `${SITE}/app`,
        props: { template: pick(TEMPLATES), words: Math.round(rnd() * 900) },
      });
    }
    const weeks = Math.floor((now - person.signedUpAt) / (7 * DAY));
    for (let w = 0; w <= weeks; w++) {
      const p =
        (0.18 + 0.5 * 0.72 ** w) * person.engagement * (person.plan === 'free' ? 0.9 : 1.25);
      const visits = rnd() < p ? 1 + Math.floor(rnd() * 3 * person.engagement) : 0;
      for (let k = 0; k < visits; k++) {
        const t = person.signedUpAt + w * 7 * DAY + (0.5 + rnd() * 6) * DAY;
        if (t > now - 60_000) continue;
        const session = hexId();
        const common = { distinct_id: person.distinct, user_id: person.id, session_id: session };
        events.push({
          ...common,
          id: hexId(),
          event: '$pageview',
          ts: t,
          url: `${SITE}/app`,
          title: 'Inkwell',
        });
        const docs = 1 + Math.floor(rnd() * 2.4);
        for (let d = 0; d < docs; d++)
          events.push({
            ...common,
            id: hexId(),
            event: 'document_created',
            ts: t + (d + 1) * 300_000,
            url: `${SITE}/app`,
            props: { template: pick(TEMPLATES), words: Math.round(200 + rnd() * 2400) },
          });
        if (rnd() < 0.28)
          events.push({
            ...common,
            id: hexId(),
            event: 'document_shared',
            ts: t + 1_500_000,
            url: `${SITE}/app`,
            props: {
              via: pick<string>([
                ['link', 6],
                ['email', 3],
                ['export', 2],
              ]),
            },
          });
        if (person.plan === 'team' && rnd() < 0.35)
          events.push({
            ...common,
            id: hexId(),
            event: 'invite_sent',
            ts: t + 1_800_000,
            url: `${SITE}/app/team`,
            props: {
              role: pick<string>([
                ['editor', 3],
                ['viewer', 1],
              ]),
            },
          });
        if (rnd() < 0.02)
          events.push({
            ...common,
            id: hexId(),
            event: '$exception',
            ts: t + 900_000,
            url: `${SITE}/app`,
            props: {
              type: 'TypeError',
              message: "Cannot read properties of undefined (reading 'wordCount')",
            },
          });
      }
    }
    await send(
      person.device,
      person.country,
      ip,
      events.sort((a, b) => a.ts - b.ts),
    );
  }

  // The data dictionary, conversions, cohorts and saved insights.
  const definitions: [string, string, Record<string, string>][] = [
    [
      'signup_started',
      'Fired when someone opens the signup form, from the header button or the pricing page.',
      { source: 'Where the form was opened: "pricing" or "header".' },
    ],
    [
      'signup_completed',
      'Fired once the account exists and the person is signed in, right after identify().',
      { plan: 'Chosen plan: free, pro or team.', method: 'email, google or github.' },
    ],
    [
      'subscription_started',
      'Fired when the first payment succeeds and the plan becomes active.',
      {
        plan: 'pro or team.',
        interval: 'Billing period: month or year.',
        amount: 'First charge in USD.',
      },
    ],
    [
      'document_created',
      'Fired when a writer creates a document, blank or from a template.',
      {
        template: 'Template id, or "blank".',
        words: 'Word count when the document is first saved.',
      },
    ],
    [
      'document_shared',
      'Fired when a writer shares a document by link, email or export.',
      { via: 'link, email or export.' },
    ],
    [
      'invite_sent',
      'Fired when a team admin invites someone to their workspace.',
      { role: 'Role given to the invitee: editor or viewer.' },
    ],
  ];
  for (const [event, description, properties] of definitions)
    await api('PUT', `/api/events/${event}`, {
      project: 'demo',
      description,
      properties,
      owner: 'Growth',
    });
  // Event roles arrived in a later Worker; skip them on older builds.
  for (const [event, role] of [
    ['signup_completed', 'conversion'],
    ['subscription_started', 'conversion'],
    ['document_shared', 'important'],
  ])
    await api('PUT', `/api/events/${event}/role`, { project: 'demo', role }).catch(() => undefined);

  await api('POST', '/api/cohorts', {
    project: 'demo',
    name: 'Paying customers',
    filters: [{ property: 'person.plan', op: 'in', value: ['pro', 'team'] }],
  });
  await api('POST', '/api/cohorts', {
    project: 'demo',
    name: 'Active writers',
    didEvent: 'document_created',
    from: '-14d',
  });
  await api('POST', '/api/cohorts', {
    project: 'demo',
    name: 'Power writers',
    description: 'Created three or more documents in the last two weeks',
    definition: {
      groups: [
        {
          conditions: [
            {
              type: 'performed',
              event: 'document_created',
              count: { op: 'gte', value: 3 },
              within: '14d',
            },
          ],
        },
      ],
    },
  });
  await api('POST', '/api/annotations', {
    project: 'demo',
    at: new Date(now - 12 * DAY).toISOString(),
    text: 'Launched templates',
  });
  await api('POST', '/api/cohorts', {
    project: 'demo',
    name: 'Teams of 11+',
    filters: [{ property: 'person.company_size', op: 'in', value: ['11-50', '51-200', '200+'] }],
  });

  const insights: [string, string, string, Record<string, unknown>][] = [
    [
      'Signups by plan',
      'New accounts each day, split by the plan they chose.',
      'trends',
      {
        series: [{ event: 'signup_completed', math: 'unique_persons', label: 'Signups' }],
        interval: 'day',
        breakdown: 'plan',
        from: '-30d',
      },
    ],
    [
      'Visit to paid',
      'From any page view to a first payment, within a week.',
      'funnel',
      {
        steps: [
          { event: '$pageview', label: 'Visited' },
          { event: 'signup_started', label: 'Started signup' },
          { event: 'signup_completed', label: 'Signed up' },
          { event: 'subscription_started', label: 'Paid' },
        ],
        window: '7d',
        from: '-30d',
      },
    ],
    [
      'Writer retention',
      'Of people who signed up each week, how many came back to write.',
      'retention',
      {
        cohortEvent: { event: 'signup_completed' },
        returnEvent: { event: 'document_created' },
        period: 'week',
        periods: 7,
        from: '-56d',
      },
    ],
    [
      'Revenue by plan',
      'First-payment revenue per week, by plan.',
      'trends',
      {
        series: [
          { event: 'subscription_started', math: 'sum', property: 'amount', label: 'Revenue' },
        ],
        interval: 'week',
        breakdown: 'plan',
        from: '-56d',
      },
    ],
    [
      'Documents written',
      'Documents created per day, and how many people wrote them.',
      'trends',
      {
        series: [
          { event: 'document_created', label: 'Documents' },
          { event: 'document_created', math: 'unique_persons', label: 'Writers' },
        ],
        interval: 'day',
        from: '-30d',
      },
    ],
    [
      'Signup by source',
      'Which traffic sources turn visitors into accounts.',
      'funnel',
      {
        steps: [{ event: '$pageview' }, { event: 'signup_completed' }],
        window: '1d',
        breakdown: 'utm_source',
        from: '-30d',
      },
    ],
  ];
  for (const [name, description, kind, spec] of insights)
    await api('POST', '/api/insights', { project: 'demo', name, description, kind, spec }).catch(
      (err: unknown) => console.warn(`insight "${name}": ${String(err)}`),
    );

  return { visitors: visitorCount, events: sent, people: people.length };
}
