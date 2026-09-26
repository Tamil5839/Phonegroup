/**
 * The rolling frame buffer.
 *
 * "Take photo" APIs have unpredictable delays, so instead the camera streams
 * continuously and every frame is copied into a ring buffer as it arrives
 * (requestVideoFrameCallback), stamped with the best timestamp the browser
 * offers. The last ~1.5 s are kept as small copies, the most recent ~20
 * frames also at full resolution. After the moment T has passed, we pick the
 * frame closest to T plus 3 neighbours on each side.
 */
import { frameInterval, pickDeadline, Ring, selectAround } from '../core/frames';
import type { CaptureReport, TimestampSource } from '../core/protocol';
import { localNow, perfToLocal } from '../core/time';
import type { CaptureDevice, CaptureRequest, CapturedFrames } from '../session/types';

/**
 * When the browser only tells us when a frame was presented (not captured),
 * assume it was captured this long before. Sync Test Mode measures the real
 * value per phone and stores a correction.
 */
export const DEFAULT_PRESENTATION_LATENCY_MS = 30;

interface Slot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

interface BufferedFrame {
  seq: number;
  /** Capture time on this phone's clock (after latency corrections). */
  local: number;
  source: TimestampSource;
  low: Slot;
  full: Slot | null;
}

export interface CameraCaptureOptions {
  /** How much history to keep, in ms. */
  windowMs?: number;
  /** Long side of the small copies kept for the whole window. */
  lowLongSide?: number;
  /** Long side of neighbour frames when sent to the host. */
  neighborLongSide?: number;
  /** Memory budget for full-resolution copies. */
  fullBudgetBytes?: number;
  /** Calibration from Sync Test Mode (ms), subtracted from frame timestamps. */
  latencyCorrection?: () => number;
  /** Device roll at a local time, if a tilt sensor is available. */
  rollAt?: (local: number) => number | null;
  jpegQuality?: number;
}

type FrameMeta = VideoFrameCallbackMetadata & { captureTime?: number };

function makeSlot(w: number, h: number): Slot | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: false });
  return ctx ? { canvas, ctx } : null;
}

function fitLongSide(w: number, h: number, longSide: number): [number, number] {
  const k = Math.min(1, longSide / Math.max(w, h));
  return [Math.max(2, Math.round((w * k) / 2) * 2), Math.max(2, Math.round((h * k) / 2) * 2)];
}

export async function encodeJpeg(source: HTMLCanvasElement, quality: number, maxLongSide?: number): Promise<Uint8Array> {
  let canvas = source;
  if (maxLongSide && Math.max(source.width, source.height) > maxLongSide) {
    const [w, h] = fitLongSide(source.width, source.height, maxLongSide);
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not encode the photo.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Pick the most trustworthy timestamp the browser gives us for a frame (DOMHighResTimeStamp). */
export function pickTimestamp(now: number, meta: FrameMeta | null): { t: number; source: TimestampSource } {
  if (meta) {
    const ct = meta.captureTime;
    const pt = meta.presentationTime;
    // Camera capture time: best, if plausible (not in the future, not absurdly old).
    if (typeof ct === 'number' && ct > 0 && (!(pt > 0) || (ct <= pt + 5 && pt - ct < 1000))) return { t: ct, source: 'capture' };
    if (typeof pt === 'number' && pt > 0) return { t: pt, source: 'presentation' };
  }
  return { t: now, source: 'callback' };
}

export class CameraCapture implements CaptureDevice {
  private ring = new Ring<BufferedFrame>(160);
  private freeLow: Slot[] = [];
  private freeFull: Slot[] = [];
  private fullHolders: BufferedFrame[] = [];
  private fullCapacity = 0;
  private fullCreated = 0;
  private seq = 0;
  private running = false;
  private frozen = 0;
  private width = 0;
  private height = 0;
  private lowW = 0;
  private lowH = 0;
  private rvfc = 0;
  private raf = 0;
  private lastPresented = -1;
  private readonly hasRvfc: boolean;
  /** Where the latest timestamps come from (reported to the host). */
  timestampSource: TimestampSource = 'callback';
  framesSeen = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly opts: CameraCaptureOptions = {},
  ) {
    this.hasRvfc = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rvfc && this.hasRvfc) this.video.cancelVideoFrameCallback(this.rvfc);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.rvfc = this.raf = 0;
    this.reset();
  }

  private reset(): void {
    this.ring.clear();
    this.freeLow = [];
    this.freeFull = [];
    this.fullHolders = [];
    this.fullCreated = 0;
    this.width = this.height = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.hasRvfc) this.rvfc = this.video.requestVideoFrameCallback(this.onVideoFrame);
    else this.raf = requestAnimationFrame(this.onAnimationFrame);
  }

  private onVideoFrame = (now: DOMHighResTimeStamp, meta: VideoFrameCallbackMetadata): void => {
    if (!this.running) return;
    this.schedule();
    const { t, source } = pickTimestamp(now, meta as FrameMeta);
    this.ingest(t, source);
  };

  /** Fallback for browsers without requestVideoFrameCallback: sample on animation frames. */
  private onAnimationFrame = (now: DOMHighResTimeStamp): void => {
    if (!this.running) return;
    this.schedule();
    const quality = this.video.getVideoPlaybackQuality?.();
    const presented = quality ? quality.totalVideoFrames : -1;
    if (presented >= 0 && presented === this.lastPresented) return;
    this.lastPresented = presented;
    this.ingest(now, 'raf');
  };

  private configure(w: number, h: number): void {
    this.reset();
    this.width = w;
    this.height = h;
    [this.lowW, this.lowH] = fitLongSide(w, h, this.opts.lowLongSide ?? 320);
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const budget = this.opts.fullBudgetBytes ?? (ios ? 110e6 : 160e6);
    this.fullCapacity = Math.max(8, Math.min(20, Math.floor(budget / (w * h * 4))));
  }

  private takeFullSlot(): Slot | null {
    const free = this.freeFull.pop();
    if (free) return free;
    if (this.fullCreated < this.fullCapacity) {
      const slot = makeSlot(this.width, this.height);
      if (slot) {
        this.fullCreated++;
        return slot;
      }
      // Out of canvas memory: live with what we have.
      this.fullCapacity = this.fullCreated;
    }
    const oldest = this.fullHolders.shift();
    if (!oldest) return null;
    const slot = oldest.full;
    oldest.full = null;
    return slot;
  }

  private ingest(perfTime: number, source: TimestampSource): void {
    if (this.frozen > 0) return;
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h || this.video.readyState < 2) return;
    if (w !== this.width || h !== this.height) this.configure(w, h);

    let local = perfToLocal(perfTime);
    if (source !== 'capture') local -= DEFAULT_PRESENTATION_LATENCY_MS;
    local -= this.opts.latencyCorrection?.() ?? 0;
    this.timestampSource = source;
    this.framesSeen++;

    // Drop history beyond the window; recycle its canvases.
    const windowMs = this.opts.windowMs ?? 1500;
    for (const old of this.ring.dropWhile((f) => f.local < local - windowMs)) this.recycle(old);
    if (this.ring.length >= this.ring.capacity) {
      const oldest = this.ring.shift();
      if (oldest) this.recycle(oldest);
    }
    const low = this.freeLow.pop() ?? makeSlot(this.lowW, this.lowH);
    if (!low) return;
    const full = this.takeFullSlot();
    try {
      low.ctx.drawImage(this.video, 0, 0, this.lowW, this.lowH);
      full?.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    } catch {
      // The video isn't drawable yet: hand the canvases back for the next frame.
      this.freeLow.push(low);
      if (full) this.freeFull.push(full);
      return;
    }
    const frame: BufferedFrame = { seq: this.seq++, local, source, low, full };
    this.ring.push(frame);
    if (full) this.fullHolders.push(frame);
  }

  private recycle(f: BufferedFrame): void {
    this.freeLow.push(f.low);
    if (f.full) {
      this.freeFull.push(f.full);
      f.full = null;
      const i = this.fullHolders.indexOf(f);
      if (i >= 0) this.fullHolders.splice(i, 1);
    }
  }

  /** Median frame spacing over the buffer (ms). */
  intervalMs(): number {
    return frameInterval(
      this.ring.toArray().map((f) => ({ hostTime: f.local })),
      1000 / 30,
    );
  }

  /** The newest buffered frame; copy it synchronously, it will be reused. */
  latest(): { canvas: HTMLCanvasElement; local: number; source: TimestampSource } | null {
    const f = this.ring.newest();
    if (!f) return null;
    return { canvas: (f.full ?? f.low).canvas, local: f.local, source: f.source };
  }

  async capture(req: CaptureRequest): Promise<CapturedFrames> {
    if (!this.running) throw new Error('The camera is not running.');
    const neighbors = req.mode === 'synctest' ? 0 : 3;
    const interval = this.intervalMs();
    const localTarget = req.toLocal(req.target);
    const deadline = pickDeadline(localTarget, interval, neighbors, 80);
    while (localNow() < deadline) {
      if (req.signal?.aborted) throw new DOMException('Capture canceled', 'AbortError');
      await new Promise((r) => setTimeout(r, Math.min(40, Math.max(1, deadline - localNow()))));
    }
    this.frozen++;
    try {
      const frames = this.ring.toArray();
      const stamped = frames.map((f) => ({ hostTime: req.toHost(f.local) }));
      const sel = selectAround(stamped, req.target, neighbors);
      if (!sel) throw new Error('No camera frames arrived — is the camera covered or paused?');
      if (Math.abs(sel.errorMs) > Math.max(250, interval * 4)) {
        throw new Error('The camera stalled around the moment. Keep the app open and the screen on.');
      }
      const chosen = frames[sel.chosen];
      const mainSlot = chosen.full ?? chosen.low;
      const main = await encodeJpeg(mainSlot.canvas, this.opts.jpegQuality ?? 0.9);
      const out: { offset: number; data: Uint8Array }[] = [];
      for (let k = 0; k < sel.neighbors.length; k++) {
        const f = frames[sel.neighbors[k]];
        out.push({
          offset: sel.neighborOffsets[k],
          data: await encodeJpeg((f.full ?? f.low).canvas, 0.8, this.opts.neighborLongSide ?? 1280),
        });
      }
      const report: CaptureReport = {
        captureId: req.captureId,
        ok: true,
        errorMs: sel.errorMs,
        intervalMs: interval,
        timestampSource: chosen.source,
        width: mainSlot.canvas.width,
        height: mainSlot.canvas.height,
        neighbors: out.map((n) => n.offset),
        roll: this.opts.rollAt?.(chosen.local) ?? null,
        syncUncertainty: Number.isFinite(req.syncUncertainty) ? req.syncUncertainty : undefined,
        latencyCorrectionMs: this.opts.latencyCorrection?.() ?? 0,
      };
      return { report, main, neighbors: out };
    } finally {
      this.frozen--;
    }
  }
}
