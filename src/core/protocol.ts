/**
 * Messages exchanged between shooters and the host. Control messages are
 * JSON strings; frame data travels as binary transfer chunks (see transfer.ts).
 * Everything received is validated: a phone in the room must not be able to
 * crash or confuse another one with a malformed message.
 */
import { TRANSFER_CONTROL_TYPES, type TransferControl } from './transfer';

export const PROTOCOL_VERSION = 1;

export type Orientation = 'portrait' | 'landscape';
export type CaptureMode = 'moment' | 'synctest';
export type TimestampSource = 'capture' | 'presentation' | 'callback' | 'raf' | 'synthetic';

export interface DeviceInfo {
  ua: string;
  mobile: boolean;
}

export interface CameraStatus {
  state: 'off' | 'starting' | 'ready' | 'error';
  width?: number;
  height?: number;
  fps?: number;
  error?: string;
  timestampSource?: TimestampSource;
}

export interface RoomSettings {
  orientation: Orientation;
  /** Countdown length once everyone is synced. */
  countdownMs: number;
}

export const DEFAULT_SETTINGS: RoomSettings = { orientation: 'portrait', countdownMs: 3500 };

export interface CaptureReport {
  captureId: string;
  ok: boolean;
  error?: string;
  /** Chosen frame time − T, in ms (host time base). */
  errorMs?: number;
  /** Median spacing between camera frames. */
  intervalMs?: number;
  timestampSource?: TimestampSource;
  width?: number;
  height?: number;
  /** Neighbour offsets that will follow (e.g. [-3,-2,-1,1,2,3]). */
  neighbors?: number[];
  /** Device roll in degrees at capture (clockwise positive), if the sensor is available. */
  roll?: number | null;
  syncUncertainty?: number;
  latencyCorrectionMs?: number;
}

export type ShooterMessage =
  | { t: 'hello'; v: number; clientId: string; name: string; device: DeviceInfo }
  | { t: 'ping'; id: number; t0: number }
  | { t: 'sync'; offset: number; uncertainty: number; bestRtt: number; samples: number; full: boolean }
  | { t: 'sync-failed'; reason: string }
  | { t: 'status'; camera: CameraStatus }
  | { t: 'report'; report: CaptureReport }
  | { t: 'bye' }
  | TransferControl;

export type HostMessage =
  | { t: 'welcome'; v: number; room: string; settings: RoomSettings; index: number; total: number }
  | { t: 'reject'; reason: string }
  | { t: 'pong'; id: number; h1: number; h2: number }
  | { t: 'lineup'; index: number; total: number }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'sync-request'; full: boolean }
  | { t: 'countdown'; captureId: string; target: number; mode: CaptureMode }
  | { t: 'abort'; captureId: string; reason: string }
  | { t: 'calibrate'; latencyMs: number }
  | { t: 'progress'; captureId: string; stage: 'collecting' | 'editing' | 'rendering' | 'sending' | 'failed'; message?: string }
  | { t: 'kick'; reason: string }
  | { t: 'room-closed' }
  | TransferControl;

type Check = (v: unknown) => boolean;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const int: Check = (v) => Number.isInteger(v);
const str =
  (max = 200): Check =>
  (v) =>
    typeof v === 'string' && v.length <= max;
const bool: Check = (v) => typeof v === 'boolean';
const obj: Check = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf =
  (...vals: string[]): Check =>
  (v) =>
    typeof v === 'string' && vals.includes(v);
const opt =
  (c: Check): Check =>
  (v) =>
    v === undefined || v === null || c(v);
const intArray =
  (max: number): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every((x) => Number.isInteger(x));

function shape(fields: Record<string, Check>): Check {
  return (v) => obj(v) && Object.entries(fields).every(([k, c]) => c((v as Record<string, unknown>)[k]));
}

const settingsShape = shape({ orientation: oneOf('portrait', 'landscape'), countdownMs: num });
const cameraShape = shape({
  state: oneOf('off', 'starting', 'ready', 'error'),
  width: opt(num),
  height: opt(num),
  fps: opt(num),
  error: opt(str(300)),
  timestampSource: opt(str(20)),
});
const reportShape = shape({
  captureId: str(64),
  ok: bool,
  error: opt(str(300)),
  errorMs: opt(num),
  intervalMs: opt(num),
  timestampSource: opt(str(20)),
  width: opt(num),
  height: opt(num),
  neighbors: opt(intArray(32)),
  roll: opt(num),
  syncUncertainty: opt(num),
  latencyCorrectionMs: opt(num),
});

const transferShapes: Record<string, Check> = {
  'xfer-begin': shape({ id: int, size: int, chunkSize: int, count: int, crc: int, meta: obj }),
  'xfer-end': shape({ id: int }),
  'xfer-need': shape({ id: int, missing: intArray(100_000) }),
  'xfer-done': shape({ id: int }),
  'xfer-query': shape({ id: int }),
  'xfer-unknown': shape({ id: int }),
  'xfer-cancel': shape({ id: int, reason: str(300) }),
};

const shooterShapes: Record<string, Check> = {
  hello: shape({ v: int, clientId: str(64), name: str(64), device: shape({ ua: str(400), mobile: bool }) }),
  ping: shape({ id: num, t0: num }),
  sync: shape({ offset: num, uncertainty: num, bestRtt: num, samples: int, full: bool }),
  'sync-failed': shape({ reason: str(300) }),
  status: shape({ camera: cameraShape }),
  report: shape({ report: reportShape }),
  bye: shape({}),
  ...transferShapes,
};

const hostShapes: Record<string, Check> = {
  welcome: shape({ v: int, room: str(16), settings: settingsShape, index: int, total: int }),
  reject: shape({ reason: str(300) }),
  pong: shape({ id: num, h1: num, h2: num }),
  lineup: shape({ index: int, total: int }),
  settings: shape({ settings: settingsShape }),
  'sync-request': shape({ full: bool }),
  countdown: shape({ captureId: str(64), target: num, mode: oneOf('moment', 'synctest') }),
  abort: shape({ captureId: str(64), reason: str(300) }),
  calibrate: shape({ latencyMs: num }),
  progress: shape({
    captureId: str(64),
    stage: oneOf('collecting', 'editing', 'rendering', 'sending', 'failed'),
    message: opt(str(300)),
  }),
  kick: shape({ reason: str(300) }),
  'room-closed': shape({}),
  ...transferShapes,
};

function parseWith<T>(shapes: Record<string, Check>, text: string): T | null {
  if (text.length > 1_000_000) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj(v)) return null;
  const t = (v as { t?: unknown }).t;
  if (typeof t !== 'string' || !Object.hasOwn(shapes, t)) return null;
  return shapes[t](v) ? (v as T) : null;
}

export const parseShooterMessage = (text: string) => parseWith<ShooterMessage>(shooterShapes, text);
export const parseHostMessage = (text: string) => parseWith<HostMessage>(hostShapes, text);

export function isTransferControl(m: { t: string }): m is TransferControl {
  return TRANSFER_CONTROL_TYPES.has(m.t);
}

/** Trim and bound a display name. */
export function cleanName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, 24);
  return trimmed || 'Shooter';
}
