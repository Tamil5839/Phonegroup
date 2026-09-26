/**
 * Reading the host screen's time code from camera images.
 *
 * The screen shows a QR code carrying `FM1|room|epoch|moment` and a Gray-coded
 * counter that advances every 1/60 s since `epoch` (host time). Sync Test
 * Mode uses the host's own log of when each counter was drawn; optical sync
 * (manual mode, no connection) uses the formula epoch + counter × tick.
 */
import { decodeCells, qrHomography, sampleCells, TC_MOD, type LumaImage, type TimecodeLog, type TimecodeRead } from '../core/timecode';

export const TC_TICK_MS = 1000 / 60;

export interface TimecodePayload {
  room: string;
  /** Host time at which the counter was 0. */
  epoch: number;
  /** The scheduled moment T (host time), if any. */
  moment: number | null;
}

export function encodePayload(p: TimecodePayload): string {
  return `FM1|${p.room}|${Math.round(p.epoch)}|${p.moment === null ? '' : Math.round(p.moment)}`;
}

export function parsePayload(text: string): TimecodePayload | null {
  // Manual mode shows the join link itself: …#/m/<room>/<moment base36>/<epoch base36>
  const url = /#\/m\/([0-9A-Za-z]+)\/([0-9a-z]+)\/([0-9a-z]+)/.exec(text);
  if (url) {
    const moment = parseInt(url[2], 36);
    const epoch = parseInt(url[3], 36);
    return Number.isFinite(moment) && Number.isFinite(epoch) ? { room: url[1].slice(0, 16), epoch, moment } : null;
  }
  const parts = text.split('|');
  if (parts.length !== 4 || parts[0] !== 'FM1') return null;
  const epoch = Number(parts[2]);
  const moment = parts[3] === '' ? null : Number(parts[3]);
  if (!Number.isFinite(epoch) || (moment !== null && !Number.isFinite(moment))) return null;
  return { room: parts[1].slice(0, 16), epoch, moment };
}

/** Counter value shown at host time `t`. */
export function counterAt(t: number, epoch: number): number {
  return Math.floor((t - epoch) / TC_TICK_MS);
}

/**
 * Host time at the middle of an exposure, from the formula (no log). The
 * counter only wraps every 68 s; `rough` (any estimate within ±30 s) picks the
 * right lap.
 */
export function hostTimeFromFormula(read: TimecodeRead, epoch: number, rough: number): number {
  const base = read.counter + 1 + read.frac;
  const lap = Math.round((rough - epoch - base * TC_TICK_MS) / (TC_MOD * TC_TICK_MS));
  return epoch + (base + lap * TC_MOD) * TC_TICK_MS;
}

export interface ImageReading {
  payload: TimecodePayload;
  read: TimecodeRead;
}

type JsQR = typeof import('jsqr').default;
let jsqrPromise: Promise<{ fn: JsQR }> | null = null;
function loadJsQR(): Promise<{ fn: JsQR }> {
  jsqrPromise ??= import('jsqr').then((m) => ({ fn: m.default }));
  return jsqrPromise;
}

function downscale(img: ImageData, maxSide: number): { data: ImageData; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale === 1) return { data: img, scale };
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')!.putImageData(img, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = Math.round(img.width * scale);
  dst.height = Math.round(img.height * scale);
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
  return { data: ctx.getImageData(0, 0, dst.width, dst.height), scale };
}

/** Find the QR code and read the counter cells. */
export async function readTimecode(img: ImageData, maxQrSide = 1280): Promise<ImageReading | null> {
  const { fn: jsQR } = await loadJsQR();
  const attempts =
    maxQrSide < Math.max(img.width, img.height) ? [maxQrSide, Math.max(img.width, img.height)] : [Math.max(img.width, img.height)];
  for (const side of attempts) {
    const { data, scale } = downscale(img, side);
    const found = jsQR(data.data, data.width, data.height, { inversionAttempts: 'dontInvert' });
    if (!found) continue;
    const payload = parsePayload(found.data);
    if (!payload) return null;
    const s = (p: { x: number; y: number }) => ({ x: p.x / scale, y: p.y / scale });
    const H = qrHomography({
      topLeft: s(found.location.topLeftCorner),
      topRight: s(found.location.topRightCorner),
      bottomRight: s(found.location.bottomRightCorner),
      bottomLeft: s(found.location.bottomLeftCorner),
    });
    if (!H) return null;
    const read = decodeCells(sampleCells(img as LumaImage, H));
    return read ? { payload, read } : null;
  }
  return null;
}

export async function imageDataFromJpeg(bytes: Uint8Array): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export interface SyncMeasurement {
  /** Host time the photo shows. */
  hostTime: number;
  /** hostTime − T: the phone's real timing error. */
  errorMs: number;
  read: TimecodeRead;
}

/** Sync Test Mode: what time did this phone really capture? */
export async function measureSyncFrame(jpeg: Uint8Array, log: TimecodeLog, target: number): Promise<SyncMeasurement | { error: string }> {
  const img = await imageDataFromJpeg(jpeg);
  const reading = await readTimecode(img);
  if (!reading) return { error: "Couldn't read the clock in this photo — point the phone straight at the host screen." };
  const fromLog = log.timeOf(reading.read);
  const hostTime = fromLog ?? hostTimeFromFormula(reading.read, reading.payload.epoch, target);
  return { hostTime, errorMs: hostTime - target, read: reading.read };
}
