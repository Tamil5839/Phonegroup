/**
 * Alignment: keep the subject in the same place, at the same size and level,
 * while the view sweeps around it.
 *
 * The host taps the subject in one frame. Walking outward from that frame,
 * each neighbouring pair's feature matches near the subject give a local
 * similarity transform (RANSAC), which carries the subject point to the next
 * frame and tells how much bigger/rotated the subject appears there. Every
 * frame then gets a transform into a shared "aligned space" in which the
 * subject sits at the origin, at the anchor frame's size, with the horizon
 * level (from the phones' tilt sensors when available, otherwise from the
 * feature chain). A common crop of that space becomes the output frame.
 */
import {
  largestCommonCrop,
  ransacSimilarity,
  simAngle,
  simApply,
  simCompose,
  simFrom,
  simScale,
  warpedOutline,
  type Pt,
  type Rect,
  type Sim,
} from './geometry';

export interface PairMatches {
  /** Points in frame i … */
  src: ArrayLike<number>;
  /** … and where they are in frame i + 1. */
  dst: ArrayLike<number>;
}

export interface FrameGeom {
  width: number;
  height: number;
  /** Device roll in degrees (clockwise positive), if the phone reported it. */
  roll?: number | null;
}

export type AlignConfidence = 'anchor' | 'good' | 'weak' | 'failed' | 'manual';

export interface FrameAlignment {
  /** Subject position in the frame (pixels). */
  point: Pt;
  /** Subject size relative to the anchor frame. */
  scale: number;
  /** Rotation (radians, clockwise positive) that levels this frame. */
  rotation: number;
  confidence: AlignConfidence;
  inliers: number;
}

export interface AlignOptions {
  /** Level with tilt sensors when every frame has a reading. */
  useSensorRoll?: boolean;
  /** Manually placed subject points (frame index → point). */
  manualPoints?: Record<number, Pt>;
  /** Inlier threshold in pixels (at the frames' resolution). */
  threshold?: number;
  rng?: () => number;
}

const MIN_LOCAL_INLIERS = 10;

/** Estimate how frame i maps onto frame i+1 around `near` (the subject). */
export function estimatePair(
  m: PairMatches,
  near: Pt,
  frame: FrameGeom,
  opts: AlignOptions = {},
): { sim: Sim; inliers: number; local: boolean } | null {
  const n = m.src.length / 2;
  if (n < 3) return null;
  const threshold = opts.threshold ?? Math.max(2, Math.min(frame.width, frame.height) * 0.006);
  // First try only matches near the subject: the background shifts differently (parallax).
  for (const radiusFrac of [0.22, 0.35]) {
    const radius = radiusFrac * Math.min(frame.width, frame.height);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.hypot(m.src[2 * i] - near.x, m.src[2 * i + 1] - near.y) <= radius) idx.push(i);
    }
    if (idx.length < MIN_LOCAL_INLIERS) continue;
    const src = new Float64Array(idx.length * 2);
    const dst = new Float64Array(idx.length * 2);
    idx.forEach((i, k) => {
      src[2 * k] = m.src[2 * i];
      src[2 * k + 1] = m.src[2 * i + 1];
      dst[2 * k] = m.dst[2 * i];
      dst[2 * k + 1] = m.dst[2 * i + 1];
    });
    const res = ransacSimilarity(src, dst, { threshold, minInliers: MIN_LOCAL_INLIERS, scaleRange: [0.5, 2], rng: opts.rng });
    if (res) return { sim: res.sim, inliers: res.count, local: true };
  }
  // Fall back to the whole frame, weighting matches by closeness to the subject.
  const sigma = 0.35 * Math.min(frame.width, frame.height);
  const weights = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d2 = (m.src[2 * i] - near.x) ** 2 + (m.src[2 * i + 1] - near.y) ** 2;
    weights[i] = Math.exp(-d2 / (2 * sigma * sigma));
  }
  const res = ransacSimilarity(m.src, m.dst, { threshold: threshold * 1.5, minInliers: 8, scaleRange: [0.5, 2], weights, rng: opts.rng });
  return res ? { sim: res.sim, inliers: res.count, local: false } : null;
}

/**
 * Propagate the subject from the anchor frame through the chain of
 * neighbouring pairs. `pairs[i]` holds matches between frame i and i + 1
 * (null if matching failed).
 */
export function alignChain(
  frames: readonly FrameGeom[],
  anchor: { index: number; point: Pt },
  pairs: readonly (PairMatches | null)[],
  opts: AlignOptions = {},
): FrameAlignment[] {
  const n = frames.length;
  const out: FrameAlignment[] = new Array(n);
  const featureRot = new Array<number>(n).fill(0);
  const manual = opts.manualPoints ?? {};
  out[anchor.index] = { point: anchor.point, scale: 1, rotation: 0, confidence: 'anchor', inliers: 0 };

  const step = (from: number, to: number) => {
    const prev = out[from];
    const pair = from < to ? pairs[from] : pairs[to];
    const matches = pair && (from < to ? pair : { src: pair.dst, dst: pair.src });
    const est = matches ? estimatePair(matches, prev.point, frames[from], opts) : null;
    let point: Pt;
    let scale = prev.scale;
    let confidence: AlignConfidence = 'failed';
    let inliers = 0;
    if (est) {
      point = simApply(est.sim, prev.point.x, prev.point.y);
      scale = prev.scale * simScale(est.sim);
      featureRot[to] = featureRot[from] + simAngle(est.sim);
      confidence = est.local && est.inliers >= 20 ? 'good' : 'weak';
      inliers = est.inliers;
    } else {
      // No usable matches: assume the subject sits at the same relative spot.
      const f0 = frames[from];
      const f1 = frames[to];
      point = { x: (prev.point.x / f0.width) * f1.width, y: (prev.point.y / f0.height) * f1.height };
      featureRot[to] = featureRot[from];
    }
    const pinned = manual[to];
    if (pinned) {
      point = pinned;
      confidence = 'manual';
    }
    // Reject implausible propagation (subject left the frame).
    const f = frames[to];
    if (point.x < 0 || point.y < 0 || point.x > f.width || point.y > f.height) {
      point = { x: Math.min(f.width, Math.max(0, point.x)), y: Math.min(f.height, Math.max(0, point.y)) };
      if (confidence !== 'manual') confidence = 'failed';
    }
    out[to] = { point, scale, rotation: 0, confidence, inliers };
  };

  for (let k = anchor.index + 1; k < n; k++) step(k - 1, k);
  for (let k = anchor.index - 1; k >= 0; k--) step(k + 1, k);

  const deg = Math.PI / 180;
  const sensors = opts.useSensorRoll !== false && frames.every((f) => typeof f.roll === 'number' && Number.isFinite(f.roll));
  for (let k = 0; k < n; k++) {
    // A device rolled clockwise by φ records content turned counter-clockwise: turn it back by +φ.
    out[k].rotation = sensors ? (frames[k].roll as number) * deg : -featureRot[k] + (frames[anchor.index].roll ?? 0) * deg;
  }
  return out;
}

/** Frame pixels → aligned space: subject at origin, anchor-frame size, level. */
export function toAlignedSpace(a: FrameAlignment): Sim {
  const toOrigin: Sim = { a: 1, b: 0, tx: -a.point.x, ty: -a.point.y };
  return simCompose(simFrom(1 / a.scale, a.rotation), toOrigin);
}

export type AspectChoice = '9:16' | '16:9';

export function aspectValue(a: AspectChoice): number {
  return a === '9:16' ? 9 / 16 : 16 / 9;
}

export interface OutputPlan {
  width: number;
  height: number;
  crop: Rect;
  /** Per frame: frame pixels → output pixels. */
  transforms: Sim[];
}

/** Even output size with the given long side and aspect. */
export function outputSize(aspect: AspectChoice, longSide = 1080): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return aspect === '9:16'
    ? { width: even((longSide * 9) / 16), height: longSide }
    : { width: longSide, height: even((longSide * 9) / 16) };
}

/**
 * Combine per-frame alignments (plus optional manual adjustments, given as
 * similarities in aligned space) into output transforms and one common crop.
 */
export function planOutput(
  frames: readonly FrameGeom[],
  alignments: readonly FrameAlignment[],
  aspect: AspectChoice,
  adjustments: readonly (Sim | null | undefined)[] = [],
  longSide = 1080,
): OutputPlan | null {
  const aligned = alignments.map((a, i) => {
    const base = toAlignedSpace(a);
    const adj = adjustments[i];
    return adj ? simCompose(adj, base) : base;
  });
  const outlines = aligned.map((s, i) => warpedOutline(s, frames[i].width, frames[i].height));
  const crop = largestCommonCrop(outlines, { aspect: aspectValue(aspect), prefer: { x: 0, y: 0 } });
  if (!crop) return null;
  const { width, height } = outputSize(aspect, longSide);
  const k = width / crop.w;
  const toOutput: Sim = { a: k, b: 0, tx: -crop.x * k, ty: -crop.y * k };
  return { width, height, crop, transforms: aligned.map((s) => simCompose(toOutput, s)) };
}

/** Without alignment: centre-crop every frame to the output aspect. */
export function planCenterCrop(frames: readonly FrameGeom[], aspect: AspectChoice, longSide = 1080): OutputPlan {
  const { width, height } = outputSize(aspect, longSide);
  const transforms = frames.map((f) => {
    const k = Math.max(width / f.width, height / f.height);
    return { a: k, b: 0, tx: (width - f.width * k) / 2, ty: (height - f.height * k) / 2 };
  });
  return { width, height, crop: { x: 0, y: 0, w: width, h: height }, transforms };
}
