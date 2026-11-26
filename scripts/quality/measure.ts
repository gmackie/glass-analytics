/**
 * Measure a checkout: run the unit tests under Node's built-in coverage, analyse complexity,
 * and join the two per function. The result is the JSON every other quality command reads.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { analyzeFile, type FileComplexity, type FunctionMetrics } from './complexity.ts';

export const SOURCES = 'packages/*/src/**/*.ts';
export const TESTS = 'packages/*/test/**/*.test.ts';

export interface Ratio {
  hit: number;
  total: number;
}

export interface Counts {
  lines: Ratio;
  branches: Ratio;
  functions: Ratio;
}

export interface FileCoverage extends Counts {
  /** False when no test imports the file; every line then counts as uncovered. */
  loaded: boolean;
  /** Uncovered line numbers as ranges, e.g. "12-18,40". Empty when fully covered. */
  uncovered: string;
}

export interface Coverage {
  /** Whether the Python-backed lake tests ran (they need uv). CI always runs them. */
  python: boolean;
  total: Counts;
  packages: Record<string, Counts>;
  files: Record<string, FileCoverage>;
}

export interface MeasuredFunction extends FunctionMetrics {
  /** Share of the function's lines that ran under test, 0–100, or null without coverage. */
  coverage: number | null;
}

export interface Metrics {
  schema: 1;
  coverage: Coverage | null;
  functions: MeasuredFunction[];
}

const zero = (): Counts => ({
  lines: { hit: 0, total: 0 },
  branches: { hit: 0, total: 0 },
  functions: { hit: 0, total: 0 },
});

function add(into: Counts, from: Counts): void {
  for (const key of ['lines', 'branches', 'functions'] as const) {
    into[key].hit += from[key].hit;
    into[key].total += from[key].total;
  }
}

export function packageOf(file: string): string {
  return file.split('/')[1] ?? file;
}

export function pct(r: Ratio): number {
  return r.total === 0 ? 100 : (r.hit / r.total) * 100;
}

export function toRanges(lines: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i]!;
    let end = start;
    while (lines[i + 1] === end + 1) end = lines[++i]!;
    out.push(start === end ? `${start}` : `${start}-${end}`);
  }
  return out.join(',');
}

export function fromRanges(ranges: string): Set<number> {
  const out = new Set<number>();
  for (const part of ranges.split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    for (let n = a!; n <= (b ?? a!); n++) out.add(n);
  }
  return out;
}

interface LcovFile {
  lines: Map<number, number>;
  branches: Ratio;
  functions: Ratio;
}

function parseLcov(text: string, root: string): Map<string, LcovFile> {
  const files = new Map<string, LcovFile>();
  let current: LcovFile | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    const tag = colon === -1 ? line : line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (tag === 'SF') {
      current = {
        lines: new Map(),
        branches: { hit: 0, total: 0 },
        functions: { hit: 0, total: 0 },
      };
      files.set(relative(root, resolve(root, value)).split(sep).join('/'), current);
      continue;
    }
    if (!current) continue;
    if (tag === 'DA') {
      const [n, hits] = value.split(',').map(Number);
      current.lines.set(n!, Math.max(current.lines.get(n!) ?? 0, hits!));
    } else if (tag === 'FNF') current.functions.total = Number(value);
    else if (tag === 'FNH') current.functions.hit = Number(value);
    else if (tag === 'BRF') current.branches.total = Number(value);
    else if (tag === 'BRH') current.branches.hit = Number(value);
  }
  return files;
}

export function hasUv(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run the unit tests with coverage; throws if a test fails, since coverage would be partial. */
function runTests(root: string, lcov: string, quiet: boolean): void {
  const args = [
    '--test',
    '--experimental-test-coverage',
    `--test-coverage-include=${SOURCES}`,
    '--test-reporter=dot',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcov}`,
    TESTS,
    'scripts/**/*.test.ts',
  ];
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', quiet ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    if (quiet && run.stdout) process.stdout.write(run.stdout);
    throw new Error(`Tests failed in ${root}; fix them before measuring coverage.`);
  }
}

export interface MeasureOptions {
  root: string;
  /** Skip the test run and measure complexity only (fast, for a quick local check). */
  coverage: boolean;
  quiet?: boolean;
}

/** Run the tests with coverage and parse the result, or null when coverage is off. */
function collectCoverage(root: string, quiet: boolean) {
  const dir = join(root, 'coverage');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'lcov.info');
  const python = hasUv() || process.env.DATAFLARE_REQUIRE_PYTHON === '1';
  runTests(root, path, quiet);
  const lcov = existsSync(path) ? parseLcov(readFileSync(path, 'utf8'), root) : new Map();
  return { lcov: lcov as Map<string, LcovFile>, python };
}

/** Share of a function's lines that ran, 0–100; a file no test loaded counts as 0. */
function functionCoverage(fn: FunctionMetrics, hits: LcovFile | undefined): number {
  if (!hits) return 0;
  let hit = 0;
  let total = 0;
  for (let n = fn.line; n <= fn.endLine; n++) {
    const h = hits.lines.get(n);
    if (h === undefined) continue;
    total++;
    if (h > 0) hit++;
  }
  return total === 0 ? 100 : Math.round((hit / total) * 1000) / 10;
}

function fileCoverage(info: FileComplexity, hits: LcovFile | undefined): FileCoverage {
  if (!hits) {
    // Node counts every line of a loaded file, so an unloaded one counts every line too.
    return {
      loaded: false,
      lines: { hit: 0, total: info.lines },
      branches: { hit: 0, total: 0 },
      functions: { hit: 0, total: info.functions.length },
      uncovered: info.lines > 0 ? `1-${info.lines}` : '',
    };
  }
  const uncovered = [...hits.lines].filter(([, h]) => h === 0).map(([n]) => n);
  uncovered.sort((a, b) => a - b);
  return {
    loaded: true,
    lines: { hit: hits.lines.size - uncovered.length, total: hits.lines.size },
    branches: hits.branches,
    functions: hits.functions,
    uncovered: toRanges(uncovered),
  };
}

export function measure({ root, coverage, quiet = false }: MeasureOptions): Metrics {
  const sources = globSync(SOURCES, { cwd: root })
    .map((f) => f.split(sep).join('/'))
    .filter((f) => !f.endsWith('.d.ts'))
    .sort();
  const analysed = new Map(sources.map((f) => [f, analyzeFile(join(root, f), f)]));
  const run = coverage ? collectCoverage(root, quiet) : null;
  const cov: Coverage | null = run
    ? { python: run.python, total: zero(), packages: {}, files: {} }
    : null;
  const functions: MeasuredFunction[] = [];

  for (const [file, info] of analysed) {
    const hits = run?.lcov.get(file);
    for (const fn of info.functions) {
      functions.push({ ...fn, coverage: run ? functionCoverage(fn, hits) : null });
    }
    // A file with no runtime code never loads under test, and that is not a coverage gap.
    if (!cov || (info.typeOnly && !hits)) continue;
    const entry = fileCoverage(info, hits);
    cov.files[file] = entry;
    add(cov.total, entry);
    const pkg = packageOf(file);
    cov.packages[pkg] ??= zero();
    add(cov.packages[pkg], entry);
  }

  return { schema: 1, coverage: cov, functions };
}
