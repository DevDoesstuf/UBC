/** Small numeric helpers for the pricing models. Pure functions, no dependencies. */

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function softmax(zs: number[]): number[] {
  const m = Math.max(...zs);
  const es = zs.map((z) => Math.exp(z - m));
  const s = es.reduce((a, b) => a + b, 0);
  return es.map((e) => e / s);
}

/** P(X = k) for X ~ Poisson(lambda). */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** P(X <= k) for X ~ Poisson(lambda). */
export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  let s = 0;
  for (let i = 0; i <= Math.floor(k); i++) s += poissonPmf(i, lambda);
  return Math.min(1, s);
}

/** P(X >= n) for X ~ Poisson(lambda). */
export function poissonAtLeast(n: number, lambda: number): number {
  if (n <= 0) return 1;
  return clamp(1 - poissonCdf(n - 1, lambda), 0, 1);
}

/**
 * Win / draw / loss probabilities for two independent Poisson scorers, starting from a current
 * lead of `lead` goals for the home side (remaining-goal rates `lh`, `la`).
 */
export function poissonMatch(lh: number, la: number, lead = 0, maxGoals = 12): { home: number; draw: number; away: number } {
  let home = 0;
  let draw = 0;
  let away = 0;
  const ph: number[] = [];
  const pa: number[] = [];
  for (let i = 0; i <= maxGoals; i++) {
    ph.push(poissonPmf(i, lh));
    pa.push(poissonPmf(i, la));
  }
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = ph[i]! * pa[j]!;
      const diff = lead + i - j;
      if (diff > 0) home += p;
      else if (diff < 0) away += p;
      else draw += p;
    }
  }
  const s = home + draw + away;
  return { home: home / s, draw: draw / s, away: away / s };
}

/**
 * Solve the two Poisson rates whose win/draw/loss probabilities best match the given (possibly
 * un-normalized, e.g. bookmaker-style) probabilities. Coarse grid, then two refinements.
 */
export function solvePoissonRates(pHome: number, pDraw: number, pAway: number): { home: number; away: number; error: number } {
  const s = pHome + pDraw + pAway;
  const target = { home: pHome / s, draw: pDraw / s, away: pAway / s };
  const err = (lh: number, la: number): number => {
    const m = poissonMatch(lh, la);
    return (m.home - target.home) ** 2 + (m.draw - target.draw) ** 2 + (m.away - target.away) ** 2;
  };
  let best = { home: 1.35, away: 1.1, error: err(1.35, 1.1) };
  let lo = { h: 0.2, a: 0.2 };
  let hi = { h: 4.0, a: 4.0 };
  let step = 0.2;
  for (let pass = 0; pass < 3; pass++) {
    for (let lh = lo.h; lh <= hi.h + 1e-9; lh += step) {
      for (let la = lo.a; la <= hi.a + 1e-9; la += step) {
        const e = err(lh, la);
        if (e < best.error) best = { home: lh, away: la, error: e };
      }
    }
    lo = { h: Math.max(0.05, best.home - step), a: Math.max(0.05, best.away - step) };
    hi = { h: best.home + step, a: best.away + step };
    step /= 5;
  }
  return { home: round(best.home, 3), away: round(best.away, 3), error: best.error };
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normalInv(p: number): number {
  const q = clamp(p, 1e-9, 1 - 1e-9);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (q < pl) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1);
  }
  if (q > 1 - pl) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1);
  }
  const r = q - 0.5;
  const t = r * r;
  return ((((((a[0]! * t + a[1]!) * t + a[2]!) * t + a[3]!) * t + a[4]!) * t + a[5]!) * r) / (((((b[0]! * t + b[1]!) * t + b[2]!) * t + b[3]!) * t + b[4]!) * t + 1);
}

export function round(x: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * Turn raw model numbers into a prior: clamp each outcome to [floor, 1 - floor], rescale to sum to 1,
 * round to 4 dp and push the rounding residue onto the largest outcome so the sum is exactly 1.
 */
export function normalizePrior(raw: Record<string, number>, floor = 0.02): Record<string, number> {
  const ids = Object.keys(raw);
  if (ids.length === 0) return {};
  let vals = ids.map((id) => {
    const v = raw[id]!;
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
  });
  let sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) vals = ids.map(() => 1 / ids.length);
  else vals = vals.map((v) => v / sum);
  // Clamp to the floor, then renormalize the unclamped mass (two passes are enough for n <= 4).
  for (let pass = 0; pass < 3; pass++) {
    const low = vals.map((v) => v < floor);
    const lowMass = low.filter(Boolean).length * floor;
    const freeMass = vals.reduce((a, v, i) => a + (low[i] ? 0 : v), 0);
    if (!low.some(Boolean) || freeMass <= 0) break;
    vals = vals.map((v, i) => (low[i] ? floor : (v / freeMass) * (1 - lowMass)));
  }
  const out: Record<string, number> = {};
  let maxId = ids[0]!;
  ids.forEach((id, i) => {
    out[id] = round(vals[i]!, 4);
    if (out[id]! > out[maxId]!) maxId = id;
  });
  sum = ids.reduce((a, id) => a + out[id]!, 0);
  out[maxId] = round(out[maxId]! + (1 - sum), 4);
  return out;
}

export function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}
