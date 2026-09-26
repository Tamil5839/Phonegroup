import { describe, expect, it } from 'vitest';
import { closestIndex, errorSpread, frameInterval, pickDeadline, Ring, selectAround } from '../src/core/frames';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

describe('Ring', () => {
  it('evicts the oldest item when full', () => {
    const r = new Ring<number>(3);
    expect(r.push(1)).toBeUndefined();
    r.push(2);
    r.push(3);
    expect(r.push(4)).toBe(1);
    expect(r.toArray()).toEqual([2, 3, 4]);
    expect(r.at(0)).toBe(2);
    expect(r.newest()).toBe(4);
  });

  it('drops old items by predicate', () => {
    const r = new Ring<number>(5);
    [1, 2, 3, 4, 5].forEach((v) => r.push(v));
    expect(r.dropWhile((v) => v < 3)).toEqual([1, 2]);
    expect(r.toArray()).toEqual([3, 4, 5]);
    r.push(6);
    r.push(7);
    r.push(8);
    expect(r.toArray()).toEqual([4, 5, 6, 7, 8]);
  });
});

describe('frame selection', () => {
  it('always picks the frame closest to T (randomised, with jitter and drops)', () => {
    const rand = rng(1234);
    for (let trial = 0; trial < 2000; trial++) {
      const fps = [24, 30, 60][trial % 3];
      const interval = 1000 / fps;
      const frames: { hostTime: number }[] = [];
      let t = 10_000 + rand() * 50;
      for (let i = 0; i < 45; i++) {
        if (rand() > 0.08) frames.push({ hostTime: t + (rand() - 0.5) * 4 }); // jitter, some dropped frames
        t += interval;
      }
      frames.sort((a, b) => a.hostTime - b.hostTime);
      const target = frames[0].hostTime + rand() * (frames[frames.length - 1].hostTime - frames[0].hostTime);
      const brute = frames.reduce((best, f, i) => (Math.abs(f.hostTime - target) < Math.abs(frames[best].hostTime - target) ? i : best), 0);
      expect(closestIndex(frames, target)).toBe(brute);
      const sel = selectAround(frames, target, 3)!;
      expect(sel.chosen).toBe(brute);
      expect(sel.errorMs).toBeCloseTo(frames[brute].hostTime - target, 9);
      // Neighbours are contiguous around the choice and never include it.
      expect(sel.neighbors).not.toContain(sel.chosen);
      sel.neighbors.forEach((n, k) => expect(n - sel.chosen).toBe(sel.neighborOffsets[k]));
      expect(sel.neighborOffsets.every((o) => Math.abs(o) <= 3 && o !== 0)).toBe(true);
    }
  });

  it('keeps the error within half a frame when frames are regular', () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({ hostTime: 1000 + i * 33.3 }));
    for (let target = 1100; target < 2100; target += 7.7) {
      const sel = selectAround(frames, target)!;
      expect(Math.abs(sel.errorMs)).toBeLessThanOrEqual(33.3 / 2 + 1e-9);
    }
  });

  it('returns fewer neighbours at the edges of the buffer', () => {
    const frames = Array.from({ length: 5 }, (_, i) => ({ hostTime: i * 33 }));
    const sel = selectAround(frames, 1, 3)!;
    expect(sel.chosen).toBe(0);
    expect(sel.neighborOffsets).toEqual([1, 2, 3]);
  });

  it('handles an empty buffer', () => {
    expect(selectAround([], 100)).toBeNull();
  });

  it('estimates frame interval and pick deadline', () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({ hostTime: i * 33.4 }));
    expect(frameInterval(frames)).toBeCloseTo(33.4, 6);
    expect(pickDeadline(1000, 33.4, 3, 60)).toBeCloseTo(1000 + 3.5 * 33.4 + 60, 6);
    expect(errorSpread([3, -5, null, 12])).toBe(17);
  });
});
