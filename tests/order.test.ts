import { describe, expect, it } from 'vitest';
import { bestPath, orientLike, pathScore } from '../src/core/order';

function permutations(n: number): number[][] {
  if (n === 1) return [[0]];
  const out: number[][] = [];
  for (const p of permutations(n - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

describe('auto order', () => {
  it('finds the optimal path for small groups', () => {
    const rand = rng(1);
    for (let trial = 0; trial < 10; trial++) {
      const n = 6;
      const sim = Array.from({ length: n }, () => new Array(n).fill(0));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sim[i][j] = sim[j][i] = Math.round(rand() * 100);
      const best = Math.max(...permutations(n).map((p) => pathScore(p, sim)));
      expect(pathScore(bestPath(sim), sim)).toBe(best);
    }
  });

  it('recovers a shuffled arc from neighbour similarity (large groups)', () => {
    const rand = rng(5);
    for (const n of [8, 16, 24]) {
      const trueOrder = Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5);
      const posOf = new Map(trueOrder.map((phone, pos) => [phone, pos]));
      // Phones close together in the arc share more features.
      const sim = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 0 : Math.max(0, 200 - 60 * Math.abs(posOf.get(i)! - posOf.get(j)!)) + rand() * 5)),
      );
      const path = orientLike(bestPath(sim), trueOrder);
      expect(path).toEqual(trueOrder);
    }
  });

  it('keeps the current direction', () => {
    expect(orientLike([3, 2, 1, 0], [0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
    expect(orientLike([0, 1, 2, 3], [0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
  });
});
