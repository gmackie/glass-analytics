/**
 * `dataflare import <file>`: load a history of events from a file into Dataflare,
 * keeping their timestamps. Reads newline-delimited JSON (one record per line), a
 * JSON array, or CSV, maps each record with a preset for the tool it came from,
 * and sends batches of 1,000 to `POST /api/import`. Records get stable ids, so an
 * interrupted import can simply be run again.
 */

import { type FileHandle, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { WireEvent } from '@dataflare/core/events';
import {
  csvRecord,
  IMPORT_PRESETS,
  type ImportPreset,
  mapRecord,
  parseCsvLine,
} from '@dataflare/core/import-presets';
import { call, withProject } from '../client.ts';
import { UsageError } from '../config.ts';
import { color, line, ok, printJson } from '../output.ts';

const BATCH = 1000;

interface ImportOptions {
  format?: string;
  preset?: string;
  project?: string;
  json?: boolean;
  dryRun?: boolean;
}

type Take = (record: Record<string, unknown>) => Promise<void>;

/** Counts and batching for one import: mapped records go out 1,000 at a time. */
function importSink(
  project: string | undefined,
  preset: ImportPreset,
  options: ImportOptions,
  fetcher: typeof fetch | undefined,
) {
  const totals = { read: 0, skipped: 0, accepted: 0, dropped: 0 };
  let batch: WireEvent[] = [];
  const send = async (events: WireEvent[]) => {
    if (options.dryRun) return { accepted: events.length, dropped: 0 };
    return call<{ accepted: number; dropped: number }>(
      'POST',
      '/api/import',
      { project, events },
      { fetcher },
    );
  };
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await send(batch);
    totals.accepted += res.accepted;
    totals.dropped += res.dropped;
    batch = [];
    if (!options.json)
      process.stderr.write(
        `\r${color.dim(`${totals.read.toLocaleString('en-US')} read, ${totals.accepted.toLocaleString('en-US')} imported`)}`,
      );
  };
  const take: Take = async (record) => {
    totals.read++;
    const event = await mapRecord(preset, record);
    if (!event) {
      totals.skipped++;
      return;
    }
    batch.push(event);
    if (batch.length >= BATCH) await flush();
  };
  /** A line that isn't a record at all still counts as read, and skipped. */
  const unreadable = () => {
    totals.read++;
    totals.skipped++;
  };
  return { totals, take, flush, unreadable };
}

/** Open the file once and read from that handle, so it can't change between a check and the read. */
async function openFile(file: string): Promise<FileHandle> {
  try {
    return await open(file, 'r');
  } catch {
    throw new UsageError(`Can't read ${file}.`);
  }
}

function formatOf(file: string, format: string | undefined): string {
  if (format) return format;
  if (file.endsWith('.csv')) return 'csv';
  return file.endsWith('.json') ? 'json' : 'ndjson';
}

async function readJsonFile(handle: FileHandle, take: Take): Promise<void> {
  const all = JSON.parse(await handle.readFile('utf8')) as unknown;
  const records = Array.isArray(all) ? all : [all];
  for (const r of records) await take(r as Record<string, unknown>);
}

/** CSV (a header row, then records) or newline-delimited JSON, one line at a time. */
async function readLines(
  handle: FileHandle,
  format: string,
  sink: ReturnType<typeof importSink>,
): Promise<void> {
  const lines = createInterface({
    input: handle.createReadStream(),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let header: string[] | null = null;
  for await (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    if (format !== 'csv') {
      await takeJsonLine(text, sink);
      continue;
    }
    const cells = parseCsvLine(text);
    if (header) await sink.take(csvRecord(header, cells));
    else header = cells.map((h) => h.trim());
  }
}

async function takeJsonLine(text: string, sink: ReturnType<typeof importSink>): Promise<void> {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(text) as Record<string, unknown>;
  } catch {
    sink.unreadable();
    return;
  }
  await sink.take(record);
}

function presetOf(name: string | undefined): ImportPreset {
  const preset = (name ?? 'raw') as ImportPreset;
  if (!IMPORT_PRESETS.includes(preset)) {
    throw new UsageError(`Unknown preset "${preset}"`, `Presets: ${IMPORT_PRESETS.join(', ')}.`);
  }
  return preset;
}

export async function importEvents(
  file: string | undefined,
  options: ImportOptions,
  deps: { fetcher?: typeof fetch } = {},
): Promise<void> {
  if (!file) {
    throw new UsageError(
      'Usage: dataflare import <file> [--preset posthog|mixpanel|amplitude|segment|ga4] [--format ndjson|json|csv]',
    );
  }
  const preset = presetOf(options.preset);
  const format = formatOf(file, options.format);
  const project = withProject({ project: options.project }).project;
  const sink = importSink(project, preset, options, deps.fetcher);
  const handle = await openFile(file);
  try {
    if (format === 'json') await readJsonFile(handle, sink.take);
    else await readLines(handle, format, sink);
  } finally {
    await handle.close();
  }
  await sink.flush();
  if (!options.json) process.stderr.write('\n');
  report({ file, preset, format, ...sink.totals, dryRun: Boolean(options.dryRun) }, options);
}

function report(
  r: {
    file: string;
    preset: string;
    format: string;
    read: number;
    accepted: number;
    skipped: number;
    dropped: number;
    dryRun: boolean;
  },
  options: ImportOptions,
): void {
  if (options.json) {
    const { file, preset, format, read, accepted: imported, skipped, dropped, dryRun } = r;
    printJson({ file, preset, format, read, imported, skipped, dropped, dryRun });
    return;
  }
  ok(
    `${r.dryRun ? 'Would import' : 'Imported'} ${r.accepted.toLocaleString('en-US')} events from ${r.file}`,
  );
  if (r.skipped || r.dropped) {
    line(
      color.dim(
        `${r.skipped.toLocaleString('en-US')} records had no event, time or id the "${r.preset}" preset could read; ${r.dropped.toLocaleString('en-US')} were rejected by the Worker.`,
      ),
    );
  }
}
