import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';
import { applyHomography, homographyFrom4, type Mat3, type Pt } from '../src/core/geometry';
import {
  cellColors,
  cellRect,
  decodeCells,
  fromGray,
  qrHomography,
  sampleCells,
  TC_BITS,
  TC_CELLS,
  TC_MOD,
  TC_PATTERN_HEIGHT,
  TimecodeLog,
  toGray,
} from '../src/core/timecode';

describe('Gray code', () => {
  it('round-trips and changes one bit per step', () => {
    for (let n = 0; n < TC_MOD; n++) {
      expect(fromGray(toGray(n))).toBe(n);
      const diff = toGray(n) ^ toGray((n + 1) % TC_MOD);
      expect(diff & (diff - 1)).toBe(0); // exactly one bit
    }
  });
});

describe('cell decoding', () => {
  const lum = (counter: number) => cellColors(counter).map((w): number => (w ? 230 : 20));

  it('reads clean codes', () => {
    for (const c of [0, 1, 1234, TC_MOD - 1]) {
      expect(decodeCells(lum(c))).toMatchObject({ counter: c, frac: 0, ambiguous: 0 });
    }
  });

  it('reads a blend of two neighbouring codes and how far the switch was', () => {
    for (const c of [5, 1023, TC_MOD - 1]) {
      const a = lum(c);
      const b = lum((c + 1) % TC_MOD);
      for (const f of [0.35, 0.5, 0.62]) {
        const mixed = a.map((v, i) => v * (1 - f) + b[i] * f);
        const read = decodeCells(mixed)!;
        expect(read.counter).toBe(c);
        expect(read.frac).toBeCloseTo(f, 6);
      }
    }
  });

  it('rejects unreadable input', () => {
    expect(decodeCells(new Array(TC_CELLS).fill(128))).toBeNull(); // no contrast
    const a = lum(10);
    a[5] = 125;
    a[9] = 125; // two undecided cells
    expect(decodeCells(a)).toBeNull();
  });
});

/** Render the host's sync pattern as a camera would see it: perspective, blur-free, noisy. */
function photograph(counter: number, frac: number, H: Mat3, width = 800, height = 600, seed = 1) {
  const qr = qrcode(0, 'M');
  qr.addData('FM-SYNC');
  qr.make();
  const modules = qr.getModuleCount();
  const colsA = cellColors(counter);
  const colsB = cellColors(counter + 1);
  // Inverse mapping: image pixel → pattern units.
  const Hinv = homographyFrom4(
    [0, 1, 2, 3].map((i) => applyHomography(H, [0, 1, 1, 0][i], [0, 0, 1, 1][i])),
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  )!;
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const margin = 4 / modules;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = applyHomography(Hinv, x + 0.5, y + 0.5);
      let v = 40; // the room around the screen
      if (p.x > -margin && p.x < 1 + margin && p.y > -margin && p.y < TC_PATTERN_HEIGHT + margin) {
        v = 235; // white panel
        if (p.x >= 0 && p.x < 1 && p.y >= 0 && p.y < 1) {
          const r = Math.floor(p.y * modules);
          const c = Math.floor(p.x * modules);
          v = qr.isDark(r, c) ? 25 : 235;
        } else {
          for (let i = 0; i < TC_CELLS; i++) {
            const rect = cellRect(i);
            const gap = rect.w * 0.06;
            if (p.x >= rect.x + gap && p.x < rect.x + rect.w - gap && p.y >= rect.y + gap && p.y < rect.y + rect.h - gap) {
              const a = colsA[i] ? 235 : 25;
              const b = colsB[i] ? 235 : 25;
              v = a * (1 - frac) + b * frac;
            }
          }
        }
      }
      s = (s * 1664525 + 1013904223) >>> 0;
      v += ((s >>> 24) - 128) / 16;
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

function perspective(corners: Pt[]): Mat3 {
  return homographyFrom4(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    corners,
  )!;
}

describe('reading the time code from a photo', () => {
  const views: Pt[][] = [
    // Straight on.
    [
      { x: 250, y: 120 },
      { x: 530, y: 120 },
      { x: 530, y: 400 },
      { x: 250, y: 400 },
    ],
    // Tilted and seen from the side.
    [
      { x: 230, y: 150 },
      { x: 500, y: 110 },
      { x: 520, y: 380 },
      { x: 250, y: 420 },
    ],
  ];

  for (const [vi, corners] of views.entries()) {
    it(`decodes counter and blend (view ${vi})`, () => {
      const H = perspective(corners);
      for (const [counter, frac] of [
        [100, 0],
        [2047, 0.45],
        [4000, 0.3],
      ] as const) {
        const img = photograph(counter, frac, H, 800, 600, counter);
        const found = jsQR(img.data, img.width, img.height)!;
        expect(found, 'QR found').not.toBeNull();
        const Hq = qrHomography({
          topLeft: found.location.topLeftCorner,
          topRight: found.location.topRightCorner,
          bottomRight: found.location.bottomRightCorner,
          bottomLeft: found.location.bottomLeftCorner,
        })!;
        const read = decodeCells(sampleCells(img, Hq))!;
        expect(read, `read ${counter}`).not.toBeNull();
        expect(read.counter).toBe(counter);
        expect(read.frac).toBeCloseTo(frac, 1);
      }
    });
  }

  it('turns a read into host time', () => {
    const log = new TimecodeLog();
    for (let c = 0; c < 100; c++) log.record(c, 1000 + c * 16.7);
    expect(log.timeOf({ counter: 10, frac: 0, ambiguous: 0, contrast: 200 })).toBeCloseTo(1000 + 10.5 * 16.7, 6);
    expect(log.timeOf({ counter: 10, frac: 0.5, ambiguous: 1, contrast: 200 })).toBeCloseTo(1000 + 11 * 16.7, 6);
    expect(log.timeOf({ counter: 500, frac: 0, ambiguous: 0, contrast: 200 })).toBeNull();
    expect(TC_BITS).toBe(12);
  });
});
