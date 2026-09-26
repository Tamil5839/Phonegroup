import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bus } from '../src/core/bus';
import { answerPing, estimateOffset, runClockSync, sampleOffset, type SyncTransport } from '../src/core/clockSync';
import { createMemoryLinkPair, type MemoryLinkOptions } from '../src/core/link';
import { parseHostMessage, parseShooterMessage, type HostMessage, type ShooterMessage } from '../src/core/protocol';

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sampleOffset / estimateOffset', () => {
  it('recovers the offset exactly with symmetric delays', () => {
    // shooter clock = true time; host clock = true time + 1000
    const s = { t0: 0, h1: 1000 + 5, h2: 1000 + 5, t1: 10 };
    expect(sampleOffset(s)).toEqual({ offset: 1000, rtt: 10 });
  });

  it('subtracts host processing time from the round trip', () => {
    const s = { t0: 0, h1: 1005, h2: 1007, t1: 12 };
    expect(sampleOffset(s).rtt).toBe(10);
    expect(sampleOffset(s).offset).toBe(1000);
  });

  it('prefers the fastest exchanges', () => {
    const samples = [
      { t0: 0, h1: 505, h2: 505, t1: 10 }, // offset 500, rtt 10
      { t0: 0, h1: 505, h2: 505, t1: 12 }, // offset 499, rtt 12
      { t0: 0, h1: 590, h2: 590, t1: 200 }, // slow and asymmetric: offset 490, rtt 200
      { t0: 0, h1: 510, h2: 510, t1: 20 }, // offset 500, rtt 20
      { t0: 0, h1: 506, h2: 506, t1: 12 }, // offset 500, rtt 12
    ];
    const est = estimateOffset(samples, { keepFraction: 0.6, minKeep: 3 })!;
    expect(est.offset).toBe(500);
    expect(est.bestRtt).toBe(10);
    expect(est.uncertainty).toBe(5);
    expect(est.used).toBe(3);
  });
});

/** A shooter/host pair on simulated clocks connected by a simulated network. */
function simulate(opts: { hostOffset: number; shooterOffset: number; up: MemoryLinkOptions; down: MemoryLinkOptions; drift?: number }) {
  const start = Date.now();
  // Real time is the fake-timer clock; each device adds its own offset (and optional drift).
  const hostClock = () => Date.now() + opts.hostOffset;
  const shooterClock = () => {
    const t = Date.now();
    return t + opts.shooterOffset + (opts.drift ?? 0) * (t - start);
  };
  const [shooterLink, hostLink] = createMemoryLinkPair(opts.up, opts.down);
  const hostBus = new Bus<ShooterMessage, HostMessage>(parseShooterMessage, hostClock);
  const shooterBus = new Bus<HostMessage, ShooterMessage>(parseHostMessage, shooterClock);
  hostBus.attach(hostLink);
  shooterBus.attach(shooterLink);
  hostBus.on('ping', (m, receivedAt) => {
    hostBus.send({ t: 'pong', ...answerPing(m.id, receivedAt, hostClock) });
  });
  const transport: SyncTransport = {
    sendPing: (id, t0) => shooterBus.send({ t: 'ping', id, t0 }),
    onPong: (cb) => shooterBus.on('pong', (m) => cb(m.id, m.h1, m.h2)),
  };
  const trueOffset = opts.hostOffset - opts.shooterOffset;
  return { transport, shooterClock, trueOffset };
}

describe('runClockSync over a simulated network', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  const scenarios = [
    { name: 'quiet LAN', base: 2, jitter: 3, spikes: 0 },
    { name: 'busy Wi-Fi', base: 4, jitter: 25, spikes: 0.1 },
    { name: 'power-saving radios', base: 3, jitter: 10, spikes: 0.3 },
  ];

  for (const sc of scenarios) {
    it(`estimates the offset within tolerance on ${sc.name}`, async () => {
      for (let seed = 1; seed <= 20; seed++) {
        const rng = mulberry32(seed * 7919 + sc.base);
        const delay = () => sc.base + rng() * sc.jitter + (rng() < sc.spikes ? 40 + rng() * 120 : 0);
        const hostOffset = (rng() - 0.5) * 1e7;
        const shooterOffset = (rng() - 0.5) * 1e7;
        const sim = simulate({
          hostOffset,
          shooterOffset,
          up: { latencyMs: delay, rng },
          down: { latencyMs: delay, rng },
        });
        const p = runClockSync(sim.transport, sim.shooterClock, { count: 32, intervalMs: 25 });
        await vi.advanceTimersByTimeAsync(5000);
        const est = await p;
        const err = Math.abs(est.offset - sim.trueOffset);
        // The error can never exceed half the best round trip; in practice it is far smaller.
        expect(err).toBeLessThanOrEqual(est.uncertainty + 1);
        expect(err).toBeLessThan(sc.jitter / 2 + 2);
        expect(est.samples).toBeGreaterThanOrEqual(30);
      }
    });
  }

  it('reports an uncertainty that bounds the error even for asymmetric links', async () => {
    // 2 ms up, 20 ms down: the asymmetry is invisible to NTP; the bound must still hold.
    const sim = simulate({ hostOffset: 5000, shooterOffset: -300, up: { latencyMs: 2 }, down: { latencyMs: 20 } });
    const p = runClockSync(sim.transport, sim.shooterClock);
    await vi.advanceTimersByTimeAsync(5000);
    const est = await p;
    const err = Math.abs(est.offset - sim.trueOffset);
    expect(err).toBeCloseTo(9, 0);
    expect(err).toBeLessThanOrEqual(est.uncertainty);
  });

  it('survives lost pings', async () => {
    const rng = mulberry32(42);
    const sim = simulate({
      hostOffset: 123456,
      shooterOffset: 0,
      up: { latencyMs: () => 3 + rng() * 5, dropRate: 0.3, rng },
      down: { latencyMs: () => 3 + rng() * 5, dropRate: 0.3, rng },
    });
    const p = runClockSync(sim.transport, sim.shooterClock, { count: 40 });
    await vi.advanceTimersByTimeAsync(5000);
    const est = await p;
    expect(Math.abs(est.offset - sim.trueOffset)).toBeLessThan(3);
    expect(est.samples).toBeLessThan(40);
  });

  it('fails clearly when the host never answers', async () => {
    const sim = simulate({ hostOffset: 0, shooterOffset: 0, up: { dropRate: 1 }, down: {} });
    const p = runClockSync(sim.transport, sim.shooterClock);
    const assertion = expect(p).rejects.toThrow(/sync replies/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('keeps drift small over a countdown after syncing', async () => {
    // 50 ppm drift: after a 3.5 s countdown the extra error stays well below a video frame.
    const sim = simulate({ hostOffset: 0, shooterOffset: 0, up: { latencyMs: 3 }, down: { latencyMs: 3 }, drift: 50e-6 });
    const p = runClockSync(sim.transport, sim.shooterClock);
    await vi.advanceTimersByTimeAsync(3000);
    const est = await p;
    await vi.advanceTimersByTimeAsync(3500);
    const hostNow = Date.now();
    const predicted = sim.shooterClock() + est.offset;
    expect(Math.abs(predicted - hostNow)).toBeLessThan(1);
  });
});
