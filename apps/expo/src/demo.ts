import month from '../../../site/public/demo/data/0ac675a9f1f48f4a.json';
import quarter from '../../../site/public/demo/data/2203fe87f3e48a8c.json';
import week from '../../../site/public/demo/data/8190296b454b9ca6.json';
import { type Period, reportSchema, type Site } from './data.ts';

// The same recorded reports as the public dashboard demo, including their original dates.
const samples = { 7: week, 30: month, 90: quarter };
export function demoReport(days: Period) {
  return reportSchema.parse(samples[days]);
}

export function demoSites(days: Period): Site[] {
  const { project, totals } = samples[days];
  return [{ project, visitors: totals.visitors, pageviews: totals.pageviews }];
}
