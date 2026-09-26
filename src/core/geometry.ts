/**
 * 2-D geometry for alignment: similarity transforms (shift + rotate + uniform
 * scale), robust estimation with RANSAC, homographies, and the "largest common
 * crop" solver.
 *
 * A similarity is stored as the complex-number map  z ↦ w·z + t  with
 * w = a + ib, t = tx + i·ty, i.e.
 *     x' = a·x − b·y + tx
 *     y' = b·x + a·y + ty
 * scale = |w|, angle = arg(w). In image coordinates (y down) a positive angle
 * turns content clockwise on screen.
 */

export interface Sim {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const SIM_IDENTITY: Sim = Object.freeze({ a: 1, b: 0, tx: 0, ty: 0 });

export function simFrom(scale: number, angle: number, tx = 0, ty = 0): Sim {
  return { a: scale * Math.cos(angle), b: scale * Math.sin(angle), tx, ty };
}

export function simApply(s: Sim, x: number, y: number): Pt {
  return { x: s.a * x - s.b * y + s.tx, y: s.b * x + s.a * y + s.ty };
}

/** p ∘ q : apply q first, then p. */
export function simCompose(p: Sim, q: Sim): Sim {
  return {
    a: p.a * q.a - p.b * q.b,
    b: p.a * q.b + p.b * q.a,
    tx: p.a * q.tx - p.b * q.ty + p.tx,
    ty: p.b * q.tx + p.a * q.ty + p.ty,
  };
}

export function simInvert(s: Sim): Sim {
  const d = s.a * s.a + s.b * s.b;
  const a = s.a / d;
  const b = -s.b / d;
  return { a, b, tx: -(a * s.tx - b * s.ty), ty: -(b * s.tx + a * s.ty) };
}

export const simScale = (s: Sim): number => Math.hypot(s.a, s.b);
export const simAngle = (s: Sim): number => Math.atan2(s.b, s.a);

/** Translate so that point p maps to the origin. */
export const simTranslate = (tx: number, ty: number): Sim => ({ a: 1, b: 0, tx, ty });

/**
 * Least-squares similarity mapping src[i] → dst[i] (Umeyama in complex form).
 * Points are flat arrays [x0, y0, x1, y1, …]. `use` optionally restricts to a subset.
 */
export function fitSimilarity(src: ArrayLike<number>, dst: ArrayLike<number>, use?: ArrayLike<number>): Sim | null {
  const n = use ? use.length : src.length / 2;
  if (n < 2) return null;
  let msx = 0,
    msy = 0,
    mdx = 0,
    mdy = 0;
  for (let k = 0; k < n; k++) {
    const i = use ? use[k] : k;
    msx += src[2 * i];
    msy += src[2 * i + 1];
    mdx += dst[2 * i];
    mdy += dst[2 * i + 1];
  }
  msx /= n;
  msy /= n;
  mdx /= n;
  mdy /= n;
  // w = Σ conj(zs)·zd / Σ |zs|²  (centred)
  let re = 0,
    im = 0,
    norm = 0;
  for (let k = 0; k < n; k++) {
    const i = use ? use[k] : k;
    const sx = src[2 * i] - msx;
    const sy = src[2 * i + 1] - msy;
    const dx = dst[2 * i] - mdx;
    const dy = dst[2 * i + 1] - mdy;
    re += sx * dx + sy * dy;
    im += sx * dy - sy * dx;
    norm += sx * sx + sy * sy;
  }
  if (norm < 1e-12) return null;
  const a = re / norm;
  const b = im / norm;
  return { a, b, tx: mdx - (a * msx - b * msy), ty: mdy - (b * msx + a * msy) };
}

export interface RansacOptions {
  /** Inlier distance in pixels. */
  threshold?: number;
  iterations?: number;
  minInliers?: number;
  /** Stop early once this probability of having found the best model is reached. */
  confidence?: number;
  /** Reject models with a scale outside this range (phones in an arc see similar sizes). */
  scaleRange?: [number, number];
  /** Optional per-match weights (e.g. closeness to the subject). */
  weights?: ArrayLike<number>;
  rng?: () => number;
}

export interface RansacResult {
  sim: Sim;
  inliers: Uint8Array;
  count: number;
  /** Root-mean-square residual over inliers (pixels). */
  rms: number;
}

export function ransacSimilarity(src: ArrayLike<number>, dst: ArrayLike<number>, opts: RansacOptions = {}): RansacResult | null {
  const n = src.length / 2;
  const { threshold = 3, iterations = 800, minInliers = 6, confidence = 0.999, scaleRange = [0.25, 4], weights, rng = Math.random } = opts;
  if (n < 2) return null;
  const thr2 = threshold * threshold;
  let bestScore = -1;
  let bestSim: Sim | null = null;
  let maxIter = iterations;

  const score = (s: Sim, mark?: Uint8Array): number => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const x = src[2 * i];
      const y = src[2 * i + 1];
      const ex = s.a * x - s.b * y + s.tx - dst[2 * i];
      const ey = s.b * x + s.a * y + s.ty - dst[2 * i + 1];
      if (ex * ex + ey * ey <= thr2) {
        total += weights ? weights[i] : 1;
        if (mark) mark[i] = 1;
      }
    }
    return total;
  };

  for (let it = 0; it < maxIter; it++) {
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * (n - 1));
    if (j >= i) j++;
    const sx = src[2 * j] - src[2 * i];
    const sy = src[2 * j + 1] - src[2 * i + 1];
    const d2 = sx * sx + sy * sy;
    if (d2 < 16) continue; // too close to define rotation/scale
    const dx = dst[2 * j] - dst[2 * i];
    const dy = dst[2 * j + 1] - dst[2 * i + 1];
    // w = (dst_j − dst_i) / (src_j − src_i)
    const a = (dx * sx + dy * sy) / d2;
    const b = (dy * sx - dx * sy) / d2;
    const sc = Math.hypot(a, b);
    if (sc < scaleRange[0] || sc > scaleRange[1]) continue;
    const s: Sim = {
      a,
      b,
      tx: dst[2 * i] - (a * src[2 * i] - b * src[2 * i + 1]),
      ty: dst[2 * i + 1] - (b * src[2 * i] + a * src[2 * i + 1]),
    };
    const sc2 = score(s);
    if (sc2 > bestScore) {
      bestScore = sc2;
      bestSim = s;
      // Adaptive iteration count (inlier ratio estimated by unweighted count).
      const ratio = countInliers(s, src, dst, thr2) / n;
      const denom = Math.log(1 - ratio * ratio);
      if (denom < 0) maxIter = Math.min(iterations, Math.max(50, Math.ceil(Math.log(1 - confidence) / denom)));
    }
  }
  if (!bestSim) return null;

  // Refine on inliers, twice (inlier set can grow after refinement).
  let sim = bestSim;
  let inliers = new Uint8Array(n);
  for (let pass = 0; pass < 3; pass++) {
    inliers = new Uint8Array(n);
    score(sim, inliers);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (inliers[i]) idx.push(i);
    if (idx.length < 2) break;
    const refined = fitSimilarity(src, dst, idx);
    if (!refined) break;
    sim = refined;
  }
  inliers = new Uint8Array(n);
  score(sim, inliers);
  let count = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    if (!inliers[i]) continue;
    count++;
    const p = simApply(sim, src[2 * i], src[2 * i + 1]);
    sq += (p.x - dst[2 * i]) ** 2 + (p.y - dst[2 * i + 1]) ** 2;
  }
  if (count < minInliers) return null;
  return { sim, inliers, count, rms: Math.sqrt(sq / count) };
}

function countInliers(s: Sim, src: ArrayLike<number>, dst: ArrayLike<number>, thr2: number): number {
  let c = 0;
  for (let i = 0; i < src.length / 2; i++) {
    const ex = s.a * src[2 * i] - s.b * src[2 * i + 1] + s.tx - dst[2 * i];
    const ey = s.b * src[2 * i] + s.a * src[2 * i + 1] + s.ty - dst[2 * i + 1];
    if (ex * ex + ey * ey <= thr2) c++;
  }
  return c;
}

/* ------------------------------------------------------------------ */
/* Homographies (used to read the sync-test time code off a photo)     */
/* ------------------------------------------------------------------ */

/** Row-major 3×3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Homography mapping the 4 `src` points to the 4 `dst` points (DLT with h33 = 1). */
export function homographyFrom4(src: readonly Pt[], dst: readonly Pt[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [];
  const bvec: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    bvec.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    bvec.push(v);
  }
  const h = solveLinear(A, bvec);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(H: Mat3, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

/** Gaussian elimination with partial pivoting. Returns null for singular systems. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/* ------------------------------------------------------------------ */
/* Largest common crop                                                 */
/* ------------------------------------------------------------------ */

interface HalfPlane {
  nx: number;
  ny: number;
  c: number;
  /** How much the constraint tightens per unit of rectangle half-height. */
  k: number;
}

function polygonArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/**
 * Half-planes n·p ≤ c describing where the centre of a rectangle with half-size
 * (aspect·h, h) may sit so that the whole rectangle stays inside `poly` (convex).
 */
function rectConstraints(polys: readonly Pt[][], aspect: number): HalfPlane[] {
  const out: HalfPlane[] = [];
  for (const raw of polys) {
    const poly = polygonArea(raw) < 0 ? [...raw].reverse() : raw;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      // Inside (left of the edge for a positively oriented polygon): ey·x − ex·y ≤ ey·p.x − ex·p.y
      const nx = ey;
      const ny = -ex;
      const len = Math.hypot(nx, ny);
      if (len < 1e-12) continue;
      out.push({ nx: nx / len, ny: ny / len, c: (nx * p.x + ny * p.y) / len, k: (Math.abs(nx) * aspect + Math.abs(ny)) / len });
    }
  }
  return out;
}

/** Clip a convex polygon by the half-plane n·p ≤ c. */
function clipPolygon(poly: Pt[], nx: number, ny: number, c: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = nx * p.x + ny * p.y - c;
    const dq = nx * q.x + ny * q.y - c;
    if (dp <= 0) out.push(p);
    if (dp <= 0 !== dq <= 0) {
      const t = dp / (dp - dq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

function feasibleCenters(cons: HalfPlane[], h: number, bound: number): Pt[] {
  let poly: Pt[] = [
    { x: -bound, y: -bound },
    { x: bound, y: -bound },
    { x: bound, y: bound },
    { x: -bound, y: bound },
  ];
  for (const hp of cons) {
    poly = clipPolygon(poly, hp.nx, hp.ny, hp.c - h * hp.k);
    if (poly.length === 0) return poly;
  }
  return poly;
}

function closestPointInPolygon(poly: Pt[], p: Pt): Pt {
  // A region that has shrunk to (almost) a point: its centroid is the answer.
  if (poly.length < 3 || Math.abs(polygonArea(poly)) < 1e-6) {
    const c = poly.reduce((s, q) => ({ x: s.x + q.x / poly.length, y: s.y + q.y / poly.length }), { x: 0, y: 0 });
    return poly.length ? c : p;
  }
  // Inside test (convex, any orientation).
  let sign = 0;
  let inside = true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) {
      inside = false;
      break;
    }
  }
  if (inside) return p;
  let best = poly[0];
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

export interface CropOptions {
  /** Width / height of the output. */
  aspect: number;
  /** Point to keep as central as possible (the subject). */
  prefer: Pt;
  /** Accept a crop this fraction as tall as the largest possible, if it keeps `prefer` centred. */
  centerTolerance?: number;
}

/**
 * Largest axis-aligned rectangle of the given aspect ratio that lies inside
 * every convex polygon (each warped frame outline). Among crops at least
 * `centerTolerance` × the optimum height, the one centred closest to `prefer`
 * wins, so the subject stays near the middle of the frame.
 */
export function largestCommonCrop(polys: readonly Pt[][], opts: CropOptions): Rect | null {
  const { aspect, prefer, centerTolerance = 0.9 } = opts;
  if (polys.length === 0 || !(aspect > 0)) return null;
  const cons = rectConstraints(polys, aspect);
  let bound = 1;
  for (const poly of polys) for (const p of poly) bound = Math.max(bound, Math.abs(p.x) * 2, Math.abs(p.y) * 2);

  // Height of the best crop centred exactly on `prefer` (closed form).
  let hCentered = Infinity;
  for (const hp of cons) hCentered = Math.min(hCentered, (hp.c - (hp.nx * prefer.x + hp.ny * prefer.y)) / hp.k);

  // Largest feasible height anywhere (bisection on a 3-variable LP).
  let lo = 0;
  let hi = bound;
  if (feasibleCenters(cons, 0, bound).length === 0) return null;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (feasibleCenters(cons, mid, bound).length > 0) lo = mid;
    else hi = mid;
  }
  const hMax = lo;
  if (hMax <= 0) return null;

  let h: number;
  let center: Pt;
  if (hCentered >= centerTolerance * hMax) {
    h = hCentered;
    center = prefer;
  } else {
    h = centerTolerance * hMax;
    const region = feasibleCenters(cons, h, bound);
    center = region.length ? closestPointInPolygon(region, prefer) : prefer;
  }
  const w = h * aspect;
  return { x: center.x - w, y: center.y - h, w: 2 * w, h: 2 * h };
}

/** Is `r` inside convex polygon `poly` (with tolerance)? Used by tests and debug checks. */
export function rectInsidePolygon(r: Rect, poly: readonly Pt[], eps = 1e-6): boolean {
  const pts = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  const oriented = polygonArea(poly) < 0 ? [...poly].reverse() : poly;
  return pts.every((p) =>
    oriented.every((a, i) => {
      const b = oriented[(i + 1) % oriented.length];
      return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -eps * Math.hypot(b.x - a.x, b.y - a.y);
    }),
  );
}

/** Outline of a w×h frame after mapping through `s`. */
export function warpedOutline(s: Sim, w: number, h: number): Pt[] {
  return [simApply(s, 0, 0), simApply(s, w, 0), simApply(s, w, h), simApply(s, 0, h)];
}
