/**
 * Size budgets for what we ship, checked after `pnpm build` (CI runs it on every PR).
 *
 * The SDK budgets are the tight ones: every visitor of every site that installs Dataflare
 * downloads them (AGENTS.md rule 5). If a change needs more, raise the budget in the same PR
 * and say why; reviewers see the number move.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');

/** Gzipped size limits in KB. */
const BUDGETS: Record<string, number> = {
  // The SDKs grew with groups, flag payloads, bootstrap, overrides, early access,
  // captureException and web experiments (deepen-coverage: 4.5 → 5.9 KB script tag).
  // npm SDK. 9.4: flag overrides moved to a Map (CodeQL: remote property injection), +0.11 KB.
  'packages/web/dist/index.js': 9.4,
  'packages/web/dist/glass.js': 6.25, // script-tag SDK
  'packages/web/dist/replay.js': 65, // replay recorder, loaded on demand
  // Admin-only: the Errors, Revenue, Groups and Pipelines pages, the cohort editor
  // and the world map's country outlines (about 12 KB). Raised to 210 for the JSON and
  // formula editors (with their checkers from core), the measure picker and the insight
  // starters: about 4 KB, and the rest of the headroom is for user paths next.
  // 225: dashboards (grid, tiles, templates), the report and alert dialogs, notification channels.
  'packages/dashboard/dist/app.js': 225,
  // 19: the code field, fold and chip styles shared by the new editors.
  'packages/dashboard/dist/app.css': 19,
  // Destinations, exports, issues, revenue and group analytics (Workers allow 3 MB on Free).
  // 620: user paths (the compiler, the dashboard's Sankey and rail), +5 KB.
  // 670: dashboards, scheduled reports and alerts (the PNG renderer and its Inter glyph atlas,
  // about 12 KB; notices, email, schedules) and the larger dashboard it serves.
  'packages/worker/dist/worker.js': 672,
  'packages/cli/dist/glass.js': 42, // import, sourcemaps and stripe commands
};

const rows: string[] = [];
const over: string[] = [];
for (const [file, budget] of Object.entries(BUDGETS)) {
  const path = join(root, file);
  if (!existsSync(path)) {
    console.error(`${file} is missing: run \`pnpm build\` first.`);
    process.exit(1);
  }
  const kb = gzipSync(readFileSync(path)).length / 1024;
  const ok = kb <= budget;
  if (!ok) over.push(`${file} is ${kb.toFixed(1)} KB gzipped, over its ${budget} KB budget.`);
  const used = `${Math.round((kb / budget) * 100)}%`;
  rows.push(`| \`${file}\` | ${kb.toFixed(1)} KB | ${budget} KB | ${used} | ${ok ? '✅' : '❌'} |`);
  console.log(
    `${ok ? '✓' : '✗'} ${file.padEnd(34)} ${kb.toFixed(1).padStart(6)} KB / ${budget} KB`,
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const table = [
    '### Bundle sizes (gzip)',
    '',
    '| File | Size | Budget | Used | |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join('\n')}\n`);
}
if (over.length) {
  console.error(
    `\n${over.join('\n')}\nShrink the change, or raise the budget in scripts/size.ts and say why in the PR.`,
  );
  process.exit(1);
}
