/**
 * Batch export file formats: newline-delimited JSON or CSV, gzipped with the
 * platform's CompressionStream (Workers, browsers and Node 18+).
 */

import { EVENT_COLUMNS } from './events.ts';

export type ExportFormat = 'jsonl' | 'csv';

/** One event row as exported: the stored columns, with JSON columns parsed for JSONL. */
export function exportRow(
  row: Record<string, unknown>,
  format: ExportFormat,
): Record<string, unknown> {
  if (format === 'csv') return row;
  const out: Record<string, unknown> = {};
  for (const c of EVENT_COLUMNS) {
    const v = row[c];
    if ((c === 'props' || c === 'person_props' || c === 'flags') && typeof v === 'string') {
      try {
        out[c] = JSON.parse(v);
      } catch {
        out[c] = v;
      }
    } else out[c] = v;
  }
  out.timestamp = new Date(Number(row.ts_ms)).toISOString();
  return out;
}

function csvCell(v: unknown): string {
  const s =
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows as file text. CSV starts with a header row (`header: false` for later parts). */
export function formatRows(
  rows: Record<string, unknown>[],
  format: ExportFormat,
  header = true,
): string {
  if (format === 'jsonl')
    return (
      rows.map((r) => JSON.stringify(exportRow(r, 'jsonl'))).join('\n') + (rows.length ? '\n' : '')
    );
  const lines = rows.map((r) => EVENT_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return `${header ? `${EVENT_COLUMNS.join(',')}\n` : ''}${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

/** Gzip text. */
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gunzip (for tests and reading exports back). */
export async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
