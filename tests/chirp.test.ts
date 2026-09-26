import { describe, expect, it } from 'vitest';
import { chirpSamples, crossCorrelate, detectChirp, fft, MOMENT_CHIRP } from '../src/core/chirp';

function noise(n: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    // Sum of uniforms ≈ Gaussian.
    let v = 0;
    for (let k = 0; k < 4; k++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      v += s / 4294967296 - 0.5;
    }
    out[i] = v * amp;
  }
  return out;
}

describe('FFT', () => {
  it('matches a direct DFT and inverts', () => {
    const n = 64;
    const re = new Float64Array(n).map((_, i) => Math.sin(i * 0.3) + (i % 5) * 0.1);
    const im = new Float64Array(n);
    const origRe = re.slice();
    const dftRe = new Float64Array(n);
    const dftIm = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      for (let t = 0; t < n; t++) {
        dftRe[k] += origRe[t] * Math.cos((-2 * Math.PI * k * t) / n);
        dftIm[k] += origRe[t] * Math.sin((-2 * Math.PI * k * t) / n);
      }
    }
    fft(re, im);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(dftRe[k], 9);
      expect(im[k]).toBeCloseTo(dftIm[k], 9);
    }
    fft(re, im, true);
    for (let k = 0; k < n; k++) expect(re[k]).toBeCloseTo(origRe[k], 9);
  });

  it('cross-correlates like the direct formula', () => {
    const x = noise(20000, 1, 5);
    const t = noise(300, 1, 9);
    const c = crossCorrelate(x, t);
    for (const tau of [0, 1, 777, 12345, x.length - t.length]) {
      let direct = 0;
      for (let i = 0; i < t.length; i++) direct += x[tau + i] * t[i];
      expect(c[tau]).toBeCloseTo(direct, 6);
    }
  });
});

describe('chirp detection', () => {
  const rate = 16000;

  function recording(chirpAt: number | null, opts: { noiseAmp?: number; gain?: number; echo?: boolean } = {}) {
    const sig = noise(rate * 6, opts.noiseAmp ?? 0.05, 3);
    // Countdown beeps at 1, 2, 3 s (880 Hz) and some speech-band hum.
    for (const at of [1, 2, 3]) {
      for (let i = 0; i < rate * 0.12; i++) sig[Math.floor(at * rate) + i] += 0.5 * Math.sin((2 * Math.PI * 880 * i) / rate);
    }
    for (let i = 0; i < sig.length; i++) sig[i] += 0.05 * Math.sin((2 * Math.PI * 220 * i) / rate);
    if (chirpAt !== null) {
      const c = chirpSamples(MOMENT_CHIRP, rate, 0.3 * (opts.gain ?? 1));
      const start = Math.round(chirpAt * rate);
      for (let i = 0; i < c.length; i++) {
        sig[start + i] += c[i];
        if (opts.echo) sig[start + i + Math.round(0.011 * rate)] += 0.4 * c[i]; // a wall 2 m away
      }
    }
    return sig;
  }

  it('finds the chirp to well under a millisecond among beeps and noise', () => {
    for (const at of [0.5, 2.3456, 4.1234]) {
      const det = detectChirp(recording(at), rate)!;
      expect(Math.abs(det.time - at) * 1000).toBeLessThan(0.3);
      expect(det.score).toBeGreaterThan(0.5);
      expect(det.score).toBeGreaterThan(det.runnerUp * 2);
    }
  });

  it('copes with a quiet chirp and room echo', () => {
    const det = detectChirp(recording(3.5, { gain: 0.25, noiseAmp: 0.08, echo: true }), rate)!;
    expect(Math.abs(det.time - 3.5) * 1000).toBeLessThan(1);
    expect(det.score).toBeGreaterThan(0.2);
  });

  it('reports a low score when there is no chirp', () => {
    const det = detectChirp(recording(null), rate)!;
    expect(det.score).toBeLessThan(0.2);
  });
});
