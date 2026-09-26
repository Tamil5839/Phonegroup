import { signal } from '@preact/signals';
import { normalizeRoomCode } from '../core/roomCode';

export type Route =
  | { name: 'home' }
  | { name: 'host' }
  | { name: 'join'; code: string | null }
  | { name: 'manual-host' }
  | { name: 'manual-shoot'; code: string; moment: number; epoch: number | null }
  | { name: 'help' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'host':
      return { name: 'host' };
    case 'j':
    case 'join':
      return { name: 'join', code: parts[1] ? normalizeRoomCode(decodeURIComponent(parts[1])) : null };
    case 'manual':
      return { name: 'manual-host' };
    case 'm': {
      const code = normalizeRoomCode(parts[1] ?? '') ?? 'MANUAL';
      const moment = parseInt(parts[2] ?? '', 36);
      const epoch = parts[3] ? parseInt(parts[3], 36) : NaN;
      if (!Number.isFinite(moment)) return { name: 'home' };
      return { name: 'manual-shoot', code, moment, epoch: Number.isFinite(epoch) ? epoch : null };
    }
    case 'help':
      return { name: 'help' };
    default:
      return { name: 'home' };
  }
}

export const route = signal<Route>(parseHash(typeof location !== 'undefined' ? location.hash : ''));

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.value = parseHash(location.hash);
    window.scrollTo(0, 0);
  });
}

export function navigate(path: string): void {
  location.hash = path;
}

/** Absolute URL of a route inside this app (works on any static host/sub-path). */
export function appUrl(hashPath: string): string {
  return `${location.origin}${location.pathname}#${hashPath}`;
}

export function joinUrl(code: string): string {
  return appUrl(`/j/${code}`);
}

export function manualUrl(code: string, moment: number, epoch: number): string {
  return appUrl(`/m/${code}/${Math.round(moment).toString(36)}/${Math.round(epoch).toString(36)}`);
}
