/**
 * Source maps (revision 3): mapping a minified frame back to the original file,
 * line, column and function name, with a few lines of the original code around it
 * when the map carries `sourcesContent`. A small Base64 VLQ decoder, no dependencies.
 *
 * Only the generated lines up to the one asked for are decoded (minified bundles
 * are often one line, so that is usually all of them), and nothing is kept per
 * segment beyond the line being searched.
 */

export interface RawSourceMap {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings: string;
  sections?: unknown[];
}

export interface OriginalPosition {
  source: string;
  /** 1-based. */
  line: number;
  /** 1-based, like the browser's columns. */
  column: number;
  name: string | null;
  /** Lines around the position, when the map has the source. */
  context?: { pre: string[]; line: string; post: string[] };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) DIGIT[B64.charCodeAt(i)] = i;

/** Decode one segment's VLQ values starting at `pos`; returns the values and where it stopped. */
export function decodeVlq(mappings: string, pos: number, out: number[]): number {
  out.length = 0;
  let value = 0;
  let shift = 0;
  while (pos < mappings.length) {
    const ch = mappings.charCodeAt(pos);
    if (ch === 44 /* , */ || ch === 59 /* ; */) break;
    const digit = ch < 128 ? DIGIT[ch]! : -1;
    if (digit < 0) throw new Error(`Invalid source map mappings at ${pos}`);
    pos++;
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    value = 0;
    shift = 0;
  }
  return pos;
}

/** Parse and check a map: version 3, with mappings (index maps with `sections` aren't supported). */
export function parseSourceMap(text: string): RawSourceMap {
  const map = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, '')) as RawSourceMap;
  if (!map || typeof map !== 'object') throw new Error('Not a source map');
  if (map.sections)
    throw new Error(
      'Index source maps (with "sections") are not supported; upload one map per file',
    );
  if (map.version !== 3 || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) {
    throw new Error('Not a version 3 source map with "mappings" and "sources"');
  }
  return map;
}

/** Where a mapping points: indexes into `sources` and `names`, 0-based line and column. */
interface Mapped {
  src: number;
  line: number;
  col: number;
  name: number | null;
}

/** The decoder's running totals: VLQ fields are deltas from the previous segment. */
interface Totals {
  src: number;
  srcLine: number;
  srcCol: number;
  name: number;
}

/** Add one segment's deltas; returns where it points, or null for generated code with no source. */
function step(totals: Totals, seg: number[]): Mapped | null {
  if (seg.length < 4) return null;
  totals.src += seg[1]!;
  totals.srcLine += seg[2]!;
  totals.srcCol += seg[3]!;
  if (seg.length >= 5) totals.name += seg[4]!;
  return {
    src: totals.src,
    line: totals.srcLine,
    col: totals.srcCol,
    name: seg.length >= 5 ? totals.name : null,
  };
}

/**
 * Read one generated line from `pos` (up to the ";"). On the target line, keep the last mapping at
 * or before the column. Returns where the line ends.
 */
function readLine(
  m: string,
  pos: number,
  totals: Totals,
  target: { col: number } | null,
  found: { best: Mapped | null },
): number {
  let genCol = 0;
  const seg: number[] = [];
  while (pos < m.length && m.charCodeAt(pos) !== 59) {
    if (m.charCodeAt(pos) === 44) {
      pos++;
      continue;
    }
    pos = decodeVlq(m, pos, seg);
    if (seg.length === 0) continue;
    genCol += seg[0]!;
    const mapped = step(totals, seg);
    if (target && genCol <= target.col) found.best = mapped;
  }
  return pos;
}

/** The mapping for a 0-based generated line and column, or null. */
function findMapping(mappings: string, targetLine: number, targetCol: number): Mapped | null {
  const totals: Totals = { src: 0, srcLine: 0, srcCol: 0, name: 0 };
  const found: { best: Mapped | null } = { best: null };
  let pos = 0;
  for (let genLine = 0; pos < mappings.length && genLine <= targetLine; genLine++) {
    const onTarget = genLine === targetLine;
    pos = readLine(mappings, pos, totals, onTarget ? { col: targetCol } : null, found);
    if (onTarget) break;
    pos++; // the ";"
  }
  return found.best;
}

/** A few lines of source around the mapped line, from `sourcesContent`. */
function contextOf(content: string, i: number, contextLines: number): OriginalPosition['context'] {
  const lines = content.split(/\r?\n/);
  const clip = (l: string) => l.slice(0, 300);
  return {
    pre: lines.slice(Math.max(0, i - contextLines), i).map(clip),
    line: clip(lines[i] ?? ''),
    post: lines.slice(i + 1, i + 1 + contextLines).map(clip),
  };
}

/**
 * The original position for a generated 1-based line and column. Returns null when that spot has
 * no mapping (generated code with no source, or a line past the end).
 */
export function originalPositionFor(
  map: RawSourceMap,
  line: number,
  column: number,
  contextLines = 3,
): OriginalPosition | null {
  const best = findMapping(map.mappings, line - 1, Math.max(0, column - 1));
  if (!best) return null;
  const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
  const out: OriginalPosition = {
    source: `${root}${map.sources[best.src] ?? ''}`,
    line: best.line + 1,
    column: best.col + 1,
    name: best.name === null ? null : (map.names?.[best.name] ?? null),
  };
  const content = map.sourcesContent?.[best.src];
  if (typeof content === 'string') out.context = contextOf(content, best.line, contextLines);
  return out;
}
