/**
 * Install and tracking snippets per framework.
 *
 * Used by `dataflare init` (to tell the agent exactly what to add) and by the
 * `instrument` MCP tool (to return the code for a specific event). To support
 * a new framework, add an entry to FRAMEWORKS and a detection rule.
 */

export interface SnippetOptions {
  /** Base URL of the Dataflare Worker, e.g. https://glass.acme.workers.dev or https://acme.com/_glass */
  host: string;
  project: string;
}

export interface FrameworkSnippet {
  /** Where the install code goes. */
  file: string;
  /** Code to add. */
  code: string;
  /** How to capture a custom event in this framework. */
  capture: (event: string, props?: Record<string, unknown>) => string;
}

export type Framework =
  | 'html'
  | 'nextjs'
  | 'astro'
  | 'sveltekit'
  | 'nuxt'
  | 'remix'
  | 'tanstack'
  | 'vite'
  | 'worker';

const scriptTag = (o: SnippetOptions) =>
  `<script defer src="${o.host}/s.js" data-project="${o.project}"></script>`;

const browserCapture = (event: string, props?: Record<string, unknown>) =>
  `window.glass?.capture(${JSON.stringify(event)}${props && Object.keys(props).length ? `, ${JSON.stringify(props)}` : ''});`;

const moduleCapture = (event: string, props?: Record<string, unknown>) =>
  `import { glass } from 'dataflare-web';\n\nglass.capture(${JSON.stringify(event)}${props && Object.keys(props).length ? `, ${JSON.stringify(props)}` : ''});`;

export const FRAMEWORKS: Record<
  Framework,
  { name: string; snippet(o: SnippetOptions): FrameworkSnippet }
> = {
  html: {
    name: 'Plain HTML',
    snippet: (o) => ({
      file: 'index.html (inside <head>, on every page)',
      code: scriptTag(o),
      capture: browserCapture,
    }),
  },
  nextjs: {
    name: 'Next.js',
    snippet: (o) => ({
      file: 'app/layout.tsx (App Router) or pages/_app.tsx',
      code: `import Script from 'next/script';\n\n// inside <body>:\n<Script src="${o.host}/s.js" data-project="${o.project}" strategy="afterInteractive" />`,
      capture: browserCapture,
    }),
  },
  astro: {
    name: 'Astro',
    snippet: (o) => ({
      file: 'src/layouts/Layout.astro (inside <head>)',
      code: scriptTag(o).replace('<script', '<script is:inline'),
      capture: browserCapture,
    }),
  },
  sveltekit: {
    name: 'SvelteKit',
    snippet: (o) => ({
      file: 'src/app.html (inside <head>)',
      code: scriptTag(o),
      capture: browserCapture,
    }),
  },
  nuxt: {
    name: 'Nuxt',
    snippet: (o) => ({
      file: 'nuxt.config.ts',
      code: `export default defineNuxtConfig({\n  app: { head: { script: [{ src: '${o.host}/s.js', defer: true, 'data-project': '${o.project}' }] } },\n});`,
      capture: browserCapture,
    }),
  },
  remix: {
    name: 'Remix / React Router',
    snippet: (o) => ({
      file: 'app/root.tsx (inside <head>)',
      code: scriptTag(o).replace('defer ', 'defer={true} '),
      capture: browserCapture,
    }),
  },
  tanstack: {
    name: 'TanStack Start',
    snippet: (o) => ({
      file: 'src/routes/__root.tsx (inside the root document <head>)',
      code: `<script defer={true} src="${o.host}/s.js" data-project="${o.project}" />`,
      capture: browserCapture,
    }),
  },
  vite: {
    name: 'Vite (React, Vue, Svelte, Solid…)',
    snippet: (o) => ({
      file: 'src/main.ts (or main.tsx) — after `npm install dataflare-web`',
      code: `import { glass } from 'dataflare-web';\n\nglass.init({ host: '${o.host}', project: '${o.project}' });`,
      capture: moduleCapture,
    }),
  },
  worker: {
    name: 'Cloudflare Worker / server-side',
    snippet: (o) => ({
      file: 'any server code',
      code: `// Server-side capture: POST events to Dataflare.\nawait fetch('${o.host}/e', {\n  method: 'POST',\n  body: JSON.stringify({ project: '${o.project}', events: [{ id: crypto.randomUUID(), event: 'order_paid', ts: Date.now(), distinct_id: userId, user_id: userId, props: { amount: 42 } }] }),\n});`,
      capture: (event, props) =>
        `await fetch(GLASS_HOST + '/e', { method: 'POST', body: JSON.stringify({ project: GLASS_PROJECT, events: [{ id: crypto.randomUUID(), event: ${JSON.stringify(event)}, ts: Date.now(), distinct_id: userId, user_id: userId, props: ${JSON.stringify(props ?? {})} }] }) });`,
    }),
  },
};

/** Guess the framework from a package.json's dependencies. */
export function detectFramework(
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null,
): Framework {
  if (!pkg) return 'html';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string) => Object.hasOwn(deps, name);
  if (has('@tanstack/react-start')) return 'tanstack';
  if (has('next')) return 'nextjs';
  if (has('astro')) return 'astro';
  if (has('@sveltejs/kit')) return 'sveltekit';
  if (has('nuxt')) return 'nuxt';
  if (has('@remix-run/react') || has('react-router')) return 'remix';
  if (has('vite')) return 'vite';
  if (has('wrangler') || has('hono')) return 'worker';
  return 'html';
}

/** Suggested naming convention, included in agent instructions. */
export const EVENT_NAMING_GUIDE =
  'Name events object_action in snake_case and past tense (signup_completed, plan_upgraded, invite_sent). ' +
  'Put variable details in properties ({ plan: "pro" }), never in the event name. Never send emails, names or other personal data as properties.';

/**
 * How to document custom events so later agents (and teammates) know when they
 * fire and what each property means. Included in agent setup files and llms.txt.
 */
export const EVENT_DOCUMENTATION_GUIDE =
  'After a custom event is shipping, call define_event (or `dataflare events <name> --describe "…"`). ' +
  'The description must say how and when the event is fired (which user action or code path). ' +
  'Document every property with what it means and which values to expect ' +
  '(e.g. description: "Fired when the user finishes checkout after payment succeeds."; ' +
  'properties: { plan: "Chosen plan id (free|pro|enterprise)", amount: "Charge in the account currency" }). ' +
  'list_events returns undocumented custom events — document those before relying on them in funnels or trends.';
