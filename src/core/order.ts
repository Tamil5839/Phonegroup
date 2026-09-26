/**
 * "Auto order": given how similar every pair of frames looks (e.g. number of
 * matched features), find the left-to-right order whose neighbours are most
 * similar — an open travelling-salesman path. Exact for small groups, greedy
 * plus 2-opt beyond that.
 */

export function pathScore(order: readonly number[], sim: readonly (readonly number[])[]): number {
  let s = 0;
  for (let i = 1; i < order.length; i++) s += sim[order[i - 1]][order[i]];
  return s;
}

export function bestPath(sim: readonly (readonly number[])[]): number[] {
  const n = sim.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  return n <= 10 ? exactPath(sim) : heuristicPath(sim);
}

/** Held–Karp dynamic programme over subsets (maximising similarity). */
function exactPath(sim: readonly (readonly number[])[]): number[] {
  const n = sim.length;
  const full = 1 << n;
  const dp = new Float64Array(full * n).fill(-Infinity);
  const parent = new Int32Array(full * n).fill(-1);
  for (let i = 0; i < n; i++) dp[(1 << i) * n + i] = 0;
  for (let mask = 1; mask < full; mask++) {
    for (let last = 0; last < n; last++) {
      const cur = dp[mask * n + last];
      if (cur === -Infinity || !(mask & (1 << last))) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nm = mask | (1 << next);
        const v = cur + sim[last][next];
        if (v > dp[nm * n + next]) {
          dp[nm * n + next] = v;
          parent[nm * n + next] = last;
        }
      }
    }
  }
  let bestLast = 0;
  for (let i = 1; i < n; i++) if (dp[(full - 1) * n + i] > dp[(full - 1) * n + bestLast]) bestLast = i;
  const order: number[] = [];
  let mask = full - 1;
  let cur = bestLast;
  while (cur !== -1) {
    order.push(cur);
    const p = parent[mask * n + cur];
    mask &= ~(1 << cur);
    cur = p;
  }
  return order.reverse();
}

function heuristicPath(sim: readonly (readonly number[])[]): number[] {
  const n = sim.length;
  let best: number[] = [];
  let bestScore = -Infinity;
  for (let start = 0; start < n; start++) {
    const used = new Array(n).fill(false);
    const order = [start];
    used[start] = true;
    for (let k = 1; k < n; k++) {
      const last = order[order.length - 1];
      let pick = -1;
      for (let j = 0; j < n; j++) if (!used[j] && (pick < 0 || sim[last][j] > sim[last][pick])) pick = j;
      used[pick] = true;
      order.push(pick);
    }
    twoOpt(order, sim);
    const s = pathScore(order, sim);
    if (s > bestScore) {
      bestScore = s;
      best = order;
    }
  }
  return best;
}

/** Reverse segments while that increases the total similarity. */
function twoOpt(order: number[], sim: readonly (readonly number[])[]): void {
  const n = order.length;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // Reversing order[i..j] changes the edges (i−1,i) and (j,j+1).
        const before =
          (i > 0 ? sim[order[i - 1]][order[i]] : 0) + (j < n - 1 ? sim[order[j]][order[j + 1]] : 0);
        const after =
          (i > 0 ? sim[order[i - 1]][order[j]] : 0) + (j < n - 1 ? sim[order[i]][order[j + 1]] : 0);
        if (after > before + 1e-9) {
          for (let a = i, b = j; a < b; a++, b--) [order[a], order[b]] = [order[b], order[a]];
          improved = true;
        }
      }
    }
  }
}

/**
 * A path and its reverse are equally good; pick the direction that agrees
 * best with the current order (so "auto order" doesn't flip left and right).
 */
export function orientLike(path: number[], current: readonly number[]): number[] {
  const pos = new Map(current.map((v, i) => [v, i]));
  let agree = 0;
  for (let i = 1; i < path.length; i++) {
    const a = pos.get(path[i - 1]);
    const b = pos.get(path[i]);
    if (a !== undefined && b !== undefined) agree += Math.sign(b - a);
  }
  return agree < 0 ? [...path].reverse() : path;
}
