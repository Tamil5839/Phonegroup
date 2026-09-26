/**
 * ORB feature detection and matching with OpenCV.js. Takes the `cv` module as
 * a parameter so it runs the same in the alignment worker and in Node tests.
 */

export interface GrayImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface FeatureSet {
  /** x0, y0, x1, y1, … in the image's pixel coordinates. */
  points: Float32Array;
  /** 32 bytes per keypoint. */
  descriptors: Uint8Array;
  count: number;
}

export interface MatchSet {
  /** Matched points in the first image. */
  src: Float32Array;
  /** Corresponding points in the second image. */
  dst: Float32Array;
  count: number;
}

// OpenCV.js has no TypeScript types worth using here.
type CV = any;

export function detectOrb(cv: CV, img: GrayImage, nfeatures = 2000): FeatureSet {
  const mat = new cv.Mat(img.height, img.width, cv.CV_8UC1);
  mat.data.set(img.data);
  const orb = new cv.ORB(nfeatures);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  const mask = new cv.Mat();
  try {
    orb.detectAndCompute(mat, mask, keypoints, descriptors);
    const count = Math.min(keypoints.size(), descriptors.rows);
    const points = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const kp = keypoints.get(i);
      points[2 * i] = kp.pt.x;
      points[2 * i + 1] = kp.pt.y;
    }
    const desc = new Uint8Array(count * 32);
    if (count > 0) desc.set(descriptors.data.subarray(0, count * 32));
    return { points, descriptors: desc, count };
  } finally {
    mat.delete();
    orb.delete();
    keypoints.delete();
    descriptors.delete();
    mask.delete();
  }
}

/**
 * Match descriptors with a ratio test (Lowe) and a mutual-best check, which
 * together remove most wrong matches before RANSAC.
 */
export function matchFeatures(cv: CV, a: FeatureSet, b: FeatureSet, ratio = 0.8): MatchSet {
  if (a.count < 2 || b.count < 2) return { src: new Float32Array(0), dst: new Float32Array(0), count: 0 };
  const da = new cv.Mat(a.count, 32, cv.CV_8UC1);
  da.data.set(a.descriptors);
  const db = new cv.Mat(b.count, 32, cv.CV_8UC1);
  db.data.set(b.descriptors);
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const forward = new cv.DMatchVectorVector();
  const backward = new cv.DMatchVectorVector();
  try {
    matcher.knnMatch(da, db, forward, 2);
    matcher.knnMatch(db, da, backward, 1);
    const bestBack = new Int32Array(b.count).fill(-1);
    for (let j = 0; j < backward.size(); j++) {
      const m = backward.get(j);
      if (m.size() > 0) bestBack[m.get(0).queryIdx] = m.get(0).trainIdx;
    }
    const src: number[] = [];
    const dst: number[] = [];
    for (let i = 0; i < forward.size(); i++) {
      const m = forward.get(i);
      if (m.size() < 2) continue;
      const m0 = m.get(0);
      const m1 = m.get(1);
      if (m0.distance >= ratio * m1.distance) continue;
      if (bestBack[m0.trainIdx] !== m0.queryIdx) continue;
      src.push(a.points[2 * m0.queryIdx], a.points[2 * m0.queryIdx + 1]);
      dst.push(b.points[2 * m0.trainIdx], b.points[2 * m0.trainIdx + 1]);
    }
    return { src: Float32Array.from(src), dst: Float32Array.from(dst), count: src.length / 2 };
  } finally {
    da.delete();
    db.delete();
    matcher.delete();
    forward.delete();
    backward.delete();
  }
}

/** RGBA → grey (BT.709 luma), optionally downscaled by an integer step. */
export function toGray(rgba: ArrayLike<number>, width: number, height: number): GrayImage {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) | 0;
  }
  return { data: out, width, height };
}
