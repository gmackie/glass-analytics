/**
 * `dataflare email enable --from reports@acme.com` / `dataflare email disable`: emailed reports
 * and alerts through Cloudflare Email Sending. This records the sender in .glass/config.json;
 * the next deploy (the CI workflow, or `dataflare upgrade`) adds the EMAIL binding.
 */

import { loadConfig, projectRoot, saveConfig, UsageError } from '../config.ts';
import { line, ok, printJson } from '../output.ts';
import type { Flags } from './data.ts';

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STEPS = [
  'Email Sending needs the Workers Paid plan.',
  'In the Cloudflare dashboard, open Email Service › Email Sending and onboard the sender’s domain (it adds the DNS records).',
  'Commit .glass/config.json and push: the deploy workflow adds the EMAIL binding. Or run `dataflare upgrade` in CI.',
  'Then pick email in a dashboard’s Subscribe dialog, or tell your agent to schedule_report with emails.',
];

export async function email(sub: string | undefined, flags: Flags): Promise<void> {
  const root = projectRoot();
  const config = loadConfig(root);
  if (!config) throw new UsageError('No Dataflare deployment here.', 'Run `dataflare init` first.');
  if (sub === 'disable') {
    config.email = null;
    saveConfig(config, root);
    if (flags.json) return printJson({ email: null });
    ok('Email turned off: the next deploy removes the EMAIL binding.');
    return;
  }
  if (sub !== 'enable')
    throw new UsageError('dataflare email enable --from <address> | dataflare email disable');
  const from = typeof flags.from === 'string' ? flags.from.trim() : '';
  if (!ADDRESS.test(from))
    throw new UsageError(
      'Which address do reports come from?',
      'dataflare email enable --from reports@yourdomain.com',
    );
  config.email = { from };
  saveConfig(config, root);
  if (flags.json) return printJson({ email: config.email, steps: STEPS });
  ok(`Reports and alerts will be emailed from ${from}.`);
  line();
  for (const [i, step] of STEPS.entries()) line(`  ${i + 1}. ${step}`);
}
