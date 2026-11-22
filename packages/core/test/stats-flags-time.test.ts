import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bucketOf,
  evaluateFlag,
  MAX_PAYLOAD_BYTES,
  payloadBytes,
  validateFlag,
  webPayloadProblems,
} from '../src/flags.ts';
import { uuidv7 } from '../src/ids.ts';
import {
  chiSquareSurvival,
  compareConversions,
  compareMeans,
  sampleRatioMismatch,
  sampleSizePerVariant,
  wilson,
} from '../src/stats/tests.ts';
import { bucketStart, bucketsBetween, parseDuration, parseTime } from '../src/time.ts';
import { parseUserAgent } from '../src/ua.ts';
import { parsePage, referrerHost, trimSlashes, trimTrailingSlashes } from '../src/url.ts';
import { NOW } from './helpers.ts';

const close = (a: number, b: number, tol: number) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

describe('statistics', () => {
  it('chi-square survival matches known critical values', () => {
    close(chiSquareSurvival(3.841, 1), 0.05, 0.001);
    close(chiSquareSurvival(5.991, 2), 0.05, 0.001);
    close(chiSquareSurvival(10.828, 1), 0.001, 0.0002);
  });

  it('flags a sample ratio mismatch only when the split is implausible', () => {
    assert.equal(sampleRatioMismatch([5050, 4950], [50, 50]).mismatch, false);
    assert.equal(sampleRatioMismatch([5500, 4500], [50, 50]).mismatch, true);
    assert.equal(sampleRatioMismatch([2000, 8000], [20, 80]).mismatch, false);
  });

  it('Wilson intervals contain the observed rate', () => {
    const [lo, hi] = wilson(30, 100);
    assert.ok(lo < 0.3 && hi > 0.3);
    close(lo, 0.2189, 0.001);
    close(hi, 0.3958, 0.001);
  });

  it('gives near-certain wins for big lifts and ~50% for identical arms', () => {
    const big = compareConversions(
      { exposures: 5000, conversions: 500 },
      { exposures: 5000, conversions: 650 },
    );
    assert.ok(big.probabilityToBeatControl > 0.999);
    close(big.expectedLift, 0.3, 0.03);
    // Analytic 95% interval for this lift is roughly [0.16, 0.44].
    assert.ok(big.liftInterval[0] > 0.1 && big.liftInterval[1] < 0.5, String(big.liftInterval));
    const same = compareConversions(
      { exposures: 1000, conversions: 100 },
      { exposures: 1000, conversions: 100 },
    );
    close(same.probabilityToBeatControl, 0.5, 0.03);
  });

  it('is deterministic for the same inputs', () => {
    const a = compareConversions(
      { exposures: 100, conversions: 10 },
      { exposures: 100, conversions: 14 },
    );
    const b = compareConversions(
      { exposures: 100, conversions: 10 },
      { exposures: 100, conversions: 14 },
    );
    assert.deepEqual(a, b);
  });

  it('compares means with Welch statistics', () => {
    // control: values 1..10, variant: values 3..12 (mean +2)
    const stats = (xs: number[]) => ({
      n: xs.length,
      sum: xs.reduce((a, b) => a + b, 0),
      sumSquares: xs.reduce((a, b) => a + b * b, 0),
    });
    const r = compareMeans(
      stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      stats([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    );
    assert.equal(r.difference, 2);
    assert.ok(r.pValue > 0.1 && r.pValue < 0.2);
  });

  it('estimates sample sizes in the textbook range', () => {
    // 10% baseline, 10% relative lift: ~14,700 per arm.
    const n = sampleSizePerVariant(0.1, 0.1);
    assert.ok(n > 14_000 && n < 15_500, String(n));
  });
});

describe('feature flags', () => {
  it('assigns the same bucket every time', () => {
    assert.equal(bucketOf({ key: 'x' }, 'user-1'), bucketOf({ key: 'x' }, 'user-1'));
    assert.notEqual(
      bucketOf({ key: 'x', salt: 'a' }, 'user-1'),
      bucketOf({ key: 'x', salt: 'b' }, 'user-1'),
    );
  });

  it('respects rollout percentage and variant weights across many users', () => {
    const flag = {
      key: 'exp',
      enabled: true,
      rollout: 50,
      variants: [
        { key: 'control', weight: 25 },
        { key: 'test', weight: 75 },
      ],
    };
    const counts: Record<string, number> = { off: 0, control: 0, test: 0 };
    for (let i = 0; i < 20_000; i++)
      counts[evaluateFlag(flag, { distinct_id: `u${i}` }) ?? 'off']!++;
    close(counts.off! / 20_000, 0.5, 0.02);
    close(counts.test! / (counts.control! + counts.test!), 0.75, 0.02);
  });

  it('applies targeting rules before the default rollout', () => {
    const flag = {
      key: 'beta',
      enabled: true,
      rollout: 0,
      rules: [{ conditions: [{ property: 'person.plan', value: 'pro' }], rollout: 100 }],
    };
    assert.equal(evaluateFlag(flag, { distinct_id: 'a', person: { plan: 'pro' } }), 'on');
    assert.equal(evaluateFlag(flag, { distinct_id: 'a', person: { plan: 'free' } }), null);
    assert.equal(
      evaluateFlag({ ...flag, enabled: false }, { distinct_id: 'a', person: { plan: 'pro' } }),
      null,
    );
  });

  it('validates definitions with readable messages', () => {
    assert.deepEqual(validateFlag({ key: 'ok', enabled: true, rollout: 10 }), []);
    assert.ok(validateFlag({ key: 'bad key!', enabled: true, rollout: 150 }).length === 2);
  });

  it('measures payloads in UTF-8 bytes, as the dashboard does', () => {
    assert.equal(payloadBytes({ on: 'é' }), JSON.stringify({ on: 'é' }).length + 1);
    const big = { on: 'é'.repeat(5_000) };
    assert.ok(JSON.stringify(big).length < MAX_PAYLOAD_BYTES);
    assert.deepEqual(validateFlag({ key: 'k', enabled: true, rollout: 1, payloads: big }), [
      'payloads must be at most 10 KB of JSON',
    ]);
  });

  it('checks the shape of web experiment payloads', () => {
    assert.deepEqual(webPayloadProblems({ headline: 'not a web payload' }), []);
    assert.deepEqual(
      webPayloadProblems({ type: 'web', transforms: [{ selector: 'h1', text: 'Hi' }] }),
      [],
    );
    assert.deepEqual(
      webPayloadProblems({ type: 'web', transforms: [{ text: 'Hi' }, { selector: 'p' }] }),
      [
        'change 1 needs a "selector", e.g. "h1" or "#signup"',
        'change 2 needs one of "text", "html", "css", "attributes", "hide"',
      ],
    );
    assert.deepEqual(webPayloadProblems({ type: 'web' }), [
      'a web payload needs a "transforms" list',
    ]);
    assert.deepEqual(
      validateFlag({
        key: 'k',
        enabled: true,
        rollout: 1,
        payloads: { on: { type: 'web', transforms: [{ selector: '', text: 'x' }] } },
      }),
      ['payload for "on": change 1 needs a "selector", e.g. "h1" or "#signup"'],
    );
  });
});

describe('time', () => {
  it('parses relative and absolute times', () => {
    assert.equal(parseTime('-7d', NOW), NOW - 7 * 86_400_000);
    assert.equal(parseTime('today', NOW), Date.UTC(2026, 9, 31));
    assert.equal(parseTime('2026-10-01', NOW), Date.UTC(2026, 9, 1));
    assert.equal(new Date(parseTime('-1mo', NOW)).getUTCMonth(), 8);
    assert.throws(() => parseTime('last tuesday', NOW), /Cannot parse time/);
    assert.equal(parseDuration('7d'), 7 * 86_400_000);
    assert.equal(parseDuration(90), 90_000);
  });

  it('starts weeks on Monday and walks months correctly', () => {
    assert.equal(bucketStart(Date.UTC(2026, 10, 1), 'week'), Date.UTC(2026, 9, 26)); // Sun 1 Nov -> Mon 26 Oct
    assert.deepEqual(
      bucketsBetween({ from: Date.UTC(2026, 0, 31), to: Date.UTC(2026, 3, 2) }, 'month'),
      [Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1)],
    );
  });
});

describe('ingest helpers', () => {
  it('parses user agents into families', () => {
    assert.deepEqual(
      parseUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
      { browser: 'Safari', os: 'iOS', device: 'mobile' },
    );
    assert.deepEqual(
      parseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0',
      ),
      { browser: 'Edge', os: 'Windows', device: 'desktop' },
    );
    assert.equal(parseUserAgent('Googlebot/2.1').device, 'bot');
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0';
    assert.equal(parseUserAgent(`${android} Mobile Safari/537.36`).device, 'mobile');
    assert.equal(parseUserAgent(`${android} Safari/537.36`).device, 'tablet');
  });

  it('parses hostile user agents in linear time', () => {
    const start = performance.now();
    assert.equal(parseUserAgent('Android'.repeat(20_000)).device, 'tablet');
    assert.equal(trimTrailingSlashes(`a${'/'.repeat(50_000)}b`), `a${'/'.repeat(50_000)}b`);
    assert.ok(performance.now() - start < 500);
    assert.equal(trimTrailingSlashes('https://x.dev///'), 'https://x.dev');
    assert.equal(trimSlashes('//assets/js//'), 'assets/js');
    assert.equal(trimSlashes('///'), '');
  });

  it('extracts UTM tags and normalises referrers', () => {
    const page = parsePage(
      'https://acme.com/pricing?utm_source=newsletter&utm_campaign=launch&x=1',
    );
    assert.equal(page.path, '/pricing');
    assert.equal(page.url, 'https://acme.com/pricing');
    assert.equal(page.utm_source, 'newsletter');
    assert.equal(page.utm_campaign, 'launch');
    assert.equal(referrerHost('https://www.google.com/search?q=x', 'acme.com'), 'google.com');
    assert.equal(referrerHost('https://acme.com/', 'acme.com'), '');
  });

  it('keeps the scheme of native app:// screen URLs', () => {
    const page = parsePage('app://calzone/settings?utm_source=push');
    assert.equal(page.url, 'app://calzone/settings');
    assert.equal(page.host, 'calzone');
    assert.equal(page.path, '/settings');
    assert.equal(page.utm_source, 'push');
    assert.equal(parsePage('app://calzone/').url, 'app://calzone/');
  });

  it('generates time-ordered UUIDv7s', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(a < b);
  });
});
