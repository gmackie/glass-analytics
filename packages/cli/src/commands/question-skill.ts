import { call } from '../client.ts';
import { connection, UsageError } from '../config.ts';
import { printJson } from '../output.ts';
import type { Flags } from './data.ts';

export async function questionSkill(key: string | undefined, flags: Flags): Promise<void> {
  if (!key)
    throw new UsageError(
      'A product question key is required.',
      'Call list_product_questions to find keys for this project.',
    );
  const conn = connection('query');
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries({
    project: flags.project ?? conn.project,
    from: flags.from,
    to: flags.to,
  })) {
    if (typeof value === 'string') params.set(name, value);
  }
  const result = await call<{ skill: string | null; evidence: { missing: string[] } }>(
    'GET',
    `/api/product-questions/${encodeURIComponent(key)}?${params}`,
    undefined,
    conn,
  );
  if (flags.json) return printJson(result);
  if (!result.skill)
    throw new UsageError('This skill needs more evidence.', result.evidence.missing.join(', '));
  process.stdout.write(result.skill);
}
