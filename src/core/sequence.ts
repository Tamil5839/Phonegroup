/**
 * Clip timelines: which frame shows when, for each clip style.
 *
 *  - sweep:      left → right → left (ping-pong) with short holds at the ends
 *  - sweep-life: a sweep that ends on the "hero" phone, whose neighbour frames
 *                then play forward so the frozen moment briefly unfreezes
 *  - loop:       ping-pong without repeated end frames, so it loops seamlessly
 *
 * Each style repeats its basic cycle as many times as brings the clip closest
 * to the requested length while staying inside 3–6 s where possible.
 */
import { clamp } from './time';

export type ClipStyle = 'sweep' | 'sweep-life' | 'loop';

export const CLIP_STYLES: { id: ClipStyle; label: string; hint: string }[] = [
  { id: 'sweep', label: 'Sweep', hint: 'Left to right and back' },
  { id: 'sweep-life', label: 'Sweep + Life', hint: 'Sweep, then the moment unfreezes' },
  { id: 'loop', label: 'Loop', hint: 'Seamless loop for sharing' },
];

export interface TimelineFrame {
  /** Index into the ordered list of frames. */
  frame: number;
  /** Neighbour offset in capture frames (0 = the frozen moment itself). */
  sub: number;
  /** How long this frame stays on screen. */
  ms: number;
}

export interface TimelineOptions {
  style: ClipStyle;
  count: number;
  /** Sweep speed, 12–18 frames per second. */
  fps: number;
  /** Target clip length, 3–6 s. */
  targetMs?: number;
  /** Hold at each end of a sweep. */
  holdMs?: number;
  /** Frame whose neighbours "come alive" in sweep-life. */
  heroIndex?: number;
  /** Forward neighbour offsets available for the hero (e.g. [1, 2, 3]). */
  heroForward?: number[];
  /** Playback rate of the live part (capture rate is ~30 fps; a bit slower reads better). */
  lifeFps?: number;
}

export const MIN_CLIP_MS = 3000;
export const MAX_CLIP_MS = 6000;
const LIFE_END_HOLD_MS = 700;

export function buildTimeline(opts: TimelineOptions): TimelineFrame[] {
  const n = Math.max(0, Math.floor(opts.count));
  if (n === 0) return [];
  const target = clamp(opts.targetMs ?? 4000, MIN_CLIP_MS, MAX_CLIP_MS);
  const build = (reps: number) => mergeRepeats(buildWithRepeats(opts, n, reps));
  if (n === 1) return build(0);

  // Pick the repeat count whose length is closest to the target within 3–6 s,
  // or failing that the one closest to the allowed range.
  let best: TimelineFrame[] = build(0);
  let bestScore = Infinity;
  for (let reps = 0; reps < 60; reps++) {
    const tl = build(reps);
    const d = timelineDuration(tl);
    const outside = d < MIN_CLIP_MS ? MIN_CLIP_MS - d : d > MAX_CLIP_MS ? d - MAX_CLIP_MS : 0;
    const score = outside * 10 + Math.abs(d - target);
    if (score < bestScore) {
      best = tl;
      bestScore = score;
    }
    if (d > MAX_CLIP_MS + 2000) break;
  }
  return stretchToMinimum(best);
}

function buildWithRepeats(opts: TimelineOptions, n: number, reps: number): TimelineFrame[] {
  const step = 1000 / clamp(opts.fps, 6, 30);
  const hold = opts.holdMs ?? 280;
  const out: TimelineFrame[] = [];
  if (n === 1) {
    out.push({ frame: 0, sub: 0, ms: MIN_CLIP_MS });
    if (opts.style === 'sweep-life') appendLife(out, 0, opts);
    return out;
  }
  const forward = range(0, n - 1);
  const backward = range(n - 1, 0);

  switch (opts.style) {
    case 'loop': {
      // 0 … n−1, n−2 … 1  → wraps back to 0 with an ordinary step.
      const cycle = [...forward, ...backward.slice(1, -1)];
      for (let c = 0; c <= reps; c++) for (const f of cycle) out.push({ frame: f, sub: 0, ms: step });
      return out;
    }
    case 'sweep': {
      // Each cycle: 0 (hold) → n−1 (hold) → 0 (hold).
      for (let c = 0; c <= reps; c++) {
        pushRun(out, c === 0 ? forward : forward.slice(1), step, c === 0 ? hold : step, hold);
        pushRun(out, backward.slice(1), step, step, hold);
      }
      return out;
    }
    case 'sweep-life': {
      const hero = clamp(Math.round(opts.heroIndex ?? Math.floor((n - 1) / 2)), 0, n - 1);
      // `reps` extra there-and-back sweeps, then a final sweep that ends on the hero.
      for (let c = 0; c < reps; c++) {
        pushRun(out, c === 0 ? forward : forward.slice(1), step, c === 0 ? hold : step, hold);
        pushRun(out, backward.slice(1), step, step, hold);
      }
      pushRun(out, reps === 0 ? forward : forward.slice(1), step, reps === 0 ? hold : step, hold);
      const toHero = hero === n - 1 ? [] : range(n - 2, hero);
      for (const f of toHero) out.push({ frame: f, sub: 0, ms: step });
      out[out.length - 1].ms = Math.max(out[out.length - 1].ms, hold);
      appendLife(out, hero, opts);
      return out;
    }
  }
}

function appendLife(out: TimelineFrame[], hero: number, opts: TimelineOptions): void {
  const forwardSubs = (opts.heroForward ?? [1, 2, 3]).filter((s) => s > 0).sort((a, b) => a - b);
  const lifeStep = 1000 / clamp(opts.lifeFps ?? 12, 4, 60);
  for (const sub of forwardSubs) out.push({ frame: hero, sub, ms: lifeStep });
  out[out.length - 1].ms += LIFE_END_HOLD_MS;
}

function pushRun(out: TimelineFrame[], frames: number[], step: number, firstMs: number, lastMs: number) {
  frames.forEach((f, i) => {
    let ms = step;
    if (i === 0) ms = Math.max(ms, firstMs);
    if (i === frames.length - 1) ms = Math.max(ms, lastMs);
    out.push({ frame: f, sub: 0, ms });
  });
}

/** If the best option is still too short (few phones, fast sweep), lengthen every frame evenly. */
function stretchToMinimum(tl: TimelineFrame[]): TimelineFrame[] {
  const d = timelineDuration(tl);
  if (d >= MIN_CLIP_MS || d === 0) return tl;
  const k = MIN_CLIP_MS / d;
  return tl.map((f) => ({ ...f, ms: f.ms * k }));
}

/** Collapse consecutive identical entries into one longer entry. */
function mergeRepeats(tl: TimelineFrame[]): TimelineFrame[] {
  const out: TimelineFrame[] = [];
  for (const f of tl) {
    const last = out[out.length - 1];
    if (last && last.frame === f.frame && last.sub === f.sub) last.ms += f.ms;
    else out.push({ ...f });
  }
  return out;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  if (from <= to) for (let i = from; i <= to; i++) out.push(i);
  else for (let i = from; i >= to; i--) out.push(i);
  return out;
}

export function timelineDuration(tl: readonly TimelineFrame[]): number {
  return tl.reduce((s, f) => s + f.ms, 0);
}

/** Frame visible at time `t` (ms) of a timeline, looping. */
export function frameAt(tl: readonly TimelineFrame[], t: number): TimelineFrame | null {
  const total = timelineDuration(tl);
  if (total <= 0) return null;
  let rem = ((t % total) + total) % total;
  for (const f of tl) {
    if (rem < f.ms) return f;
    rem -= f.ms;
  }
  return tl[tl.length - 1];
}
