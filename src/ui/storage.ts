/** Small per-device preferences. Storage can be unavailable (private mode): everything degrades gracefully. */
import { randomId } from '../core/ids';

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

let memoryClientId: string | null = null;

/** Stable ID for this phone, so a dropped connection rejoins as the same shooter. */
export function clientId(): string {
  let id = get('fm.clientId');
  if (!id) {
    id = memoryClientId ?? randomId(16);
    memoryClientId = id;
    set('fm.clientId', id);
  }
  return id;
}

export function savedName(): string {
  return get('fm.name') ?? '';
}

export function saveName(name: string): void {
  set('fm.name', name);
}

/** Camera timing correction from Sync Test Mode (ms, subtracted from frame timestamps). */
export function latencyCorrection(): number {
  const v = Number(get('fm.latencyCorrection'));
  return Number.isFinite(v) ? Math.max(-300, Math.min(300, v)) : 0;
}

export function setLatencyCorrection(ms: number): void {
  set('fm.latencyCorrection', String(Math.round(ms * 10) / 10));
}
