/**
 * The "moment chirp": a short rising sweep the host plays exactly at T.
 * In manual mode, people record videos with their own camera app; we find
 * the chirp in each soundtrack with a matched filter (normalised
 * cross-correlation, computed with FFTs block by block) and take the video
 * frame at that instant.
 */

export interface ChirpSpec {
  f0: number;
  f1: number;
  durationMs: number;
}

/** 1.8 → 5.2 kHz: above most speech energy, well inside phone speaker/mic range. */
export const MOMENT_CHIRP: ChirpSpec = { f0: 1800, f1: 5200, durationMs: 160 };

/** Sample rate we analyse at (the browser resamples decoded audio to this). */
export const ANALYSIS_RATE = 16000;

export function chirpSamples(spec: ChirpSpec, sampleRate: number, amplitude = 0.8): Float32Array {
  const n = Math.round((spec.durationMs / 1000) * sampleRate);
  const out = new Float32Array(n);
  const dur = n / sampleRate;
  const k = (spec.f1 - spec.f0) / dur;
  const taper = Math.max(1, Math.round(n * 0.12));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (spec.f0 * t + 0.5 * k * t * t);
    // Tukey window: smooth edges avoid clicks and sharpen the correlation peak.
    let w = 1;
    if (i < taper) w = 0.5 * (1 - Math.cos((Math.PI * i) / taper));
    else if (i >= n - taper) w = 0.5 * (1 - Math.cos((Math.PI * (n - 1 - i)) / taper));
    out[i] = amplitude * w * Math.sin(phase);
  }
  return out;
}

/* ---------------------------------- FFT ---------------------------------- */

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

/** In-place radix-2 complex FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  const { cos, sin } = twiddles(n);
  const sign = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sign * sin[k * stride];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Cross-correlation c[τ] = Σ_i x[τ+i]·t[i] for τ in [0, x.length − t.length],
 * via overlap-save FFT blocks (bounded memory for long recordings).
 */
export function crossCorrelate(x: Float32Array, t: Float32Array): Float64Array {
  const m = t.length;
  const outLen = Math.max(0, x.length - m + 1);
  const out = new Float64Array(outLen);
  if (outLen === 0) return out;
  const size = Math.max(nextPow2(4 * m), 4096);
  const step = size - m + 1;
  const tr = new Float64Array(size);
  const ti = new Float64Array(size);
  tr.set(t);
  fft(tr, ti);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  for (let start = 0; start < outLen; start += step) {
    br.fill(0);
    bi.fill(0);
    const end = Math.min(x.length, start + size);
    for (let i = start; i < end; i++) br[i - start] = x[i];
    fft(br, bi);
    // Multiply by conj(T): correlation instead of convolution.
    for (let k = 0; k < size; k++) {
      const r = br[k] * tr[k] + bi[k] * ti[k];
      const im = bi[k] * tr[k] - br[k] * ti[k];
      br[k] = r;
      bi[k] = im;
    }
    fft(br, bi, true);
    const count = Math.min(step, outLen - start);
    for (let k = 0; k < count; k++) out[start + k] = br[k];
  }
  return out;
}

export interface ChirpDetection {
  /** Start of the chirp in seconds from the start of `signal`. */
  time: number;
  /** Normalised correlation at the peak (0–1). Above ~0.3 is a confident match. */
  score: number;
  /** Best score found away from the peak; a clear match has score ≫ runnerUp. */
  runnerUp: number;
}

export function detectChirp(signal: Float32Array, sampleRate: number, spec: ChirpSpec = MOMENT_CHIRP): ChirpDetection | null {
  const template = chirpSamples(spec, sampleRate, 1);
  const m = template.length;
  if (signal.length < m) return null;
  const corr = crossCorrelate(signal, template);
  let tnorm = 0;
  for (let i = 0; i < m; i++) tnorm += template[i] * template[i];
  tnorm = Math.sqrt(tnorm);
  // Sliding energy of the signal under the template.
  const prefix = new Float64Array(signal.length + 1);
  for (let i = 0; i < signal.length; i++) prefix[i + 1] = prefix[i] + signal[i] * signal[i];
  const floor = 1e-9 * m;
  let best = -1;
  let bestScore = -Infinity;
  const ncc = new Float64Array(corr.length);
  for (let tau = 0; tau < corr.length; tau++) {
    const e = prefix[tau + m] - prefix[tau];
    const v = corr[tau] / (tnorm * Math.sqrt(e + floor));
    ncc[tau] = v;
    if (v > bestScore) {
      bestScore = v;
      best = tau;
    }
  }
  if (best < 0) return null;
  let runnerUp = 0;
  for (let tau = 0; tau < ncc.length; tau++) if (Math.abs(tau - best) > m && ncc[tau] > runnerUp) runnerUp = ncc[tau];
  // Parabolic refinement of the raw correlation peak.
  let offset = 0;
  if (best > 0 && best < corr.length - 1) {
    const y0 = corr[best - 1];
    const y1 = corr[best];
    const y2 = corr[best + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
  }
  return { time: (best + offset) / sampleRate, score: Math.max(0, bestScore), runnerUp };
}

/** Linear-interpolation resampler (used when the browser can't resample for us). */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  // Crude low-pass by box-averaging when downsampling.
  const box = Math.max(1, Math.floor(ratio));
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    let s = 0;
    let n = 0;
    for (let k = 0; k < box && i0 + k < input.length; k++) {
      s += input[i0 + k];
      n++;
    }
    out[i] = n ? s / n : 0;
  }
  return out;
}
