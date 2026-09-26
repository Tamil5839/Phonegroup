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

/** The host's room code, kept for this tab so a reload can reclaim it (for two hours). */
export function recentRoomCode(): string | null {
  try {
    const raw = sessionStorage.getItem('fm.room');
    if (!raw) return null;
    const { code, at } = JSON.parse(raw) as { code: string; at: number };
    return typeof code === 'string' && Date.now() - at < 2 * 3600_000 ? code : null;
  } catch {
    return null;
  }
}

export function rememberRoomCode(code: string): void {
  try {
    sessionStorage.setItem('fm.room', JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function forgetRoomCode(): void {
  try {
    sessionStorage.removeItem('fm.room');
  } catch {
    /* ignore */
  }
}
