/**
 * Machine-readable time code for Sync Test Mode and optical sync.
 *
 * The host screen shows a static QR code (easy to find in a photo, gives us
 * the screen's position and perspective) and, below it, two rows of cells:
 * a black and a white reference cell followed by a 12-bit Gray-coded counter
 * that advances every display refresh. A camera exposure that spans two
 * refreshes blends two codes; with Gray code only one bit differs between
 * neighbouring counts, so the blend shows up as a single grey cell, and its
 * greyness tells us how far into the switch the exposure was.
 */
import { applyHomography, homographyFrom4, type Mat3, type Pt, type Rect } from './geometry';

export const TC_BITS = 12;
export const TC_MOD = 1 << TC_BITS;
export const TC_COLS = 7;
export const TC_ROWS = 2;
export const TC_CELLS = 2 + TC_BITS;
/** Gap between the bottom of the QR symbol and the first cell row, in QR widths. */
export const TC_GAP = 0.1;
const CELL = 1 / TC_COLS;

export function toGray(n: number): number {
  return (n ^ (n >>> 1)) >>> 0;
}

export function fromGray(g: number): number {
  let n = g >>> 0;
  for (let s = 1; s < 32; s <<= 1) n ^= n >>> s;
  return n >>> 0;
}

/** Cell rectangle in "QR units": the QR symbol spans [0,1]×[0,1]. */
export function cellRect(i: number): Rect {
  const row = Math.floor(i / TC_COLS);
  const col = i % TC_COLS;
  return { x: col * CELL, y: 1 + TC_GAP + row * CELL, w: CELL, h: CELL };
}

/** Total height of the pattern (QR + cells) in QR units. */
export const TC_PATTERN_HEIGHT = 1 + TC_GAP + TC_ROWS * CELL;

/** Colour of each cell for a counter value: true = white. */
export function cellColors(counter: number): boolean[] {
  const g = toGray(((counter % TC_MOD) + TC_MOD) % TC_MOD);
  const out = [false, true];
  for (let k = TC_BITS - 1; k >= 0; k--) out.push(((g >>> k) & 1) === 1);
  return out;
}

export interface TimecodeRead {
  /** Counter value of the earlier of the (possibly) two blended codes. */
  counter: number;
  /** Fraction (0–1) of the exposure that saw `counter + 1`. */
  frac: number;
  /** Number of undecided cells (0 or 1 for a valid read). */
  ambiguous: number;
  /** White − black reference, 0–255. */
  contrast: number;
}

/** Decide bits from mean luminance per cell (index order as in cellColors). */
export function decodeCells(lum: readonly number[], margin = 0.22): TimecodeRead | null {
  if (lum.length !== TC_CELLS) return null;
  const black = lum[0];
  const white = lum[1];
  const contrast = white - black;
  if (contrast < 25) return null;
  let g = 0;
  const unsure: { bit: number; t: number }[] = [];
  for (let k = 0; k < TC_BITS; k++) {
    const bit = TC_BITS - 1 - k;
    const t = (lum[2 + k] - black) / contrast;
    if (Math.abs(t - 0.5) < margin) unsure.push({ bit, t: Math.min(1, Math.max(0, t)) });
    if (t > 0.5) g |= 1 << bit;
  }
  if (unsure.length === 0) return { counter: fromGray(g), frac: 0, ambiguous: 0, contrast };
  if (unsure.length > 1) return null;
  const { bit, t } = unsure[0];
  const c0 = fromGray(g & ~(1 << bit));
  const c1 = fromGray(g | (1 << bit));
  let lo: number;
  let hiHasBitSet: boolean;
  if ((c0 + 1) % TC_MOD === c1) {
    lo = c0;
    hiHasBitSet = true;
  } else if ((c1 + 1) % TC_MOD === c0) {
    lo = c1;
    hiHasBitSet = false;
  } else {
    return null; // not two neighbouring codes: a misread
  }
  const frac = hiHasBitSet ? t : 1 - t;
  return { counter: lo, frac, ambiguous: 1, contrast };
}

export interface LumaImage {
  width: number;
  height: number;
  /** RGBA bytes (ImageData layout). */
  data: ArrayLike<number>;
}

function lumaAt(img: LumaImage, x: number, y: number): number {
  const xi = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const p = (yi * img.width + xi) * 4;
  return 0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2];
}

/** Homography from QR units to image pixels, given the QR corners found in the photo. */
export function qrHomography(corners: { topLeft: Pt; topRight: Pt; bottomRight: Pt; bottomLeft: Pt }): Mat3 | null {
  return homographyFrom4(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft],
  );
}

/** Mean luminance of the central part of every cell. */
export function sampleCells(img: LumaImage, H: Mat3, inset = 0.3, grid = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i < TC_CELLS; i++) {
    const r = cellRect(i);
    let s = 0;
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const u = r.x + r.w * (inset + ((1 - 2 * inset) * (gx + 0.5)) / grid);
        const v = r.y + r.h * (inset + ((1 - 2 * inset) * (gy + 0.5)) / grid);
        const p = applyHomography(H, u, v);
        s += lumaAt(img, p.x, p.y);
      }
    }
    out.push(s / (grid * grid));
  }
  return out;
}

/**
 * Host-side record of when each counter value was drawn, used to turn a
 * decoded counter back into host time.
 */
export class TimecodeLog {
  private readonly times = new Float64Array(TC_MOD).fill(NaN);
  private last = -1;

  record(counter: number, hostTime: number): void {
    this.times[counter % TC_MOD] = hostTime;
    this.last = counter;
  }

  get lastCounter(): number {
    return this.last;
  }

  /**
   * Host time at the middle of the exposure described by `read`. We assume the
   * exposure is about one refresh long, so a clean read means "middle of that
   * refresh" and a blended read slides towards the next one.
   */
  timeOf(read: TimecodeRead): number | null {
    const t0 = this.times[read.counter % TC_MOD];
    const t1 = this.times[(read.counter + 1) % TC_MOD];
    if (!Number.isFinite(t0)) return null;
    const period = Number.isFinite(t1) && t1 > t0 && t1 - t0 < 100 ? t1 - t0 : 1000 / 60;
    return t0 + (0.5 + read.frac) * period;
  }
}
