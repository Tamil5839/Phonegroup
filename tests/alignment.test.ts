import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { alignChain, planOutput, type PairMatches } from '../src/core/align';
import {
  ransacSimilarity,
  rectInsidePolygon,
  simAngle,
  simApply,
  simCompose,
  simFrom,
  simInvert,
  simScale,
  warpedOutline,
  type Sim,
} from '../src/core/geometry';
import { detectOrb, matchFeatures, type GrayImage } from '../src/process/features';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cv: any;

beforeAll(async () => {
  // The emscripten module is a "thenable" that resolves to itself, so it must never be awaited
  // (that includes `await import()`, whose namespace re-exports `then`). Load it with require.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = createRequire(import.meta.url)('@techstark/opencv-js') as any;
  if (!mod.Mat) await new Promise<void>((resolve) => (mod.onRuntimeInitialized = () => resolve()));
  cv = mod;
}, 60_000);

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** A textured scene with plenty of corners: random rectangles, discs and noise. */
function scene(width: number, height: number, seed = 1): GrayImage {
  const rand = rng(seed);
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = 90 + ((i * 7919) % 23);
  for (let s = 0; s < 260; s++) {
    const x0 = rand() * width;
    const y0 = rand() * height;
    const w = 6 + rand() * 50;
    const h = 6 + rand() * 50;
    const v = Math.floor(rand() * 255);
    const disc = rand() < 0.4;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, x0 + w); x++) {
        if (disc && (x - x0 - w / 2) ** 2 / (w / 2) ** 2 + (y - y0 - h / 2) ** 2 / (h / 2) ** 2 > 1) continue;
        data[y * width + x] = v;
      }
    }
  }
  return { data, width, height };
}

/** Image B with B(S(x)) = A(x): what a camera would see after the transform. */
function warp(a: GrayImage, s: Sim): GrayImage {
  const inv = simInvert(s);
  const out = new Uint8Array(a.width * a.height);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const p = simApply(inv, x, y);
      const x0 = Math.floor(p.x);
      const y0 = Math.floor(p.y);
      if (x0 < 0 || y0 < 0 || x0 >= a.width - 1 || y0 >= a.height - 1) {
        out[y * a.width + x] = 0;
        continue;
      }
      const fx = p.x - x0;
      const fy = p.y - y0;
      const i = y0 * a.width + x0;
      const v =
        a.data[i] * (1 - fx) * (1 - fy) +
        a.data[i + 1] * fx * (1 - fy) +
        a.data[i + a.width] * (1 - fx) * fy +
        a.data[i + a.width + 1] * fx * fy;
      out[y * a.width + x] = Math.round(v);
    }
  }
  return { data: out, width: a.width, height: a.height };
}

function about(center: { x: number; y: number }, scale: number, angle: number, shift: { x: number; y: number }): Sim {
  // Rotate/scale about `center`, then shift.
  const rs = simFrom(scale, angle);
  const c = simApply(rs, center.x, center.y);
  return { ...rs, tx: center.x - c.x + shift.x, ty: center.y - c.y + shift.y };
}

describe('feature-based alignment on synthetic images', () => {
  const W = 640;
  const H = 480;
  const base = scene(W, H, 7);

  it('recovers known similarity transforms (ORB + RANSAC)', () => {
    const cases = [
      about({ x: 320, y: 240 }, 1.0, 0, { x: 25, y: -12 }),
      about({ x: 320, y: 240 }, 1.08, 0.05, { x: -10, y: 8 }),
      about({ x: 300, y: 250 }, 0.92, -0.08, { x: 14, y: 20 }),
    ];
    const featA = detectOrb(cv, base, 1500);
    expect(featA.count).toBeGreaterThan(300);
    for (const truth of cases) {
      const b = warp(base, truth);
      const m = matchFeatures(cv, featA, detectOrb(cv, b, 1500));
      expect(m.count).toBeGreaterThan(80);
      const res = ransacSimilarity(m.src, m.dst, { threshold: 2.5, rng: rng(3) })!;
      expect(res).not.toBeNull();
      expect(simScale(res.sim)).toBeCloseTo(simScale(truth), 2);
      expect(Math.abs(simAngle(res.sim) - simAngle(truth))).toBeLessThan(0.005);
      for (const p of [
        { x: 320, y: 240 },
        { x: 100, y: 100 },
        { x: 540, y: 400 },
      ]) {
        const got = simApply(res.sim, p.x, p.y);
        const want = simApply(truth, p.x, p.y);
        expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(1.5);
      }
    }
  });

  it('carries the tapped subject through a chain of views and levels them', () => {
    // Five "phones": each sees the scene slightly shifted, zoomed and rolled.
    const subject = { x: 330, y: 250 };
    const views = [
      about(subject, 1.0, 0.0, { x: 0, y: 0 }),
      about(subject, 1.05, 0.03, { x: 18, y: -6 }),
      about(subject, 1.1, -0.02, { x: 30, y: 4 }),
      about(subject, 0.97, 0.04, { x: 8, y: 14 }),
      about(subject, 0.93, -0.05, { x: -16, y: 10 }),
    ];
    const images = views.map((v) => warp(base, v));
    const feats = images.map((img) => detectOrb(cv, img, 1500));
    const pairs: PairMatches[] = [];
    for (let i = 0; i < images.length - 1; i++) pairs.push(matchFeatures(cv, feats[i], feats[i + 1]));
    const frames = images.map((img) => ({ width: img.width, height: img.height }));
    // Tap the subject in the middle frame.
    const anchorIndex = 2;
    const anchorPoint = simApply(views[anchorIndex], subject.x, subject.y);
    const result = alignChain(frames, { index: anchorIndex, point: anchorPoint }, pairs, { rng: rng(11) });

    views.forEach((v, k) => {
      const truePoint = simApply(v, subject.x, subject.y);
      expect(Math.hypot(result[k].point.x - truePoint.x, result[k].point.y - truePoint.y), `frame ${k}`).toBeLessThan(2);
      // Scale relative to the anchor view.
      expect(result[k].scale).toBeCloseTo(simScale(v) / simScale(views[anchorIndex]), 2);
      // Rotation undoes each view's roll relative to the anchor.
      expect(result[k].rotation).toBeCloseTo(-(simAngle(v) - simAngle(views[anchorIndex])), 2);
      expect(['anchor', 'good']).toContain(result[k].confidence);
    });

    // The output plan puts the subject at the same output pixel in every frame and crops inside all frames.
    const plan = planOutput(frames, result, '16:9', [], 640)!;
    const outs = views.map((v, k) => {
      const p = simApply(v, subject.x, subject.y);
      return simApply(plan.transforms[k], p.x, p.y);
    });
    for (const o of outs) {
      expect(Math.abs(o.x - outs[0].x)).toBeLessThan(2.5);
      expect(Math.abs(o.y - outs[0].y)).toBeLessThan(2.5);
    }
    const rect = { x: 0, y: 0, w: plan.width, h: plan.height };
    frames.forEach((f, k) => {
      expect(rectInsidePolygon(rect, warpedOutline(plan.transforms[k], f.width, f.height), 1e-3)).toBe(true);
    });
  });

  it('uses tilt sensors for levelling when every phone reports one', () => {
    const frames = [
      { width: 100, height: 100, roll: 2 },
      { width: 100, height: 100, roll: -3 },
    ];
    const res = alignChain(frames, { index: 0, point: { x: 50, y: 50 } }, [null]);
    expect(res[0].rotation).toBeCloseTo((2 * Math.PI) / 180, 9);
    expect(res[1].rotation).toBeCloseTo((-3 * Math.PI) / 180, 9);
    expect(res[1].confidence).toBe('failed');
    // With no matches the subject stays at the same relative spot.
    expect(res[1].point).toEqual({ x: 50, y: 50 });
    const composed = simCompose(simFrom(1, 0), { a: 1, b: 0, tx: 0, ty: 0 });
    expect(composed.a).toBe(1);
  });
});
