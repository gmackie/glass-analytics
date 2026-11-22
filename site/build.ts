/**
 * Build the public site into site/dist: static HTML for every page, the
 * client scripts, sitemap, robots.txt, llms.txt and markdown twins of the
 * docs. Run with `pnpm site:build` (after `pnpm build`, which it needs for
 * the SDK size). No network, no secrets.
 *
 * Product images and the demo come from `node scripts/site-assets.ts` and are
 * committed under site/public.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { PRICES } from '../packages/core/src/usage.ts';
import { GLASS_VERSION } from '../packages/core/src/version.ts';
import { AGENT_PROMPT, INSTALL, REPO, SITE_URL } from './src/config.ts';
import { COMPETITORS } from './src/content/compare.ts';
import { GUIDES } from './src/content/guides.ts';
import { FAQ, type Facts, type HeroLayout, homePage } from './src/home.ts';
import { metaPixel, stripTags } from './src/layout.ts';
import {
  changelogPage,
  DOCS,
  docPage,
  docsIndex,
  guidePage,
  guidesIndex,
  notFoundPage,
  pricingPage,
  vsIndex,
  vsPage,
} from './src/pages.ts';

const site = dirname(fileURLToPath(import.meta.url));
const root = join(site, '..');
const dist = join(site, 'dist');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
/** A built file's text, or undefined when that step didn't produce it. */
function readIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(site, 'public'), dist, { recursive: true });

const pages: string[] = [];
function write(path: string, html: string): void {
  const file = path.endsWith('/') ? join(dist, path, 'index.html') : join(dist, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  if (path.endsWith('/')) pages.push(path);
}

// ── Facts measured from the code, so the homepage never drifts ───────────────
function sdkKb(): string {
  const file = join(root, 'packages', 'web', 'dist', 'glass.js');
  if (!existsSync(file))
    throw new Error('Run `pnpm build` first: the homepage shows the SDK size.');
  return (gzipSync(readFileSync(file)).length / 1024).toFixed(1);
}

function mcpTools(): string[] {
  const src = read('packages', 'worker', 'src', 'mcp', 'tools.ts');
  return [...src.matchAll(/^\s{4}name: '([a-z_]+)'/gm)].map((m) => m[1]!);
}

/** The SQL behind the demo's 30-day Visitors chart, from the recorded responses. */
function heroSql(): string {
  const dir = join(site, 'public', 'demo', 'data');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      if (!text.includes('"kind": "web"') && !text.includes('"kind":"web"')) continue;
      const data = JSON.parse(text) as { kind?: string; sql?: string[]; interval?: string };
      if (data.kind === 'web' && data.interval === 'day' && data.sql?.length) {
        const ts =
          data.sql.find((q) => /GROUP BY/i.test(q) && /bucket|interval|day/i.test(q)) ??
          data.sql[0]!;
        return ts.trim();
      }
    }
  }
  return `SELECT bucket, COUNT(DISTINCT distinct_id) AS visitors\nFROM events\nWHERE project = 'demo' AND event = '$pageview'\n  AND ts_ms >= :from AND ts_ms < :to\nGROUP BY bucket\nORDER BY bucket`;
}

/** Where the screenshot's chart and SQL switch are, measured when it was taken. */
function heroLayout(): HeroLayout {
  const file = join(site, 'public', 'img', 'web-layout.json');
  if (!existsSync(file))
    throw new Error('Missing site/public/img/web-layout.json: run `pnpm site:assets`.');
  return JSON.parse(readFileSync(file, 'utf8')) as HeroLayout;
}

const tools = mcpTools();
const facts: Facts = {
  version: GLASS_VERSION,
  sdkKb: sdkKb(),
  mcpTools: tools.length,
  mcpToolNames: tools,
  heroSql: heroSql(),
  heroLayout: heroLayout(),
};

// ── Pages ────────────────────────────────────────────────────────────────────
write('/', homePage(facts));
write('/pricing/', pricingPage(PRICES.checked));
write('/docs/', docsIndex());
for (const doc of DOCS) {
  const md = read('docs', doc.file);
  write(`/docs/${doc.slug}/`, docPage(doc, md));
  write(`/docs/${doc.slug}.md`, md);
}
write('/vs/', vsIndex());
for (const c of COMPETITORS) write(`/vs/${c.slug}/`, vsPage(c));
write('/guides/', guidesIndex());
for (const g of GUIDES) {
  write(`/guides/${g.slug}/`, guidePage(g));
  write(`/guides/${g.slug}.md`, `# ${g.title}\n\n${g.body}`);
}
write('/changelog/', changelogPage(read('packages', 'cli', 'CHANGELOG.md')));
write('/404.html', notFoundPage());

// The demo's HTML comes from scripts/site-assets.ts; add the same pixel as every other page.
{
  const demo = join(dist, 'demo', 'index.html');
  const pixel = metaPixel();
  const html = pixel.head ? readIfPresent(demo) : undefined;
  if (html !== undefined)
    writeFileSync(
      demo,
      html.replace('</head>', `${pixel.head}\n</head>`).replace('<body>', `<body>\n${pixel.body}`),
    );
}

// ── Client scripts ───────────────────────────────────────────────────────────
await esbuild.build({
  entryPoints: {
    main: join(site, 'src', 'client', 'main.ts'),
    calculator: join(site, 'src', 'client', 'calculator.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});

// ── For search engines and agents ────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
pages.push('/demo/');
writeFileSync(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) =>
      `  <url><loc>${SITE_URL}${p}</loc><lastmod>${today}</lastmod><priority>${p === '/' ? '1.0' : p.split('/').length > 3 ? '0.6' : '0.8'}</priority></url>`,
  )
  .join('\n')}
</urlset>
`,
);

// Search and AI crawlers are welcome: being found, quoted and recommended is the point.
writeFileSync(
  join(dist, 'robots.txt'),
  `User-agent: *
Allow: /

# AI search and assistants: welcome. /llms.txt has a summary written for you.
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-SearchBot
Allow: /
User-agent: Claude-User
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Applebot-Extended
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`,
);

const llms = read('site', 'public', 'llms.txt').replace(
  /## Docs[\s\S]*$/,
  `## Docs

${DOCS.map((d) => `- [${d.title}](${SITE_URL}/docs/${d.slug}.md): ${d.summary}`).join('\n')}
- [All docs in one file](${SITE_URL}/llms-full.txt)

## Guides

${GUIDES.map((g) => `- [${g.label}](${SITE_URL}/guides/${g.slug}.md): ${g.description}`).join('\n')}

## Compare

${COMPETITORS.map((c) => `- [Dataflare vs ${c.name}](${SITE_URL}/vs/${c.slug}/): ${c.verdict}`).join('\n')}

## Cost

Dataflare has no subscription. It runs in the user's Cloudflare account and costs Cloudflare's list prices: small sites fit Workers Free ($0); Workers Paid is $${PRICES.plan.monthly}/month and includes ${PRICES.workers.includedRequests / 1e6}M requests and ${PRICES.d1.includedRowsWritten / 1e6}M D1 rows written. Dataflare uses about 3 Worker requests per page view and 5 D1 row writes per event. Calculator: ${SITE_URL}/pricing/

## Source

- Repository (MIT): ${REPO}
- Changelog: ${SITE_URL}/changelog/
`,
);
writeFileSync(join(dist, 'llms.txt'), llms);

writeFileSync(
  join(dist, 'llms-full.txt'),
  `# Dataflare documentation\n\n> ${
    llms
      .split('\n')
      .find((l) => l.startsWith('>'))
      ?.slice(2) ?? ''
  }\n\nInstall: \`${INSTALL}\`\n\n${DOCS.map((d) => `<!-- ${SITE_URL}/docs/${d.slug}/ -->\n\n${read('docs', d.file)}`).join('\n\n---\n\n')}`,
);

writeFileSync(
  join(dist, 'index.md'),
  `# Dataflare Analytics: open-source product analytics in your own Cloudflare account

Web analytics, funnels and retention, session replay, feature flags and A/B tests. Open source (MIT), deployed with one command, and ready for your coding agent. Your data never leaves your Cloudflare account.

\`\`\`sh
${INSTALL}
\`\`\`

Or paste this into your coding agent:

> ${AGENT_PROMPT}

- Live demo: ${SITE_URL}/demo/
- Docs: ${SITE_URL}/docs/
- Pricing calculator: ${SITE_URL}/pricing/
- Comparisons: ${COMPETITORS.map((c) => `[${c.name}](${SITE_URL}/vs/${c.slug}/)`).join(', ')}

## At a glance

- MIT licensed; browser SDK ${facts.sdkKb} KB gzipped; ${facts.mcpTools} MCP tools; version ${facts.version}.
- Runs as a Worker, a D1 database and an R2 bucket in your Cloudflare account. No Dataflare server or account.
- Costs Cloudflare's list prices: $0 on Workers Free for small sites, $${PRICES.plan.monthly}/month on Workers Paid for most others.

## Questions

${FAQ.map(
  ([q, a]) =>
    `### ${q}\n\n${stripTags(
      a
        .replace(/<code>(.*?)<\/code>/g, '`$1`')
        .replace(/<a href="(.*?)">(.*?)<\/a>/g, `[$2](${SITE_URL}$1)`),
    )}`,
).join('\n\n')}
`,
);

console.log(`site: ${pages.length} pages → site/dist`);
