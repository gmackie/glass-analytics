/**
 * Experiment statistics against reference values computed once with SciPy 1.x and NumPy
 * (scripts kept out of the repo; the numbers are pasted here so tests need no Python).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chiSquareSurvival,
  compareEstimates,
  compareProportions,
  inverseNormalCdf,
  meanAndError,
  probabilityToBeBestBeta,
  probabilityToBeBestNormal,
  ratioAndError,
  sampleSizeForMean,
  sampleSizeForRate,
  zFor,
} from '../src/stats/tests.ts';

const close = (a: number, b: number, tol: number, label: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

describe('statistics (SciPy reference values)', () => {
  it('normal quantiles', () => {
    close(zFor(0.9), 1.644853626951472, 1e-6, 'z 90%');
    close(zFor(0.99), 2.5758293035489004, 1e-6, 'z 99%');
    close(inverseNormalCdf(0.001), -3.090232306167813, 1e-6, 'ppf(0.001)');
  });

  it('two-proportion z-test (unpooled)', () => {
    // scipy: 100/1000 vs 130/1000 → p = 0.035285, 95% CI of the difference [0.002068, 0.057932].
    const r = compareProportions(
      { exposures: 1000, conversions: 100 },
      { exposures: 1000, conversions: 130 },
    );
    close(r.pValue, 0.03528532025049282, 1e-4, 'p-value');
    close(r.differenceInterval[0], 0.0020679344393763656, 1e-5, 'CI low');
    close(r.differenceInterval[1], 0.057932065560623636, 1e-5, 'CI high');
    assert.ok(r.probabilityToBeatControl > 0.97);
  });

  it("Welch's test on means matches scipy's ttest_ind", () => {
    // numpy: two normal samples of 5,000; scipy ttest_ind(equal_var=False) p = 1.08e-6.
    const a = meanAndError({ n: 5000, sum: 49783.318766586424, sumSquares: 540733.2680670894 });
    const b = meanAndError({ n: 5000, sum: 51370.843233086256, sumSquares: 588594.715199419 });
    const r = compareEstimates({ value: a.mean, se: a.se }, { value: b.mean, se: b.se });
    // The normal approximation is within a hair of the t distribution at n = 5,000.
    close(Math.log10(r.pValue), Math.log10(1.084230137804257e-6), 0.05, 'log p-value');
  });

  it('ratio standard errors by the delta method match a bootstrap', () => {
    // numpy: Poisson numerators and denominators, 2,000 bootstrap resamples, se = 0.011622.
    const r = ratioAndError({
      n: 4000,
      sumX: 11944,
      sumY: 11946,
      sumX2: 47686,
      sumY2: 43790,
      sumXY: 35873,
    });
    close(r.ratio, 0.9998325799430772, 1e-12, 'ratio');
    close(r.se, 0.011621573428746255, 0.0006, 'standard error');
  });

  it('sample sizes', () => {
    // 10% base rate, +10% relative, alpha 0.05, power 0.8 → 14,749 per variant.
    close(sampleSizeForRate(0.1, 0.1), 14749, 1, 'rate');
    // Means: n = 2 (z_a + z_b)^2 sd^2 / delta^2 with sd 3, mean 10, mde 10% → 142.
    assert.equal(
      sampleSizeForMean(10, 3, 0.1),
      Math.ceil((2 * (1.959964 + 0.841621) ** 2 * 9) / 1),
    );
  });

  it('chi-square survival', () => {
    close(chiSquareSurvival(3.84, 1), 0.050043521248705085, 1e-6, 'chi2(3.84, 1)');
    close(chiSquareSurvival(10, 2), 0.006737946999085468, 1e-9, 'chi2(10, 2)');
  });

  it('probability to be best adds up, favours the best and respects direction', () => {
    const p = probabilityToBeBestBeta([
      { exposures: 1000, conversions: 100 },
      { exposures: 1000, conversions: 130 },
      { exposures: 1000, conversions: 110 },
    ]);
    close(
      p.reduce((a, b) => a + b, 0),
      1,
      1e-9,
      'sum',
    );
    assert.ok(p[1]! > 0.9);
    const lower = probabilityToBeBestNormal(
      [
        { value: 5, se: 0.1 },
        { value: 4, se: 0.1 },
      ],
      true,
    );
    assert.ok(lower[1]! > 0.99);
  });
});
