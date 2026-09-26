/**
 * Time bases.
 *
 * Every device measures time as `performance.timeOrigin + performance.now()`:
 * milliseconds on a high-resolution monotonic clock, anchored near the Unix
 * epoch. The host's value of this clock is the reference ("host time").
 * Shooters estimate `offset` so that `hostTime ≈ localTime + offset`.
 */

/** A clock returning milliseconds. Injected everywhere so tests can simulate devices. */
export type Clock = () => number;

export const localNow: Clock = () => performance.timeOrigin + performance.now();

/** Convert a DOMHighResTimeStamp (rAF, rVFC, event.timeStamp) to the `localNow` base. */
export const perfToLocal = (t: number): number => performance.timeOrigin + t;

/** Convert a `localNow`-based time back to a DOMHighResTimeStamp. */
export const localToPerf = (t: number): number => t - performance.timeOrigin;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
