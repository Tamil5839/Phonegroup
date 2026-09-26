/** Keep the screen on while a moment is being set up and captured. */
let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    /* denied (battery saver, unsupported): the app still works */
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => void acquire());
}

export function keepScreenOn(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else if (sentinel) {
    void sentinel.release();
    sentinel = null;
  }
}
