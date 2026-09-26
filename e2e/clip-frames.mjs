// Tiles frames from the exported clip for visual review (alignment, colour matching, "life" frames):
//   node e2e/clip-frames.mjs [clip] [out.png]
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';

const art = new URL('./artifacts/', import.meta.url).pathname;
const clipPath = process.argv[2] || join(art, existsSync(join(art, 'clip.mp4')) ? 'clip.mp4' : 'clip.webm');
const out = process.argv[3] || join(art, 'clip-frames.png');
const bytes = readFileSync(clipPath);
const type = clipPath.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
// Serve from a real origin: media playback from data: URLs is restricted.
const server = http
  .createServer((req, res) => {
    if (req.url === '/clip') res.writeHead(200, { 'Content-Type': type }).end(bytes);
    else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<body style="margin:0;background:#111"></body>');
  })
  .listen(4196, '127.0.0.1');
const preset = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync(preset) ? preset : undefined) });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.goto('http://127.0.0.1:4196/');
const info = await page.evaluate(async () => {
  const v = document.createElement('video');
  v.muted = true;
  v.src = '/clip';
  await new Promise((r) => (v.onloadeddata = r));
  const d = Number.isFinite(v.duration) ? v.duration : 4;
  const n = 12;
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:6px';
  document.body.append(grid);
  for (let i = 0; i < n; i++) {
    v.currentTime = ((i + 0.5) / n) * d;
    await new Promise((r) => (v.onseeked = r));
    await new Promise((r) => setTimeout(r, 60));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.style.width = '100%';
    grid.append(c);
  }
  return { w: v.videoWidth, h: v.videoHeight, d };
});
await page.setViewportSize({ width: 1400, height: 100 });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
server.close();
console.log(out, JSON.stringify(info));
