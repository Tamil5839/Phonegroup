/**
 * Countdown sounds and vibration. Beeps are scheduled on the audio clock so
 * they land on time; the host's "moment chirp" at T is what manual-mode
 * videos are matched on, so it is placed as precisely as the device allows
 * (compensating the audio output latency when the browser reports it).
 */
import { chirpSamples, MOMENT_CHIRP } from '../core/chirp';
import { localNow, localToPerf } from '../core/time';

type WebkitWindow = { webkitAudioContext?: typeof AudioContext };

class Sound {
  private ctx: AudioContext | null = null;
  private chirp: AudioBuffer | null = null;
  muted = false;

  /** Call from a tap at least once (browsers only allow audio after a gesture). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as WebkitWindow).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = silent;
      src.connect(this.ctx.destination);
      src.start();
    } catch {
      /* no audio: the countdown is still visual */
    }
  }

  get available(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** AudioContext time at which to start a sound so it is heard at local time `t`. */
  private contextTimeFor(t: number): number | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const perf = localToPerf(t);
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime && ts.performanceTime > 0 && typeof ts.contextTime === 'number') {
      return ts.contextTime + (perf - ts.performanceTime) / 1000;
    }
    const latency = (ctx as AudioContext & { outputLatency?: number }).outputLatency || ctx.baseLatency || 0;
    return ctx.currentTime + (perf - performance.now()) / 1000 - latency;
  }

  private beepAt(t: number, freq: number, dur: number, gain: number): void {
    const ctx = this.ctx;
    const at = this.contextTimeFor(t);
    if (!ctx || at === null || this.muted) return;
    const start = Math.max(ctx.currentTime, at);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.005);
    g.gain.setValueAtTime(gain, start + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.01);
  }

  private chirpAt(t: number): void {
    const ctx = this.ctx;
    const at = this.contextTimeFor(t);
    if (!ctx || at === null || this.muted) return;
    if (!this.chirp || this.chirp.sampleRate !== ctx.sampleRate) {
      const samples = chirpSamples(MOMENT_CHIRP, ctx.sampleRate, 0.95);
      this.chirp = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      this.chirp.copyToChannel(samples, 0);
    }
    const src = ctx.createBufferSource();
    src.buffer = this.chirp;
    src.connect(ctx.destination);
    src.start(Math.max(ctx.currentTime, at));
  }

  /**
   * Beep at T−3 s, T−2 s, T−1 s and mark T itself (the host plays the chirp,
   * shooters a soft tick). Each sound is scheduled shortly before it is due,
   * using a fresh reading of the audio clock. Returns a cancel function.
   */
  scheduleCountdown(targetLocal: number, opts: { chirp: boolean; vibrate?: boolean }): () => void {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const events: { t: number; kind: 'beep' | 'moment' }[] = [
      { t: targetLocal - 3000, kind: 'beep' },
      { t: targetLocal - 2000, kind: 'beep' },
      { t: targetLocal - 1000, kind: 'beep' },
      { t: targetLocal, kind: 'moment' },
    ];
    for (const ev of events) {
      const lead = ev.t - localNow();
      if (lead < 0) continue;
      timers.push(
        setTimeout(
          () => {
            if (ev.kind === 'beep') this.beepAt(ev.t, 880, 0.09, 0.22);
            else if (opts.chirp) this.chirpAt(ev.t);
            else this.beepAt(ev.t, 1760, 0.05, 0.12);
          },
          Math.max(0, lead - 350),
        ),
      );
      if (opts.vibrate !== false && 'vibrate' in navigator) {
        timers.push(setTimeout(() => navigator.vibrate?.(ev.kind === 'moment' ? 120 : 40), Math.max(0, lead)));
      }
    }
    return () => timers.forEach(clearTimeout);
  }

  /** Play the chirp once now (used to test the speaker in manual mode). */
  testChirp(): void {
    this.unlock();
    this.chirpAt(localNow() + 150);
  }
}

export const sound = new Sound();
