// Synthetic camera feeds for end-to-end tests: the same scene seen by several
// "phones" standing in an arc (subject fixed, background sliding = parallax,
// slight roll/zoom, different colour casts). Written as Y4M, which Chromium's
// fake camera (--use-file-for-fake-video-capture) plays in a loop.
import { mkdirSync, writeFileSync } from 'node:fs';

const W = 640;
const H = 360;
const FRAMES = 30;
const out = new URL('./artifacts/', import.meta.url);
mkdirSync(out, { recursive: true });

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Scene colour at scene coordinates (subject at the origin). */
function scene(x, y, bgShift, t) {
  // Subject: a textured disc (think: a person) — stays put between views.
  const r = Math.hypot(x, y);
  if (r < 70) {
    const stripes = Math.sin(x * 0.35) * Math.sin(y * 0.25) > 0 ? 1 : 0.55;
    const dots = noise(x / 6 + 50, y / 6 + 50) > 0.6 ? 0.6 : 1;
    return [230 * stripes * dots, 150 * stripes * dots, 110 * dots];
  }
  // A small ball orbiting in front of the subject: it moves over time.
  const bx = Math.cos(t * 2 * Math.PI) * 110;
  const by = Math.sin(t * 2 * Math.PI) * 30 + 60;
  if (Math.hypot(x - bx, y - by) < 14) return [250, 250, 90];
  // Background: further away, so it slides between views.
  const X = x + bgShift;
  const n = noise(X / 23, y / 23) * 0.6 + noise(X / 7, y / 7) * 0.4;
  const checker = (Math.floor(X / 41) + Math.floor(y / 33)) % 2 ? 1 : 0.7;
  const v = (0.35 + 0.65 * n) * checker;
  return [70 + 120 * v, 90 + 110 * v * (0.8 + 0.2 * Math.sin(X * 0.02)), 120 + 90 * v];
}

const views = [
  { bgShift: -90, scale: 1.0, roll: -2, dx: -14, dy: 6, gain: [1, 1, 1] },
  { bgShift: -30, scale: 1.04, roll: 1.5, dx: 10, dy: -8, gain: [1.08, 1.02, 0.92] },
  { bgShift: 30, scale: 0.97, roll: -1, dx: -6, dy: 10, gain: [0.9, 0.93, 0.98] },
  { bgShift: 90, scale: 1.02, roll: 2.5, dx: 16, dy: -4, gain: [0.95, 1.0, 1.1] },
];

function toYuv(r, g, b) {
  const Y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [Y, (b - Y) * 0.564 + 128, (r - Y) * 0.713 + 128];
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

views.forEach((v, k) => {
  const header = `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`;
  const frameBytes = W * H * 1.5;
  const buf = Buffer.alloc(header.length + FRAMES * (6 + frameBytes));
  let off = buf.write(header);
  const cos = Math.cos((v.roll * Math.PI) / 180);
  const sin = Math.sin((v.roll * Math.PI) / 180);
  const U = new Float32Array((W / 2) * (H / 2));
  const V = new Float32Array((W / 2) * (H / 2));
  for (let f = 0; f < FRAMES; f++) {
    off += buf.write('FRAME\n', off);
    U.fill(0);
    V.fill(0);
    const yOff = off;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        // Image → scene: undo the view's roll/zoom about the subject's image position.
        const ix = px - (W / 2 + v.dx);
        const iy = py - (H / 2 + v.dy);
        const sx = (cos * ix + sin * iy) / v.scale;
        const sy = (-sin * ix + cos * iy) / v.scale;
        const [r, g, b] = scene(sx, sy, v.bgShift, f / FRAMES);
        const [Y, Cb, Cr] = toYuv(clamp(r * v.gain[0]), clamp(g * v.gain[1]), clamp(b * v.gain[2]));
        buf[yOff + py * W + px] = clamp(Y);
        const ci = (py >> 1) * (W / 2) + (px >> 1);
        U[ci] += Cb / 4;
        V[ci] += Cr / 4;
      }
    }
    off += W * H;
    for (let i = 0; i < U.length; i++) buf[off + i] = clamp(U[i]);
    off += U.length;
    for (let i = 0; i < V.length; i++) buf[off + i] = clamp(V[i]);
    off += V.length;
  }
  writeFileSync(new URL(`scene-${k}.y4m`, out), buf.subarray(0, off));
});
console.log(`wrote ${views.length} scenes to ${out.pathname}`);
