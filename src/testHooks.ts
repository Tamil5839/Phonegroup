/**
 * Only included in end-to-end test builds (VITE_E2E=1): exposes a few
 * internals so the browser tests can exercise them directly.
 */
import { chirpSamples, MOMENT_CHIRP } from './core/chirp';
import { buildTimeline } from './core/sequence';
import { encodeWithMediabunny, exportClip } from './process/export';
import { importFiles } from './process/importMedia';
import { createRenderer } from './process/renderer';
import { readTimecode } from './process/timecodeReader';

declare global {
  interface Window {
    __fmTest?: Record<string, unknown>;
  }
}

window.__fmTest = {
  readTimecode,
  exportClip,
  encodeWithMediabunny,
  createRenderer,
  buildTimeline,
  importFiles,
  chirpSamples,
  MOMENT_CHIRP,
};
