/**
 * Colour matching between phones.
 *
 * Each frame's pixels are described in OKLab (a perceptual space: L is
 * lightness, a/b are green–red and blue–yellow). The reference is the "median
 * frame": for every quantile level, the median across frames of that
 * quantile. Each frame is then histogram-matched towards the reference, per
 * channel, and the result is blended only partway (chroma less than lightness)
 * so skin tones stay natural.
 */

export const BINS = 256;
/** Channel ranges used for histograms and lookup tables. */
export const RANGES: readonly [number, number][] = [
  [0, 1], // L
  [-0.32, 0.32], // a
  [-0.32, 0.32], // b
];

export type Lab = [number, number, number];

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear RGB (0–1) → 8-bit sRGB value, unrounded and unclamped. */
export function linearToSrgb(x: number): number {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return c * 255;
}

/** 8-bit sRGB → OKLab (integer inputs use a lookup table). */
export function rgbToOklab(r: number, g: number, b: number): Lab {
  const lin = (v: number) => (Number.isInteger(v) && v >= 0 && v <= 255 ? SRGB_TO_LINEAR[v] : srgbToLinear(v));
  return linearRgbToOklab(lin(r), lin(g), lin(b));
}

export function linearRgbToOklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear RGB (may fall outside 0–1 for out-of-gamut colours). */
export function oklabToLinearRgb(L: number, A: number, B: number): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklabToRgb(L: number, A: number, B: number): [number, number, number] {
  const [r, g, b] = oklabToLinearRgb(L, A, B);
  return [encode(r), encode(g), encode(b)];
}

function encode(x: number): number {
  return Math.round(Math.min(255, Math.max(0, linearToSrgb(x))));
}

export interface ColorStats {
  /** Histograms for L, a, b (BINS each). */
  hist: [Float64Array, Float64Array, Float64Array];
  count: number;
}

function binOf(v: number, ch: number): number {
  const [lo, hi] = RANGES[ch];
  const t = (v - lo) / (hi - lo);
  return Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)));
}

export function binCenter(i: number, ch: number): number {
  const [lo, hi] = RANGES[ch];
  return lo + ((i + 0.5) / BINS) * (hi - lo);
}

/** Histogram an RGBA buffer (sampled every `step` pixels). */
export function computeStats(rgba: ArrayLike<number>, step = 1): ColorStats {
  const hist: [Float64Array, Float64Array, Float64Array] = [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)];
  let count = 0;
  for (let p = 0; p < rgba.length; p += 4 * step) {
    const lab = rgbToOklab(rgba[p], rgba[p + 1], rgba[p + 2]);
    for (let ch = 0; ch < 3; ch++) hist[ch][binOf(lab[ch], ch)]++;
    count++;
  }
  return { hist, count };
}

/** Quantile function sampled at QUANTILES evenly spaced probability levels. */
export const QUANTILES = 256;

export function quantiles(hist: Float64Array, ch: number): Float64Array {
  const total = hist.reduce((s, v) => s + v, 0);
  const out = new Float64Array(QUANTILES);
  if (total === 0) {
    for (let q = 0; q < QUANTILES; q++) out[q] = binCenter(Math.floor((q / QUANTILES) * BINS), ch);
    return out;
  }
  const [lo, hi] = RANGES[ch];
  const width = (hi - lo) / BINS;
  let cum = 0;
  let bin = 0;
  for (let q = 0; q < QUANTILES; q++) {
    const target = ((q + 0.5) / QUANTILES) * total;
    while (bin < BINS - 1 && cum + hist[bin] < target) cum += hist[bin++];
    // Linear interpolation inside the bin.
    const within = hist[bin] > 0 ? (target - cum) / hist[bin] : 0.5;
    out[q] = lo + (bin + Math.min(1, Math.max(0, within))) * width;
  }
  return out;
}

/** The "median frame": per-channel, per-quantile median across all frames. */
export function medianReference(stats: readonly ColorStats[]): [Float64Array, Float64Array, Float64Array] {
  const ref: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(QUANTILES),
    new Float64Array(QUANTILES),
    new Float64Array(QUANTILES),
  ];
  for (let ch = 0; ch < 3; ch++) {
    const qs = stats.map((s) => quantiles(s.hist[ch], ch));
    const col = new Float64Array(qs.length);
    for (let q = 0; q < QUANTILES; q++) {
      for (let k = 0; k < qs.length; k++) col[k] = qs[k][q];
      const sorted = Array.from(col).sort((x, y) => x - y);
      const m = sorted.length >> 1;
      ref[ch][q] = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    }
  }
  return ref;
}

export interface MatchOptions {
  /** 0 = no change, 1 = full histogram match. Applied to lightness. */
  strength?: number;
  /** Multiplier on `strength` for the a/b (colour) channels. */
  chromaFactor?: number;
}

/**
 * Per-channel lookup tables (value at each bin centre → new value) that move a
 * frame's distribution towards the reference. Output is in channel units.
 */
export function buildMatchLuts(
  stats: ColorStats,
  ref: readonly Float64Array[],
  { strength = 0.7, chromaFactor = 0.7 }: MatchOptions = {},
): [Float32Array, Float32Array, Float32Array] {
  const luts: Float32Array[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const hist = stats.hist[ch];
    const total = hist.reduce((s, v) => s + v, 0);
    const k = ch === 0 ? strength : strength * chromaFactor;
    const raw = new Float64Array(BINS);
    let cum = 0;
    for (let i = 0; i < BINS; i++) {
      const v = binCenter(i, ch);
      if (total === 0) {
        raw[i] = v;
        continue;
      }
      // CDF at the bin centre (mid-bin convention).
      const p = (cum + hist[i] / 2) / total;
      cum += hist[i];
      raw[i] = sampleQuantile(ref[ch], p);
    }
    // Smooth the correction curve so sparse histograms don't produce banding,
    // and keep it monotonic. Empty bins carry no information (their mapping
    // is arbitrary), so the smoothing is weighted by how many pixels each bin holds.
    const delta = new Float64Array(BINS);
    for (let i = 0; i < BINS; i++) delta[i] = raw[i] - binCenter(i, ch);
    const smooth = weightedSmooth(delta, hist, 4);
    const lut = new Float32Array(BINS);
    let prev = -Infinity;
    for (let i = 0; i < BINS; i++) {
      let v = binCenter(i, ch) + k * smooth[i];
      if (v < prev) v = prev;
      lut[i] = v;
      prev = v;
    }
    luts.push(lut);
  }
  return luts as [Float32Array, Float32Array, Float32Array];
}

function sampleQuantile(q: Float64Array, p: number): number {
  const x = p * QUANTILES - 0.5;
  if (x <= 0) return q[0];
  if (x >= QUANTILES - 1) return q[QUANTILES - 1];
  const i = Math.floor(x);
  const f = x - i;
  return q[i] * (1 - f) + q[i + 1] * f;
}

/**
 * Box smoothing weighted by histogram counts. Bins with no pixels nearby take
 * the value of the nearest populated bin (or 0 if the histogram is empty).
 */
function weightedSmooth(v: Float64Array, weights: Float64Array, radius: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  const known = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      s += v[j] * weights[j];
      w += weights[j];
    }
    if (w > 0) {
      out[i] = s / w;
      known[i] = 1;
    }
  }
  // Fill gaps from the nearest known bin on either side.
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (known[i]) {
      if (last === -1) for (let k = 0; k < i; k++) out[k] = out[i];
      else for (let k = last + 1; k < i; k++) out[k] = out[last] + ((out[i] - out[last]) * (k - last)) / (i - last);
      last = i;
    }
  }
  if (last >= 0) for (let k = last + 1; k < n; k++) out[k] = out[last];
  return out;
}

/** Look up a channel value in a LUT with linear interpolation. */
export function lutLookup(lut: Float32Array, v: number, ch: number): number {
  const [lo, hi] = RANGES[ch];
  const x = ((v - lo) / (hi - lo)) * BINS - 0.5;
  if (x <= 0) return lut[0] + (v - binCenter(0, ch));
  if (x >= BINS - 1) return lut[BINS - 1] + (v - binCenter(BINS - 1, ch));
  const i = Math.floor(x);
  const f = x - i;
  return lut[i] * (1 - f) + lut[i + 1] * f;
}

/** CPU path: apply LUTs to an RGBA buffer in place. */
export function applyLuts(rgba: Uint8ClampedArray | Uint8Array, luts: readonly Float32Array[]): void {
  // Cache by quantised colour: photos repeat colours a lot and cbrt is costly.
  const cache = new Map<number, number>();
  for (let p = 0; p < rgba.length; p += 4) {
    const key = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    let packed = cache.get(key);
    if (packed === undefined) {
      const [L, A, B] = rgbToOklab(rgba[p], rgba[p + 1], rgba[p + 2]);
      const [r, g, b] = oklabToRgb(lutLookup(luts[0], L, 0), lutLookup(luts[1], A, 1), lutLookup(luts[2], B, 2));
      packed = (r << 16) | (g << 8) | b;
      if (cache.size < 1 << 18) cache.set(key, packed);
    }
    rgba[p] = packed >> 16;
    rgba[p + 1] = (packed >> 8) & 255;
    rgba[p + 2] = packed & 255;
  }
}

/** Earth mover's distance between two normalised histograms (in bins). Used to measure improvement. */
export function histogramDistance(a: Float64Array, b: Float64Array): number {
  const ta = a.reduce((s, v) => s + v, 0) || 1;
  const tb = b.reduce((s, v) => s + v, 0) || 1;
  let ca = 0;
  let cb = 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    ca += a[i] / ta;
    cb += b[i] / tb;
    d += Math.abs(ca - cb);
  }
  return d;
}
