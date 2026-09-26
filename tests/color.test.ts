import { describe, expect, it } from 'vitest';
import { applyLuts, buildMatchLuts, computeStats, histogramDistance, medianReference, oklabToRgb, rgbToOklab } from '../src/core/color';

/** A 96×64 test "photo": gradients, a skin-toned patch and some texture. */
function scene(transform: (r: number, g: number, b: number) => [number, number, number], seed = 1): Uint8ClampedArray {
  const w = 96;
  const h = 64;
  const out = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const noise = ((s >>> 24) - 128) / 16;
      let r = 40 + (x / w) * 160 + noise;
      let g = 60 + (y / h) * 120 + noise;
      let b = 90 + ((x + y) / (w + h)) * 100 + noise;
      if (x > 30 && x < 60 && y > 20 && y < 45) [r, g, b] = [205 + noise, 160 + noise, 130 + noise]; // skin tone
      const [tr, tg, tb] = transform(r, g, b);
      const p = (y * w + x) * 4;
      out[p] = tr;
      out[p + 1] = tg;
      out[p + 2] = tb;
      out[p + 3] = 255;
    }
  }
  return out;
}

const variants: ((r: number, g: number, b: number) => [number, number, number])[] = [
  (r, g, b) => [r, g, b],
  (r, g, b) => [r * 1.15, g * 1.1, b * 1.05], // brighter
  (r, g, b) => [r * 0.8, g * 0.82, b * 0.85], // darker
  (r, g, b) => [r * 1.08, g, b * 0.85], // warm cast
  (r, g, b) => [r * 0.9, g * 0.98, b * 1.12], // cool cast
  (r, g, b) => [(r - 128) * 1.2 + 128, (g - 128) * 1.2 + 128, (b - 128) * 1.2 + 128], // contrasty
];

describe('OKLab conversion', () => {
  it('round-trips sRGB colours', () => {
    for (const [r, g, b] of [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [12, 200, 90],
      [205, 160, 130],
    ]) {
      const lab = rgbToOklab(r, g, b);
      const back = oklabToRgb(...lab);
      expect(back[0]).toBeCloseTo(r, 0);
      expect(back[1]).toBeCloseTo(g, 0);
      expect(back[2]).toBeCloseTo(b, 0);
    }
    const white = rgbToOklab(255, 255, 255);
    expect(white[0]).toBeCloseTo(1, 3);
    expect(Math.abs(white[1])).toBeLessThan(1e-3);
  });
});

describe('histogram matching toward the median frame', () => {
  const frames = variants.map((v, i) => scene(v, i + 1));
  const stats = frames.map((f) => computeStats(f));
  const ref = medianReference(stats);
  const refStats = computeStats(scene(variants[0], 99));

  function distanceToRef(rgba: Uint8ClampedArray) {
    const s = computeStats(rgba);
    return [0, 1, 2].reduce((sum, ch) => sum + histogramDistance(s.hist[ch], refStats.hist[ch]), 0);
  }

  it('moves every frame toward the reference (full strength)', () => {
    frames.forEach((f, i) => {
      if (i === 0) return;
      const before = distanceToRef(f);
      const copy = new Uint8ClampedArray(f);
      applyLuts(copy, buildMatchLuts(stats[i], ref, { strength: 1, chromaFactor: 1 }));
      const after = distanceToRef(copy);
      expect(after, `variant ${i}`).toBeLessThan(before * 0.6);
    });
  });

  it('blends gently by default: partial correction, colours kept plausible', () => {
    frames.forEach((f, i) => {
      if (i === 0) return;
      const full = new Uint8ClampedArray(f);
      applyLuts(full, buildMatchLuts(stats[i], ref, { strength: 1, chromaFactor: 1 }));
      const gentle = new Uint8ClampedArray(f);
      applyLuts(gentle, buildMatchLuts(stats[i], ref));
      const before = distanceToRef(f);
      const g = distanceToRef(gentle);
      expect(g).toBeLessThan(before);
      expect(g).toBeGreaterThan(distanceToRef(full) * 0.9);
      // The skin patch keeps a skin-like hue (red > green > blue).
      const p = (32 * 96 + 45) * 4;
      expect(gentle[p]).toBeGreaterThan(gentle[p + 1]);
      expect(gentle[p + 1]).toBeGreaterThan(gentle[p + 2]);
    });
  });

  it('leaves an already matching frame almost unchanged', () => {
    const f = frames[0];
    const copy = new Uint8ClampedArray(f);
    applyLuts(copy, buildMatchLuts(stats[0], medianReference([stats[0]]), { strength: 1 }));
    let maxDiff = 0;
    for (let i = 0; i < f.length; i += 4) for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(f[i + c] - copy[i + c]));
    expect(maxDiff).toBeLessThanOrEqual(6);
  });
});
