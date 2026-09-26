import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  fitSimilarity,
  homographyFrom4,
  largestCommonCrop,
  ransacSimilarity,
  rectInsidePolygon,
  simAngle,
  simApply,
  simCompose,
  simFrom,
  simInvert,
  simScale,
  warpedOutline,
  type Pt,
} from '../src/core/geometry';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

describe('similarity transforms', () => {
  it('composes and inverts', () => {
    const p = simFrom(1.3, 0.4, 10, -5);
    const q = simFrom(0.7, -1.1, -3, 8);
    const pq = simCompose(p, q);
    const x = { x: 12.5, y: -7 };
    const direct = simApply(p, simApply(q, x.x, x.y).x, simApply(q, x.x, x.y).y);
    const composed = simApply(pq, x.x, x.y);
    expect(composed.x).toBeCloseTo(direct.x, 9);
    expect(composed.y).toBeCloseTo(direct.y, 9);
    const back = simApply(simInvert(pq), composed.x, composed.y);
    expect(back.x).toBeCloseTo(x.x, 9);
    expect(back.y).toBeCloseTo(x.y, 9);
    expect(simScale(pq)).toBeCloseTo(1.3 * 0.7, 9);
    expect(simAngle(pq)).toBeCloseTo(0.4 - 1.1, 9);
  });

  it('fits exact correspondences', () => {
    const truth = simFrom(0.9, 0.2, 40, -12);
    const src: number[] = [];
    const dst: number[] = [];
    for (let i = 0; i < 10; i++) {
      const x = i * 13 - 50;
      const y = (i * i) % 17;
      const p = simApply(truth, x, y);
      src.push(x, y);
      dst.push(p.x, p.y);
    }
    const fit = fitSimilarity(src, dst)!;
    expect(fit.a).toBeCloseTo(truth.a, 9);
    expect(fit.b).toBeCloseTo(truth.b, 9);
    expect(fit.tx).toBeCloseTo(truth.tx, 9);
    expect(fit.ty).toBeCloseTo(truth.ty, 9);
  });

  it('RANSAC recovers the transform despite 60% outliers and noise', () => {
    const rand = rng(7);
    for (let trial = 0; trial < 20; trial++) {
      const truth = simFrom(0.8 + rand() * 0.5, (rand() - 0.5) * 0.6, (rand() - 0.5) * 200, (rand() - 0.5) * 200);
      const src: number[] = [];
      const dst: number[] = [];
      for (let i = 0; i < 200; i++) {
        const x = rand() * 800;
        const y = rand() * 600;
        src.push(x, y);
        if (i % 5 < 2) {
          const p = simApply(truth, x, y);
          dst.push(p.x + (rand() - 0.5) * 1.5, p.y + (rand() - 0.5) * 1.5);
        } else {
          dst.push(rand() * 800, rand() * 600);
        }
      }
      const res = ransacSimilarity(src, dst, { threshold: 3, rng: rand })!;
      expect(res).not.toBeNull();
      expect(res.count).toBeGreaterThanOrEqual(75);
      expect(simScale(res.sim)).toBeCloseTo(simScale(truth), 2);
      expect(simAngle(res.sim)).toBeCloseTo(simAngle(truth), 2);
      const probe = simApply(res.sim, 400, 300);
      const want = simApply(truth, 400, 300);
      expect(Math.hypot(probe.x - want.x, probe.y - want.y)).toBeLessThan(1);
    }
  });

  it('RANSAC gives up on pure noise', () => {
    const rand = rng(3);
    const src = Array.from({ length: 100 }, () => rand() * 500);
    const dst = Array.from({ length: 100 }, () => rand() * 500);
    expect(ransacSimilarity(src, dst, { minInliers: 12, rng: rand })).toBeNull();
  });
});

describe('homography', () => {
  it('maps the four points exactly and interpolates the plane', () => {
    const src: Pt[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const dst: Pt[] = [
      { x: 100, y: 120 },
      { x: 330, y: 90 },
      { x: 360, y: 340 },
      { x: 80, y: 310 },
    ];
    const H = homographyFrom4(src, dst)!;
    src.forEach((p, i) => {
      const q = applyHomography(H, p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
    // Straight lines stay straight: the midpoint of a diagonal lies on the image diagonal.
    const mid = applyHomography(H, 0.5, 0.5);
    const cross = (dst[2].x - dst[0].x) * (mid.y - dst[0].y) - (dst[2].y - dst[0].y) * (mid.x - dst[0].x);
    expect(Math.abs(cross)).toBeLessThan(1e-6 * 1e5);
  });
});

describe('largest common crop', () => {
  it('fits inside every warped frame and is close to the best possible', () => {
    const rand = rng(11);
    for (let trial = 0; trial < 25; trial++) {
      const polys: Pt[][] = [];
      for (let k = 0; k < 8; k++) {
        // Frames of 1600×900 whose subject point lands at the origin, slightly scaled and rotated.
        const s = 0.9 + rand() * 0.2;
        const ang = (rand() - 0.5) * 0.12;
        const subject = { x: 700 + rand() * 200, y: 400 + rand() * 100 };
        const toOrigin = simCompose(simFrom(s, ang), { a: 1, b: 0, tx: -subject.x, ty: -subject.y });
        polys.push(warpedOutline(toOrigin, 1600, 900));
      }
      const aspect = trial % 2 ? 16 / 9 : 9 / 16;
      const rect = largestCommonCrop(polys, { aspect, prefer: { x: 0, y: 0 }, centerTolerance: 1 })!;
      expect(rect).not.toBeNull();
      expect(rect.w / rect.h).toBeCloseTo(aspect, 6);
      for (const poly of polys)
        expect(rectInsidePolygon(rect, poly, 1e-6), `trial ${trial} ${JSON.stringify(rect)} ${JSON.stringify(poly)}`).toBe(true);
      // Brute force over centres: nothing much bigger fits.
      let bestH = 0;
      for (let cx = -600; cx <= 600; cx += 15) {
        for (let cy = -400; cy <= 400; cy += 15) {
          let lo = 0;
          let hi = 1000;
          for (let it = 0; it < 30; it++) {
            const h = (lo + hi) / 2;
            const r = { x: cx - h * aspect, y: cy - h, w: 2 * h * aspect, h: 2 * h };
            if (polys.every((p) => rectInsidePolygon(r, p, 1e-9))) lo = h;
            else hi = h;
          }
          bestH = Math.max(bestH, lo);
        }
      }
      expect(rect.h / 2).toBeGreaterThanOrEqual(bestH * 0.995);
    }
  });

  it('keeps the subject centred when that costs little', () => {
    const polys = [warpedOutline({ a: 1, b: 0, tx: -800, ty: -450 }, 1600, 900)];
    const rect = largestCommonCrop(polys, { aspect: 9 / 16, prefer: { x: 0, y: 0 } })!;
    expect(rect.x + rect.w / 2).toBeCloseTo(0, 6);
    expect(rect.y + rect.h / 2).toBeCloseTo(0, 6);
    expect(rect.h).toBeCloseTo(900, 3);
  });

  it('moves off-centre when centring would waste most of the frame', () => {
    // Subject near the left edge.
    const polys = [warpedOutline({ a: 1, b: 0, tx: -100, ty: -450 }, 1600, 900)];
    const rect = largestCommonCrop(polys, { aspect: 16 / 9, prefer: { x: 0, y: 0 }, centerTolerance: 0.9 })!;
    expect(rect.h).toBeGreaterThanOrEqual(0.9 * 900 - 1e-6);
    expect(rectInsidePolygon(rect, polys[0])).toBe(true);
  });
});
