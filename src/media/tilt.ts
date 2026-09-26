/**
 * Level indicator from the accelerometer (gravity vector). Reports how far
 * the phone is rolled away from the nearest upright orientation (portrait or
 * landscape), in degrees, clockwise positive as seen from behind the screen.
 * The result does not depend on the sign convention of the platform
 * (iOS reports gravity with the opposite sign to Android).
 */
import { signal } from '@preact/signals-core';
import { localNow } from '../core/time';

export function rollFromGravity(ax: number, ay: number, az: number): number | null {
  const planar = Math.hypot(ax, ay);
  // Phone lying flat (camera pointing at floor or ceiling): roll is meaningless.
  if (planar < 0.35 * Math.hypot(ax, ay, az) || planar < 2) return null;
  const angle = (Math.atan2(ax, ay) * 180) / Math.PI;
  const deviation = angle - 90 * Math.round(angle / 90);
  // Rolling the phone clockwise by φ turns gravity's in-screen angle by −φ.
  return -deviation;
}

type MotionPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };

export class TiltSensor {
  readonly roll = signal<number | null>(null);
  private history: { t: number; roll: number }[] = [];
  private listening = false;
  private smoothed: number | null = null;

  private onMotion = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null || g.z === null) return;
    const r = rollFromGravity(g.x, g.y, g.z);
    if (r === null) {
      this.smoothed = null;
      this.roll.value = null;
      return;
    }
    this.smoothed = this.smoothed === null ? r : this.smoothed + 0.25 * (r - this.smoothed);
    this.roll.value = this.smoothed;
    const t = localNow();
    this.history.push({ t, roll: this.smoothed });
    while (this.history.length > 0 && this.history[0].t < t - 4000) this.history.shift();
  };

  /** iOS needs an explicit permission request from a tap. Safe to call anywhere. */
  async requestPermission(): Promise<boolean> {
    const ctor = (globalThis as { DeviceMotionEvent?: MotionPermission }).DeviceMotionEvent;
    if (ctor?.requestPermission) {
      try {
        return (await ctor.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    }
    return typeof DeviceMotionEvent !== 'undefined';
  }

  start(): void {
    if (this.listening || typeof window === 'undefined') return;
    window.addEventListener('devicemotion', this.onMotion);
    this.listening = true;
  }

  stop(): void {
    window.removeEventListener('devicemotion', this.onMotion);
    this.listening = false;
  }

  /** Roll reading closest to a local time (for the moment of capture). */
  rollAt(localTime: number): number | null {
    let best: { t: number; roll: number } | null = null;
    for (const h of this.history) if (!best || Math.abs(h.t - localTime) < Math.abs(best.t - localTime)) best = h;
    return best && Math.abs(best.t - localTime) < 500 ? best.roll : this.roll.value;
  }
}

export const tilt = new TiltSensor();
