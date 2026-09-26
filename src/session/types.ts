import type { CaptureMode, CaptureReport } from '../core/protocol';

export interface CaptureRequest {
  captureId: string;
  mode: CaptureMode;
  /** The moment T, in host time. */
  target: number;
  /** Local clock → host time. */
  toHost: (local: number) => number;
  /** Host time → local clock. */
  toLocal: (host: number) => number;
  syncUncertainty: number;
  signal?: AbortSignal;
}

export interface CapturedFrames {
  report: CaptureReport;
  /** JPEG of the frame closest to T (full resolution). */
  main: Uint8Array | null;
  /** Lower-resolution JPEGs of the frames around it. */
  neighbors: { offset: number; data: Uint8Array }[];
}

/**
 * Something that can deliver the camera frame nearest to a moment in host
 * time. The browser implementation keeps a rolling buffer of camera frames;
 * tests use a simulated camera.
 */
export interface CaptureDevice {
  capture(req: CaptureRequest): Promise<CapturedFrames>;
}
