/**
 * Manual mode: photos and short videos sent to the host by any means
 * (messaging app, file share). Photos are used as they are; for videos we
 * find the host's moment chirp in the soundtrack and take the frame at that
 * instant (plus its neighbours for the "life" effect).
 */
import { ANALYSIS_RATE, detectChirp, resample } from '../core/chirp';

export interface ImportedMedia {
  id: string;
  name: string;
  bitmap: ImageBitmap;
  neighbors: Record<number, ImageBitmap>;
  /** Lineup position parsed from the file name (e.g. "…-pos03-…"), if any. */
  position: number | null;
  kind: 'photo' | 'video';
  /** For videos: where the moment was found and how sure we are. */
  chirp?: { time: number; score: number };
  warning?: string;
  /** Kept so the host can re-pick a frame by hand. */
  file?: File;
}

export const MAX_SOURCE_SIDE = 1600;

export function positionFromName(name: string): number | null {
  const m = /(?:pos|#|no\.?|nr)[\s_-]?(\d{1,2})\b/i.exec(name);
  return m ? Number(m[1]) : null;
}

async function toBitmap(source: ImageBitmapSource, opts: ImageBitmapOptions = {}): Promise<ImageBitmap> {
  const probe = await createImageBitmap(source, { imageOrientation: 'from-image', ...opts });
  const long = Math.max(probe.width, probe.height);
  if (long <= MAX_SOURCE_SIDE) return probe;
  const k = MAX_SOURCE_SIDE / long;
  const out = await createImageBitmap(probe, {
    resizeWidth: Math.round(probe.width * k),
    resizeHeight: Math.round(probe.height * k),
    resizeQuality: 'high',
  });
  probe.close();
  return out;
}

export function decodeJpeg(bytes: Uint8Array, maxSide = MAX_SOURCE_SIDE): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
  return maxSide === MAX_SOURCE_SIDE ? toBitmap(blob) : createImageBitmap(blob);
}

async function decodeSoundtrack(file: File): Promise<{ samples: Float32Array; rate: number }> {
  const buf = await file.arrayBuffer();
  const OAC = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OAC) throw new Error('This browser cannot read audio from videos.');
  const ctx = new OAC(1, 1, ANALYSIS_RATE);
  const audio = await ctx.decodeAudioData(buf);
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  if (audio.sampleRate === ANALYSIS_RATE) return { samples: mono, rate: ANALYSIS_RATE };
  return { samples: resample(mono, audio.sampleRate, ANALYSIS_RATE), rate: ANALYSIS_RATE };
}

/** A video element ready for frame grabbing. */
export async function openVideo(file: File): Promise<{ video: HTMLVideoElement; release: () => void }> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const url = URL.createObjectURL(file);
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error(`Can't play ${file.name} in this browser.`));
  });
  return {
    video,
    release: () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

/** Seek and grab the frame shown at `time` seconds. */
export async function grabFrame(video: HTMLVideoElement, time: number): Promise<ImageBitmap> {
  const t = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.01));
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    video.addEventListener(
      'seeked',
      () => {
        // Wait until the seeked frame is actually decoded and presented.
        if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => finish());
        setTimeout(finish, 250);
      },
      { once: true },
    );
    video.currentTime = t;
    setTimeout(finish, 3000);
  });
  return toBitmap(video);
}

let importCounter = 0;

export async function importVideo(file: File): Promise<ImportedMedia> {
  const id = `import-${++importCounter}`;
  let chirp: { time: number; score: number } | undefined;
  let warning: string | undefined;
  try {
    const { samples, rate } = await decodeSoundtrack(file);
    const det = detectChirp(samples, rate);
    if (det && det.score >= 0.2 && det.score > det.runnerUp * 1.4) chirp = { time: det.time, score: det.score };
    else warning = "Couldn't hear the moment chirp in this video — check the frame, or pick it by hand.";
  } catch {
    warning = "Couldn't read this video's sound — pick the frame by hand.";
  }
  const { video, release } = await openVideo(file);
  try {
    const moment = chirp?.time ?? video.duration / 2;
    const fps = 30;
    // A hair after the chirp onset lands inside the frame that was on screen at that instant.
    const bitmap = await grabFrame(video, moment + 0.002);
    const neighbors: Record<number, ImageBitmap> = {};
    for (const k of [1, 2, 3]) neighbors[k] = await grabFrame(video, moment + 0.002 + k / fps);
    return { id, name: file.name.replace(/\.[^.]+$/, ''), bitmap, neighbors, position: positionFromName(file.name), kind: 'video', chirp, warning, file };
  } finally {
    release();
  }
}

export async function importPhoto(file: File): Promise<ImportedMedia> {
  const bitmap = await toBitmap(file);
  return {
    id: `import-${++importCounter}`,
    name: file.name.replace(/\.[^.]+$/, ''),
    bitmap,
    neighbors: {},
    position: positionFromName(file.name),
    kind: 'photo',
  };
}

export async function importFiles(files: File[], onProgress?: (done: number, total: number) => void): Promise<{ items: ImportedMedia[]; failed: string[] }> {
  const items: ImportedMedia[] = [];
  const failed: string[] = [];
  let done = 0;
  for (const file of files) {
    try {
      if (file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|3gp)$/i.test(file.name)) items.push(await importVideo(file));
      else items.push(await importPhoto(file));
    } catch (err) {
      failed.push(`${file.name}: ${(err as Error).message}`);
    }
    onProgress?.(++done, files.length);
  }
  items.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  return { items, failed };
}
