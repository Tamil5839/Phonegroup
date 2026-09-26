/**
 * Clip export with graceful fallbacks:
 *   1. WebCodecs H.264 encoder + Mediabunny MP4 muxer (fast, exact timing, plays everywhere)
 *   2. WebCodecs VP9/VP8 + WebM, for browsers with WebCodecs but no H.264 encoder
 *   3. MediaRecorder on the canvas (real-time; MP4 where supported, else WebM)
 *   4. Animated GIF (gifenc) as a last resort
 */
import type { TimelineFrame } from '../core/sequence';
import { timelineDuration } from '../core/sequence';

export type ExportMethod = 'webcodecs' | 'webcodecs-webm' | 'mediarecorder' | 'gif';

export interface ExportJob {
  canvas: HTMLCanvasElement;
  timeline: readonly TimelineFrame[];
  /** Render one timeline entry into `canvas`. */
  draw: (item: TimelineFrame) => void;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
  /** Try these methods in order (default: all, best first). */
  methods?: ExportMethod[];
  bitrate?: number;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm' | 'gif';
  method: ExportMethod;
  durationMs: number;
}

export async function exportClip(job: ExportJob): Promise<ExportResult> {
  const methods = job.methods ?? ['webcodecs', 'webcodecs-webm', 'mediarecorder', 'gif'];
  let lastErr: unknown = null;
  for (const m of methods) {
    if (job.signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
    try {
      if (m === 'webcodecs') return await viaWebCodecs(job);
      if (m === 'webcodecs-webm') return await viaWebCodecsWebm(job);
      if (m === 'mediarecorder') return await viaMediaRecorder(job);
      return await viaGif(job);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      console.warn(`Export via ${m} failed`, err);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('This browser cannot create videos.');
}

async function viaWebCodecs(job: ExportJob): Promise<ExportResult> {
  return encodeWithMediabunny(job, 'mp4');
}

async function viaWebCodecsWebm(job: ExportJob): Promise<ExportResult> {
  return encodeWithMediabunny(job, 'webm');
}

async function encodeWithMediabunny(job: ExportJob, container: 'mp4' | 'webm'): Promise<ExportResult> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new Error('WebCodecs is not available');
  const { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, Quality, canEncodeVideo } = await import('mediabunny');
  const { width, height } = job.canvas;
  const bitrate = job.bitrate ?? 6_000_000;
  const candidates = container === 'mp4' ? (['avc'] as const) : (['vp9', 'vp8'] as const);
  let codec: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (await canEncodeVideo(c, { width, height, quality: new Quality({ bitrate }) })) {
      codec = c;
      break;
    }
  }
  if (!codec) throw new Error(container === 'mp4' ? 'No H.264 encoder available' : 'No VP9/VP8 encoder available');
  const format = container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
  const output = new Output({ format, target: new BufferTarget() });
  const source = new CanvasSource(job.canvas, { codec, quality: new Quality({ bitrate }), keyFrameInterval: 1 });
  output.addVideoTrack(source);
  await output.start();
  const total = timelineDuration(job.timeline);
  let t = 0;
  try {
    for (const item of job.timeline) {
      if (job.signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
      job.draw(item);
      await source.add(t / 1000, item.ms / 1000);
      t += item.ms;
      job.onProgress?.(t / total);
    }
    source.close();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  const buffer = output.target.buffer;
  if (!buffer || buffer.byteLength === 0) throw new Error('Encoder produced no data');
  const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
  return {
    blob: new Blob([buffer], { type: mime }),
    mime,
    ext: container,
    method: container === 'mp4' ? 'webcodecs' : 'webcodecs-webm',
    durationMs: total,
  };
}

async function viaMediaRecorder(job: ExportJob): Promise<ExportResult> {
  if (typeof MediaRecorder === 'undefined' || !job.canvas.captureStream) throw new Error('MediaRecorder is not available');
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('No recordable video format');
  const stream = job.canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const manual = typeof track.requestFrame === 'function';
  const liveStream = manual ? stream : job.canvas.captureStream(30);
  const recorder = new MediaRecorder(liveStream, { mimeType: mime, videoBitsPerSecond: job.bitrate ?? 6_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  const total = timelineDuration(job.timeline);
  recorder.start(250);
  let t = 0;
  try {
    // Real-time playback: the recorder timestamps frames as they are drawn.
    const start = performance.now();
    for (const item of job.timeline) {
      if (job.signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
      job.draw(item);
      if (manual) track.requestFrame!();
      t += item.ms;
      job.onProgress?.(t / total);
      const wait = start + t - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    // Hold the last frame briefly so it isn't cut short.
    if (manual) track.requestFrame!();
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    for (const tr of liveStream.getTracks()) tr.stop();
    if (liveStream !== stream) for (const tr of stream.getTracks()) tr.stop();
  }
  const base = mime.split(';')[0];
  const blob = new Blob(chunks, { type: base });
  if (!blob.size) throw new Error('Recorder produced no data');
  return { blob, mime: base, ext: base === 'video/mp4' ? 'mp4' : 'webm', method: 'mediarecorder', durationMs: total };
}

async function viaGif(job: ExportJob): Promise<ExportResult> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const scale = Math.min(1, 480 / Math.max(job.canvas.width, job.canvas.height));
  const w = Math.max(2, Math.round(job.canvas.width * scale));
  const h = Math.max(2, Math.round(job.canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const total = timelineDuration(job.timeline);
  let t = 0;
  for (const item of job.timeline) {
    if (job.signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
    job.draw(item);
    ctx.drawImage(job.canvas, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, w, h, { palette, delay: Math.max(20, Math.round(item.ms)) });
    t += item.ms;
    job.onProgress?.(t / total);
    await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  const bytes = gif.bytes();
  return {
    blob: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'image/gif' }),
    mime: 'image/gif',
    ext: 'gif',
    method: 'gif',
    durationMs: total,
  };
}
