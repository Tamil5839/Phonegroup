// End-to-end test in headless Chromium: a host and three shooters, each with
// its own synthetic camera, connected over real WebRTC through a local PeerJS
// server. Runs the whole flow (join → sync → countdown → capture → transfer →
// align → export → clip back to every phone) plus the sync-test clock and
// every export fallback. Screenshots land in e2e/artifacts/.
//
//   node e2e/make-scenes.mjs   # once: synthetic camera feeds
//   node e2e/run.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import { PeerServer } from 'peer';

const ROOT = new URL('..', import.meta.url).pathname;
const ART = join(ROOT, 'e2e/artifacts');
const DIST = join(ROOT, 'dist-e2e');
// Prefer an explicitly given Chromium, then this dev container's, then Playwright's own.
const PRESET_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = process.env.CHROMIUM_PATH || (existsSync(PRESET_CHROME) ? PRESET_CHROME : undefined);
const PEER_PORT = 9123;
const WEB_PORT = 4180;
const BASE = `http://127.0.0.1:${WEB_PORT}/`;
const SHOOTERS = 3;
mkdirSync(ART, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const failures = [];
function check(cond, msg) {
  if (cond) log('  ✓', msg);
  else {
    log('  ✗', msg);
    failures.push(msg);
  }
}

// 1. Build with local signaling and test hooks.
if (!process.env.SKIP_BUILD) {
  log('building…');
  const b = spawnSync('npx', ['vite', 'build', '--outDir', 'dist-e2e', '--emptyOutDir'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_PEER_HOST: '127.0.0.1',
      VITE_PEER_PORT: String(PEER_PORT),
      VITE_PEER_PATH: '/fm',
      VITE_PEER_SECURE: 'false',
      VITE_E2E: '1',
    },
  });
  if (b.status !== 0) process.exit(1);
}
if (!existsSync(join(ART, 'scene-0.y4m'))) spawnSync('node', ['e2e/make-scenes.mjs'], { cwd: ROOT, stdio: 'inherit' });

// 2. Signaling server and a static web server.
const peerServer = PeerServer({ host: '127.0.0.1', port: PEER_PORT, path: '/fm', key: 'peerjs' });
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};
const web = http
  .createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, BASE).pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(DIST, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  })
  .listen(WEB_PORT, '127.0.0.1');

// 3. One browser per phone, each with its own fake camera feed.
const args = (scene) => [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-video-capture=${join(ART, `scene-${scene}.y4m`)}`,
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
const phone = { viewport: { width: 412, height: 892 }, deviceScaleFactor: 1 };

async function openPhone(name, scene) {
  const browser = await chromium.launch({ executablePath: CHROME, args: args(scene) });
  const context = await browser.newContext({ ...phone, permissions: ['camera'] });
  const page = await context.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const text = m.text();
      page.errors.push(`${m.type()}: ${text}`);
      if (process.env.VERBOSE) log(`[${name}] ${m.type()}: ${text}`);
    }
  });
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  page.browserRef = browser;
  return page;
}

const shot = (page, name) => page.screenshot({ path: join(ART, `${name}.png`) });

/**
 * Record a 4 s WebM in the page: a picture whose brightness steps every
 * 100 ms, with room noise and the moment chirp 2.0 s in (step 20).
 */
async function recordChirpVideo(page) {
  const b64 = await page.evaluate(async () => {
    const { chirpSamples, MOMENT_CHIRP } = window.__fmTest;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const ac = new AudioContext();
    await ac.resume();
    const dest = ac.createMediaStreamDestination();
    // Continuous room noise, like a phone microphone (the stream has no samples while nothing plays).
    const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() - 0.5) * 0.06;
    const room = ac.createBufferSource();
    room.buffer = noise;
    room.loop = true;
    room.connect(dest);
    room.start();
    const stream = canvas.captureStream(30);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    // The picture shows a step counter (brightness) that advances every 100 ms.
    const t0 = performance.now();
    let raf = 0;
    const draw = () => {
      const n = Math.floor((performance.now() - t0) / 100);
      ctx.fillStyle = `rgb(${n * 6},${n * 6},${n * 6})`;
      ctx.fillRect(0, 0, 320, 240);
      raf = requestAnimationFrame(draw);
    };
    draw();
    rec.start(100);
    // The chirp plays 2.0 s into the recording, when the counter reads 20.
    const samples = chirpSamples(MOMENT_CHIRP, ac.sampleRate, 0.9);
    const buf = ac.createBuffer(1, samples.length, ac.sampleRate);
    buf.copyToChannel(samples, 0);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start(ac.currentTime + (t0 + 2000 - performance.now()) / 1000);
    await new Promise((r) => setTimeout(r, 4000));
    rec.stop();
    await stopped;
    cancelAnimationFrame(raf);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

/** Minimal ISO-BMFF walk: top-level order, sample entry type, sample count and track duration. */
function inspectMp4(buf) {
  const boxes = (start, end) => {
    const out = [];
    for (let off = start; off + 8 <= end;) {
      let size = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      let header = 8;
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(off + 8));
        header = 16;
      } else if (size === 0) size = end - off;
      out.push({ type, body: off + header, end: off + size });
      off += size;
    }
    return out;
  };
  const child = (parent, type) => boxes(parent.body, parent.end).find((b) => b.type === type);
  const top = boxes(0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  const trak = child(moov, 'trak');
  const mdia = child(trak, 'mdia');
  const mdhd = child(mdia, 'mdhd');
  const v = buf[mdhd.body];
  const timescale = v === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12);
  const stbl = child(child(mdia, 'minf'), 'stbl');
  const stsd = child(stbl, 'stsd');
  const entry = buf.toString('latin1', stsd.body + 12, stsd.body + 16);
  const stts = child(stbl, 'stts');
  const n = buf.readUInt32BE(stts.body + 4);
  let samples = 0;
  let ticks = 0;
  const deltas = new Set();
  for (let i = 0; i < n; i++) {
    const count = buf.readUInt32BE(stts.body + 8 + i * 8);
    const delta = buf.readUInt32BE(stts.body + 12 + i * 8);
    samples += count;
    ticks += count * delta;
    deltas.add(delta);
  }
  return {
    order: top.map((b) => b.type),
    entry,
    sampleCount: samples,
    durationMs: (ticks / timescale) * 1000,
    distinctDeltas: deltas.size,
  };
}

let exitCode = 0;
const pages = [];
try {
  // ---------------------------------------------------------------- host
  log('host: creating a moment');
  const host = await openPhone('host', 0);
  pages.push(host);
  await host.goto(`${BASE}#/`);
  await shot(host, '01-home');
  log('recording a test video with the moment chirp (for manual-mode import)');
  const momentVideo = await recordChirpVideo(host);
  const momentPath = join(ART, 'frozen-TEST01-pos04-alex.webm');
  writeFileSync(momentPath, momentVideo);
  await host.getByRole('button', { name: 'Create moment' }).click();
  await host.locator('.room-code').waitFor({ timeout: 20_000 });
  const code = (await host.locator('.room-code').innerText()).replace(/\s+/g, '');
  check(/^[0-9A-Z]{6}$/.test(code), `room code shown (${code})`);
  await shot(host, '02-host-lobby-empty');

  // ------------------------------------------------------------- shooters
  const shooters = [];
  for (let i = 0; i < SHOOTERS; i++) {
    log(`shooter ${i + 1}: joining`);
    const p = await openPhone(`shooter${i + 1}`, i + 1);
    pages.push(p);
    shooters.push(p);
    await p.goto(`${BASE}#/j/${code}`);
    await p.locator('#name').fill(`Phone ${i + 1}`);
    if (i === 0) await shot(p, '03-shooter-consent');
    await p.getByRole('button', { name: /Join/ }).click();
    await p.getByText('You are').waitFor({ timeout: 30_000 });
  }
  check(true, `${SHOOTERS} shooters joined`);
  // Lobby: everyone connected, synced and ready.
  await host.waitForFunction((n) => document.querySelectorAll('.shooter').length === n, SHOOTERS, { timeout: 20_000 });
  await host.waitForFunction(() => document.querySelectorAll('.chip.ok, .chip.accent').length > 0, null, { timeout: 20_000 });
  await host.waitForTimeout(2500);
  await shot(host, '04-host-lobby-ready');
  await shot(shooters[0], '05-shooter-aiming');
  const syncTexts = await host.locator('.shooter .chip').allInnerTexts();
  const uncertainties = syncTexts.filter((t) => t.startsWith('±')).map((t) => Number(t.match(/±(\d+)/)[1]));
  check(uncertainties.length === SHOOTERS, `every shooter reports a sync estimate (${uncertainties.join(', ')} ms)`);
  check(
    uncertainties.every((u) => u <= 25),
    'sync uncertainty ≤ 25 ms on localhost',
  );
  const positions = await Promise.all(shooters.map((p) => p.locator('.position-badge .big').innerText()));
  check(new Set(positions).size === SHOOTERS, `each phone has its own position (${positions.join(', ')})`);

  // --------------------------------------------------------------- capture
  log('host: freeze the moment');
  await host.getByRole('button', { name: 'Freeze the moment' }).click();
  await shooters[0].locator('.countdown .num').first().waitFor({ timeout: 10_000 });
  await shot(shooters[0], '06-shooter-countdown');
  await host.getByText(/Tap the centre of the subject/).waitFor({ timeout: 45_000 });
  check(true, 'all photos collected, editor open');
  await shot(host, '07-host-editor-pick-subject');
  const films = await host.locator('.film').count();
  check(films === SHOOTERS, `editor has ${films} frames`);
  for (const p of shooters) await p.getByText(/Sent\. The host is making the clip/).waitFor({ timeout: 20_000 });
  check(true, 'every shooter delivered its photo');
  await shot(shooters[1], '08-shooter-waiting');

  // --------------------------------------------------------------- editing
  log('host: tap the subject → alignment (OpenCV worker)');
  const picker = host.locator('.picker canvas');
  const box = await picker.boundingBox();
  await host.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await host.locator('.preview-box canvas').waitFor({ timeout: 20_000 });
  await host.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 90_000 });
  const note = await host.locator('.notice.warn').allInnerTexts();
  check(!note.some((t) => /unavailable/.test(t)), `automatic alignment ran${note.length ? ` (note: ${note.join(' | ')})` : ''}`);
  const confidences = [];
  for (let i = 0; i < films; i++) {
    await host.locator('.film').nth(i).click();
    confidences.push(await host.locator('.panel .chip').last().innerText());
  }
  await host.locator('.film').nth(1).click();
  await shot(host, '09-host-editor-adjust');
  await host.locator('.film').nth(1).click();
  check(
    confidences.every((c) => ['anchor', 'good'].includes(c)),
    `alignment confidence per frame: ${confidences.join(', ')}`,
  );
  await host.waitForTimeout(1500);
  await shot(host, '10-host-editor-preview');

  log('host: add a manual-mode video in the editor and pick its frame by hand');
  await host.locator('input[type=file]').setInputFiles(momentPath);
  await host.waitForFunction((n) => document.querySelectorAll('.film').length === n, films + 1, { timeout: 30_000 });
  check(true, 'imported video joins the edit as an extra frame');
  await host.locator('.film').last().click();
  await host.getByRole('button', { name: 'Pick the video frame by hand' }).click();
  await host.locator('.panel input[type=range]').first().waitFor({ timeout: 15_000 });
  const pickLabel = await host.locator('.panel .field .label').first().innerText();
  check(/chirp at 2\.0\d\d s/.test(pickLabel), `frame picker opens at the chirp (${pickLabel})`);
  await host.getByRole('button', { name: 'Next frame' }).click();
  await host.waitForTimeout(400);
  await shot(host, '10b-host-editor-video-picker');
  await host.getByRole('button', { name: 'Use this frame' }).click();
  await host.getByRole('button', { name: 'Pick the video frame by hand' }).waitFor({ timeout: 15_000 });
  check((await host.locator('.film').count()) === films + 1, 'hand-picked frame replaces the imported one');
  await host.locator('.film').last().click();

  log('host: create clip');
  await host.getByRole('button', { name: 'Create clip' }).click();
  await host.getByText('Your frozen moment').waitFor({ timeout: 60_000 });
  const clip = await host.evaluate(async () => {
    const el = document.querySelector('.clip');
    const blob = await (await fetch(el.src)).blob();
    const note = document.querySelector('main p.muted.small')?.textContent ?? '';
    return { size: blob.size, type: blob.type, note, tag: el.tagName };
  });
  check(clip.size > 20_000, `clip exported: ${clip.type}, ${(clip.size / 1024).toFixed(0)} KB (${clip.note || 'MP4 via WebCodecs'})`);
  await host.waitForTimeout(1200);
  await shot(host, '11-host-result');

  for (const [i, p] of shooters.entries()) {
    await p.getByText('Your frozen moment').waitFor({ timeout: 45_000 });
    const got = await p.evaluate(async () => (await (await fetch(document.querySelector('video.clip').src)).blob()).size);
    check(got === clip.size, `shooter ${i + 1} received the clip (${(got / 1024).toFixed(0)} KB)`);
  }
  await shot(shooters[2], '12-shooter-result');
  const delivered = await host.locator('.chip.accent').first().innerText();
  check(delivered.startsWith(`${SHOOTERS}/${SHOOTERS}`), `host shows delivery ${delivered}`);

  // ------------------------------------------------------------ sync test
  log('host: sync test');
  await host.getByRole('button', { name: 'New moment' }).click();
  await host.getByRole('button', { name: 'Sync test' }).click();
  await host.locator('.timecode canvas').waitFor();
  await host.waitForTimeout(800);
  await shot(host, '13-host-sync-clock');
  // Photograph the host's clock (a screenshot stands in for a phone camera) and read it back.
  const before = await host.evaluate(() => performance.timeOrigin + performance.now());
  const png = await host.locator('.timecode canvas').screenshot();
  const after = await host.evaluate(() => performance.timeOrigin + performance.now());
  const read = await host.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const r = await window.__fmTest.readTimecode(ctx.getImageData(0, 0, c.width, c.height));
    return r && { counter: r.read.counter, frac: r.read.frac, epoch: r.payload.epoch };
  }, png.toString('base64'));
  check(!!read, `the on-screen time code decodes from a screenshot${read ? ` (counter ${read.counter})` : ''}`);
  if (read) {
    const shown = read.epoch + (read.counter + 0.5) * (1000 / 60);
    const lap = (4096 * 1000) / 60;
    const within = (((shown - before) % lap) + lap) % lap;
    check(
      within <= after - before + 50,
      `decoded time lies within the screenshot window (${within.toFixed(0)} ms into a ${(after - before).toFixed(0)} ms window)`,
    );
  }
  await host.getByRole('button', { name: 'Start test' }).click();
  await host.locator('table.table').waitFor({ timeout: 45_000 });
  const rows = await host.locator('table.table tbody tr:has(td.num)').count();
  check(rows === SHOOTERS, `sync test produced a result row per phone (${rows})`);
  await shot(host, '14-host-sync-results');
  await host.getByRole('button', { name: 'Done' }).click();

  // ------------------------------------------------------ export fallbacks
  log('export: every method in the fallback chain');
  const exports = await host.evaluate(async () => {
    const { exportClip, buildTimeline } = window.__fmTest;
    const canvas = document.createElement('canvas');
    canvas.width = 608;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    const timeline = buildTimeline({ style: 'loop', count: 6, fps: 15, targetMs: 3000 });
    const draw = (item) => {
      ctx.fillStyle = `hsl(${item.frame * 60}, 70%, 50%)`;
      ctx.fillRect(0, 0, 608, 1080);
      ctx.fillStyle = '#fff';
      ctx.font = '200px sans-serif';
      ctx.fillText(String(item.frame), 220, 600);
    };
    const out = {};
    for (const m of ['webcodecs', 'webcodecs-webm', 'mediarecorder', 'gif']) {
      try {
        const res = await exportClip({ canvas, timeline, draw, methods: [m] });
        // Can this browser play what it made?
        const url = URL.createObjectURL(res.blob);
        let playable = null;
        if (res.mime.startsWith('video/')) {
          const v = document.createElement('video');
          v.muted = true;
          v.src = url;
          playable = await new Promise((resolve) => {
            v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
            v.onerror = () => resolve(null);
            setTimeout(() => resolve(null), 8000);
          });
        } else {
          const img = new Image();
          img.src = url;
          playable = await img.decode().then(
            () => ({ w: img.naturalWidth, h: img.naturalHeight }),
            () => null,
          );
        }
        const head = Array.from(new Uint8Array(await res.blob.slice(0, 64).arrayBuffer()));
        out[m] = {
          ok: true,
          mime: res.mime,
          size: res.blob.size,
          playable,
          head,
          bytes: m === 'webcodecs' ? Array.from(new Uint8Array(await res.blob.arrayBuffer())) : null,
        };
      } catch (e) {
        out[m] = { ok: false, error: String(e && e.message) };
      }
    }
    return out;
  });
  for (const [m, r] of Object.entries(exports)) {
    if (!r.ok) {
      log(`  · ${m}: not available here (${r.error})`);
      continue;
    }
    check(r.size > 1000, `${m}: ${r.mime}, ${(r.size / 1024).toFixed(0)} KB`);
    check(!!r.playable, `${m}: the browser can open the result ${r.playable ? JSON.stringify(r.playable) : ''}`);
    if (r.playable && 'd' in r.playable)
      check(Number.isFinite(r.playable.d) && r.playable.d > 2.5, `${m}: the file states its duration (${r.playable.d})`);
    if (m === 'webcodecs' && r.bytes) writeFileSync(join(ART, 'export-test.mp4'), Buffer.from(r.bytes));
  }
  check(
    Object.values(exports).some((r) => r.ok),
    'at least one export method works',
  );

  // MP4 container: the H.264 muxing path, exercised with VP9 when this Chromium build has no H.264 encoder.
  const mp4 = await host.evaluate(async () => {
    const { encodeWithMediabunny, buildTimeline } = window.__fmTest;
    const canvas = document.createElement('canvas');
    canvas.width = 608;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    const timeline = buildTimeline({ style: 'sweep', count: 5, fps: 15, targetMs: 3000 });
    const draw = (item) => {
      ctx.fillStyle = `hsl(${item.frame * 70}, 60%, 45%)`;
      ctx.fillRect(0, 0, 608, 1080);
    };
    const avc = (await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 608, height: 1080 })).supported;
    const codec = avc ? 'avc' : 'vp9';
    const res = await encodeWithMediabunny({ canvas, timeline, draw }, 'mp4', [codec]);
    return {
      codec,
      samples: timeline.length,
      totalMs: timeline.reduce((a, f) => a + f.ms, 0),
      bytes: Array.from(new Uint8Array(await res.blob.arrayBuffer())),
    };
  });
  const mp4Box = inspectMp4(Buffer.from(mp4.bytes));
  writeFileSync(join(ART, `export-${mp4.codec}.mp4`), Buffer.from(mp4.bytes));
  check(
    mp4Box.order.indexOf('moov') >= 0 && mp4Box.order.indexOf('moov') < mp4Box.order.indexOf('mdat'),
    `MP4 (${mp4.codec}) is fast-start: ${mp4Box.order.join(' → ')}`,
  );
  check(
    mp4Box.sampleCount === mp4.samples,
    `MP4 has one sample per timeline entry (${mp4Box.sampleCount}/${mp4.samples}, sample entry '${mp4Box.entry}')`,
  );
  check(
    Math.abs(mp4Box.durationMs - mp4.totalMs) < 40,
    `MP4 duration matches the timeline (${mp4Box.durationMs.toFixed(0)} vs ${mp4.totalMs.toFixed(0)} ms; ${mp4Box.distinctDeltas} distinct frame durations)`,
  );

  // ------------------------------------------- manual mode: video + chirp
  log('manual mode: a recorded video is matched on the moment chirp');
  const imported = await host.evaluate(async (b64) => {
    const { importFiles } = window.__fmTest;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'frozen-TEST01-pos04-alex.webm', { type: 'video/webm' });
    const { items, failed } = await importFiles([file]);
    const item = items[0];
    if (!item) return { failed };
    const c = document.createElement('canvas');
    c.width = item.bitmap.width;
    c.height = item.bitmap.height;
    const cx = c.getContext('2d');
    cx.drawImage(item.bitmap, 0, 0);
    const px = cx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return {
      failed,
      chirp: item.chirp,
      position: item.position,
      gray: px[0],
      warning: item.warning ?? null,
      neighbors: Object.keys(item.neighbors).length,
    };
  }, momentVideo.toString('base64'));
  if (imported.failed?.length) log('  import failures:', imported.failed);
  if (imported.warning) log('  import warning:', imported.warning);
  check(
    !!imported.chirp,
    `chirp found in the video's soundtrack${imported.chirp ? ` at ${imported.chirp.time.toFixed(3)} s (score ${imported.chirp.score.toFixed(2)})` : ''}`,
  );
  if (imported.chirp) {
    const step = Math.round(imported.gray / 6);
    check(Math.abs(step - 20) <= 1, `the extracted frame is the one on screen at the chirp (step ${step}, expected 20 ± 1 = ±100 ms)`);
  }
  check(imported.position === 4, `lineup position read from the file name (${imported.position})`);
  check(imported.neighbors === 3, `neighbour frames extracted for the "life" effect (${imported.neighbors})`);

  // ------------------------------------------------------------ manual mode
  log('manual mode pages');
  const manual = await openPhone('manual', 0);
  pages.push(manual);
  await manual.goto(`${BASE}#/manual`);
  await manual.getByRole('button', { name: 'Schedule the moment' }).click();
  await manual.locator('.timecode canvas').waitFor();
  await shot(manual, '15-manual-host');
  const qrUrl = await manual.evaluate(() => location.origin + location.pathname);
  check(!!qrUrl, 'manual host shows the moment code');
  await shooters[0].goto(`${BASE}#/m/${code}/${Math.round(Date.now() + 60_000).toString(36)}/${Math.round(Date.now()).toString(36)}`);
  await shooters[0].getByRole('button', { name: 'Start camera' }).waitFor();
  await shot(shooters[0], '16-manual-shooter');
  check(true, 'manual shooter page renders');

  // ------------------------------------------------------------ help page
  await shooters[1].goto(`${BASE}#/help`);
  await shooters[1].getByText('Honest limits').waitFor();
  await shot(shooters[1], '17-help');

  const errors = pages
    .flatMap((p) => p.errors)
    .filter((e) => !/Failed to load resource|favicon|WebGL|GPU stall|Automatic fallback to software WebGL/i.test(e));
  if (errors.length) log('console errors/warnings:\n  ' + errors.slice(0, 20).join('\n  '));
  check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no uncaught page errors');
} catch (err) {
  log('FAILED:', err);
  exitCode = 1;
  for (const [i, p] of pages.entries()) await shot(p, `zz-failure-${i}`).catch(() => {});
  for (const p of pages) if (p.errors.length) log('page errors:', p.errors.slice(0, 10));
} finally {
  for (const p of pages) await p.browserRef.close().catch(() => {});
  web.close();
  peerServer.close?.();
}

if (failures.length) {
  log(`${failures.length} check(s) failed:`);
  for (const f of failures) log('  -', f);
  exitCode = 1;
}
log(exitCode ? 'E2E FAILED' : 'E2E PASSED');
process.exit(exitCode);
