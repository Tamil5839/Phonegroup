/**
 * Frame bookkeeping for the rolling capture buffer: a fixed-size ring, and
 * the selection of the frame closest to the moment T plus its neighbours.
 */
import { median } from './time';

/** Fixed-capacity FIFO. Pushing into a full ring evicts (and returns) the oldest item. */
export class Ring<T> {
  private items: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!(capacity > 0)) throw new Error('capacity must be positive');
    this.items = new Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(item: T): T | undefined {
    if (this.count < this.capacity) {
      this.items[(this.start + this.count) % this.capacity] = item;
      this.count++;
      return undefined;
    }
    const evicted = this.items[this.start];
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
    return evicted;
  }

  /** 0 is the oldest item. */
  at(i: number): T | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.items[(this.start + i) % this.capacity];
  }

  newest(): T | undefined {
    return this.at(this.count - 1);
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }

  /** Remove and return the oldest item. */
  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const oldest = this.items[this.start];
    this.items[this.start] = undefined;
    this.start = (this.start + 1) % this.capacity;
    this.count--;
    return oldest;
  }

  /** Remove items from the oldest end while `pred` holds; returns them. */
  dropWhile(pred: (item: T) => boolean): T[] {
    const dropped: T[] = [];
    while (this.count > 0) {
      const oldest = this.items[this.start] as T;
      if (!pred(oldest)) break;
      dropped.push(oldest);
      this.items[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.count--;
    }
    return dropped;
  }

  clear(): T[] {
    const all = this.toArray();
    this.items = new Array(this.capacity);
    this.start = 0;
    this.count = 0;
    return all;
  }
}

export interface Stamped {
  /** Best estimate of when the frame was captured, in host time. */
  hostTime: number;
}

/** Index of the frame whose timestamp is closest to `target` (earlier frame wins ties). */
export function closestIndex(frames: readonly Stamped[], target: number): number {
  let best = -1;
  let bestErr = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const err = Math.abs(frames[i].hostTime - target);
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}

export interface Selection {
  /** Index into the frame list of the chosen frame. */
  chosen: number;
  /** Indices of neighbours, oldest first, not including `chosen`. */
  neighbors: number[];
  /** Offsets (−n…n, 0 excluded) of each neighbour relative to the chosen frame. */
  neighborOffsets: number[];
  /** chosen frame time − target, in ms. */
  errorMs: number;
}

/**
 * Pick the frame closest to `target` plus up to `n` frames on each side.
 * Frames must be sorted by time (the ring buffer guarantees this).
 */
export function selectAround(frames: readonly Stamped[], target: number, n = 3): Selection | null {
  const chosen = closestIndex(frames, target);
  if (chosen < 0) return null;
  const neighbors: number[] = [];
  const neighborOffsets: number[] = [];
  for (let d = -n; d <= n; d++) {
    const i = chosen + d;
    if (d === 0 || i < 0 || i >= frames.length) continue;
    neighbors.push(i);
    neighborOffsets.push(d);
  }
  return { chosen, neighbors, neighborOffsets, errorMs: frames[chosen].hostTime - target };
}

/** Median spacing between consecutive frames (ms), or `fallback` if unknown. */
export function frameInterval(frames: readonly Stamped[], fallback = 1000 / 30): number {
  if (frames.length < 2) return fallback;
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i].hostTime - frames[i - 1].hostTime;
    if (d > 0) deltas.push(d);
  }
  const m = median(deltas);
  return Number.isFinite(m) && m > 0 ? m : fallback;
}

/**
 * When it is safe to pick: after T plus enough frames to fill the neighbours
 * on the "after" side, plus a small margin for late frame callbacks.
 */
export function pickDeadline(target: number, intervalMs: number, neighbors = 3, marginMs = 60): number {
  return target + (neighbors + 0.5) * intervalMs + marginMs;
}

/** Spread (max − min) of timing errors, ignoring missing values. */
export function errorSpread(errors: readonly (number | null | undefined)[]): number {
  const vals = errors.filter((e): e is number => typeof e === 'number' && Number.isFinite(e));
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}
