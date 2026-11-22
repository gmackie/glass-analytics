/**
 * Statistics for experiment readouts.
 *
 * - Conversion goals: Bayesian beta-binomial with a uniform Beta(1, 1) prior.
 *   We report P(variant beats control) and a 95% credible interval for the
 *   relative lift, both by Monte Carlo with a fixed seed.
 * - Mean goals (e.g. revenue per person): Welch's t-test with a normal
 *   approximation, which is accurate at the sample sizes experiments need.
 * - Sample ratio mismatch: chi-square goodness of fit against the configured
 *   variant weights. A tiny p-value means assignment or tracking is broken and
 *   the results should not be trusted.
 */

import { beta, mulberry32, normal } from './random.ts';

export interface ConversionStats {
  exposures: number;
  conversions: number;
}

export interface BayesComparison {
  /** P(variant rate > control rate). */
  probabilityToBeatControl: number;
  /**
   * Posterior median of (variant - control) / control. (The mean is unstable: with few
   * conversions the control rate can be near zero, and the ratio's mean runs away.)
   */
  expectedLift: number;
  /** 95% credible interval for the relative lift. */
  liftInterval: [number, number];
}

/** Compare a variant to control under Beta(1 + conversions, 1 + failures) posteriors. */
export function compareConversions(
  control: ConversionStats,
  variant: ConversionStats,
  samples = 20_000,
  seed = 42,
): BayesComparison {
  const rng = mulberry32(seed);
  const lifts = new Float64Array(samples);
  let wins = 0;
  for (let i = 0; i < samples; i++) {
    const c = beta(1 + control.conversions, 1 + control.exposures - control.conversions, rng);
    const v = beta(1 + variant.conversions, 1 + variant.exposures - variant.conversions, rng);
    if (v > c) wins++;
    lifts[i] = (v - c) / c;
  }
  lifts.sort();
  return {
    probabilityToBeatControl: wins / samples,
    expectedLift: lifts[Math.floor(samples / 2)]!,
    liftInterval: [lifts[Math.floor(0.025 * samples)]!, lifts[Math.floor(0.975 * samples)]!],
  };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface MeanStats {
  n: number;
  sum: number;
  sumSquares: number;
}

export interface MeanComparison {
  controlMean: number;
  variantMean: number;
  difference: number;
  /** 95% confidence interval for the difference in means. */
  interval: [number, number];
  /** Two-sided p-value. */
  pValue: number;
}

/** Welch's t-test from sufficient statistics (normal approximation). */
export function compareMeans(control: MeanStats, variant: MeanStats): MeanComparison {
  const stats = (s: MeanStats) => {
    const mean = s.n ? s.sum / s.n : 0;
    const variance = s.n > 1 ? Math.max(0, (s.sumSquares - s.n * mean * mean) / (s.n - 1)) : 0;
    return { mean, variance };
  };
  const c = stats(control);
  const v = stats(variant);
  const se = Math.sqrt(
    (control.n ? c.variance / control.n : 0) + (variant.n ? v.variance / variant.n : 0),
  );
  const diff = v.mean - c.mean;
  const z = se > 0 ? diff / se : 0;
  return {
    controlMean: c.mean,
    variantMean: v.mean,
    difference: diff,
    interval: [diff - 1.96 * se, diff + 1.96 * se],
    pValue: se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1,
  };
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export interface SrmResult {
  chiSquare: number;
  pValue: number;
  /** True when p < 0.001: treat the experiment as broken until explained. */
  mismatch: boolean;
}

/** Chi-square goodness-of-fit test of observed exposures against expected weights. */
export function sampleRatioMismatch(observed: number[], weights: number[]): SrmResult {
  const total = observed.reduce((a, b) => a + b, 0);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || weightSum === 0 || observed.length < 2)
    return { chiSquare: 0, pValue: 1, mismatch: false };
  let chi = 0;
  observed.forEach((o, i) => {
    const expected = (total * (weights[i] ?? 0)) / weightSum;
    if (expected > 0) chi += (o - expected) ** 2 / expected;
  });
  const pValue = chiSquareSurvival(chi, observed.length - 1);
  return { chiSquare: chi, pValue, mismatch: pValue < 0.001 };
}

/** P(X > x) for a chi-square distribution with k degrees of freedom. */
export function chiSquareSurvival(x: number, k: number): number {
  if (x <= 0) return 1;
  return upperRegularizedGamma(k / 2, x / 2);
}

/** Q(a, x), the regularized upper incomplete gamma function (Numerical Recipes 6.2). */
function upperRegularizedGamma(a: number, x: number): number {
  if (x < a + 1) {
    // Series for P(a, x), then Q = 1 - P.
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // Continued fraction for Q(a, x) (Lentz's method).
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Lanczos approximation of ln Γ(x). */
function logGamma(x: number): number {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xx = x - 1;
  let a = coef[0]!;
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += coef[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * People needed per variant to detect a relative lift `mde` on a base rate `p`
 * with a two-sided test at alpha 0.05 and 80% power.
 */
export function sampleSizePerVariant(p: number, mde: number): number {
  const p2 = p * (1 + mde);
  if (p <= 0 || p >= 1 || p2 <= 0 || p2 >= 1 || p2 === p) return Number.POSITIVE_INFINITY;
  const zAlpha = 1.959964;
  const zBeta = 0.841621;
  return Math.ceil(((zAlpha + zBeta) ** 2 * (p * (1 - p) + p2 * (1 - p2))) / (p2 - p) ** 2);
}

// ── Experiments v2: several variants, means, ratios, both engines ───────────

/** The two-sided z for a confidence level (0.9 → 1.645, 0.95 → 1.96, 0.99 → 2.576). */
export function zFor(confidence: number): number {
  return inverseNormalCdf(1 - (1 - confidence) / 2);
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function inverseNormalCdf(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - lo) return -inverseNormalCdf(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/**
 * P(each variant is the best) under Beta(1 + s, 1 + n - s) posteriors, by joint Monte Carlo.
 * `lowerIsBetter` for metrics that should go down. Same seed, same answer.
 */
export function probabilityToBeBestBeta(
  variants: readonly ConversionStats[],
  lowerIsBetter = false,
  samples = 20_000,
  seed = 7,
): number[] {
  const rng = mulberry32(seed);
  const wins = new Array<number>(variants.length).fill(0);
  for (let i = 0; i < samples; i++) {
    let best = -1;
    let bestValue = lowerIsBetter ? Infinity : -Infinity;
    variants.forEach((v, j) => {
      const x = beta(1 + v.conversions, 1 + Math.max(0, v.exposures - v.conversions), rng);
      if (lowerIsBetter ? x < bestValue : x > bestValue) {
        bestValue = x;
        best = j;
      }
    });
    if (best >= 0) wins[best]!++;
  }
  return wins.map((w) => w / samples);
}

/** Mean and standard error from sufficient statistics. */
export function meanAndError(s: MeanStats): { mean: number; variance: number; se: number } {
  const mean = s.n ? s.sum / s.n : 0;
  const variance = s.n > 1 ? Math.max(0, (s.sumSquares - s.n * mean * mean) / (s.n - 1)) : 0;
  return { mean, variance, se: s.n ? Math.sqrt(variance / s.n) : 0 };
}

/** Sufficient statistics of a ratio metric (Σx / Σy per person). */
export interface RatioStats {
  n: number;
  sumX: number;
  sumY: number;
  sumX2: number;
  sumY2: number;
  sumXY: number;
}

/** A ratio of sums and its standard error by the delta method. */
export function ratioAndError(s: RatioStats): { ratio: number; se: number } {
  if (s.n < 2 || s.sumY === 0) return { ratio: s.sumY ? s.sumX / s.sumY : 0, se: 0 };
  const n = s.n;
  const mx = s.sumX / n;
  const my = s.sumY / n;
  const vx = Math.max(0, (s.sumX2 - n * mx * mx) / (n - 1));
  const vy = Math.max(0, (s.sumY2 - n * my * my) / (n - 1));
  const cxy = (s.sumXY - n * mx * my) / (n - 1);
  const r = mx / my;
  const variance = (vx - 2 * r * cxy + r * r * vy) / (n * my * my);
  return { ratio: r, se: Math.sqrt(Math.max(0, variance)) };
}

/** An estimate with its standard error, for normal-approximation comparisons. */
export interface Estimate {
  value: number;
  se: number;
}

export interface Comparison {
  /** P(variant better than control): Bayesian under normal/beta posteriors. */
  probabilityToBeatControl: number;
  /** Expected relative lift, (variant - control) / control. */
  expectedLift: number;
  /** Credible (Bayesian) or confidence (frequentist) interval of the relative lift. */
  liftInterval: [number, number];
  /** Two-sided p-value (frequentist engine). */
  pValue: number;
  /** Interval of the absolute difference at the chosen confidence. */
  differenceInterval: [number, number];
}

/** Compare two normal estimates: Bayesian probability (flat prior) and a frequentist z-test. */
export function compareEstimates(
  control: Estimate,
  variant: Estimate,
  confidence = 0.95,
  lowerIsBetter = false,
): Comparison {
  const diff = variant.value - control.value;
  const se = Math.sqrt(control.se ** 2 + variant.se ** 2);
  const z = zFor(confidence);
  const pBetter =
    se > 0
      ? normalCdf((lowerIsBetter ? -diff : diff) / se)
      : diff === 0
        ? 0.5
        : (lowerIsBetter ? diff < 0 : diff > 0)
          ? 1
          : 0;
  // Relative lift by the delta method: (v/c - 1), Var ≈ (se_v² + (v/c)² se_c²) / c².
  const c = control.value;
  const lift = c !== 0 ? diff / c : 0;
  const liftSe =
    c !== 0
      ? Math.sqrt(variant.se ** 2 + (variant.value / c) ** 2 * control.se ** 2) / Math.abs(c)
      : 0;
  return {
    probabilityToBeatControl: pBetter,
    expectedLift: lift,
    liftInterval: [lift - z * liftSe, lift + z * liftSe],
    pValue: se > 0 ? 2 * (1 - normalCdf(Math.abs(diff / se))) : 1,
    differenceInterval: [diff - z * se, diff + z * se],
  };
}

/**
 * Compare conversion rates. Bayesian: beta-binomial Monte Carlo (as `compareConversions`).
 * Frequentist: an unpooled two-proportion z-test.
 */
export function compareProportions(
  control: ConversionStats,
  variant: ConversionStats,
  confidence = 0.95,
  lowerIsBetter = false,
): Comparison {
  const bayes = compareConversions(control, variant);
  const pc = control.exposures ? control.conversions / control.exposures : 0;
  const pv = variant.exposures ? variant.conversions / variant.exposures : 0;
  const freq = compareEstimates(
    { value: pc, se: control.exposures ? Math.sqrt((pc * (1 - pc)) / control.exposures) : 0 },
    { value: pv, se: variant.exposures ? Math.sqrt((pv * (1 - pv)) / variant.exposures) : 0 },
    confidence,
    lowerIsBetter,
  );
  const probability = lowerIsBetter
    ? 1 - bayes.probabilityToBeatControl
    : bayes.probabilityToBeatControl;
  // Credible interval at the chosen confidence from the Monte Carlo lifts.
  const interval =
    confidence === 0.95
      ? bayes.liftInterval
      : compareConversionsInterval(control, variant, confidence);
  return {
    probabilityToBeatControl: probability,
    expectedLift: bayes.expectedLift,
    liftInterval: interval,
    pValue: freq.pValue,
    differenceInterval: freq.differenceInterval,
  };
}

function compareConversionsInterval(
  control: ConversionStats,
  variant: ConversionStats,
  confidence: number,
  samples = 20_000,
  seed = 42,
): [number, number] {
  const rng = mulberry32(seed);
  const lifts = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const c = beta(1 + control.conversions, 1 + control.exposures - control.conversions, rng);
    const v = beta(1 + variant.conversions, 1 + variant.exposures - variant.conversions, rng);
    lifts[i] = (v - c) / c;
  }
  lifts.sort();
  const tail = (1 - confidence) / 2;
  return [
    lifts[Math.floor(tail * samples)]!,
    lifts[Math.min(samples - 1, Math.floor((1 - tail) * samples))]!,
  ];
}

/** P(each estimate is the best) under independent normal posteriors, by joint Monte Carlo. */
export function probabilityToBeBestNormal(
  estimates: readonly Estimate[],
  lowerIsBetter = false,
  samples = 20_000,
  seed = 11,
): number[] {
  const rng = mulberry32(seed);
  const wins = new Array<number>(estimates.length).fill(0);
  for (let i = 0; i < samples; i++) {
    let best = -1;
    let bestValue = lowerIsBetter ? Infinity : -Infinity;
    estimates.forEach((e, j) => {
      const x = e.value + e.se * normal(rng);
      if (lowerIsBetter ? x < bestValue : x > bestValue) {
        bestValue = x;
        best = j;
      }
    });
    if (best >= 0) wins[best]!++;
  }
  return wins.map((w) => w / samples);
}

/**
 * People needed per variant to detect a relative change `mde` in a mean with standard
 * deviation `sd` (two-sided, alpha from `confidence`, 80% power).
 */
export function sampleSizeForMean(
  mean: number,
  sd: number,
  mde: number,
  confidence = 0.95,
): number {
  const delta = Math.abs(mean * mde);
  if (delta === 0 || sd === 0) return Number.POSITIVE_INFINITY;
  const zA = zFor(confidence);
  const zB = 0.841621;
  return Math.ceil((2 * (zA + zB) ** 2 * sd * sd) / (delta * delta));
}

/** As `sampleSizePerVariant`, at a chosen confidence. */
export function sampleSizeForRate(p: number, mde: number, confidence = 0.95): number {
  const p2 = p * (1 + mde);
  if (p <= 0 || p >= 1 || p2 <= 0 || p2 >= 1 || p2 === p) return Number.POSITIVE_INFINITY;
  const zA = zFor(confidence);
  const zB = 0.841621;
  return Math.ceil(((zA + zB) ** 2 * (p * (1 - p) + p2 * (1 - p2))) / (p2 - p) ** 2);
}
