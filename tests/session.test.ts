import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectAround } from '../src/core/frames';
import { createMemoryLinkPair, type Link, type MemoryLinkOptions } from '../src/core/link';
import { HostSession } from '../src/session/host';
import { ShooterSession } from '../src/session/shooter';
import type { CaptureDevice, CaptureRequest, CapturedFrames } from '../src/session/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A simulated camera: frames arrive every 1000/fps ms of *real* time, each
 * stamped with the phone's own clock. It picks frames exactly like the real
 * rolling buffer does and "encodes" the true capture time into the payload so
 * the test can check what was really captured.
 */
class FakeCamera implements CaptureDevice {
  constructor(
    private readonly localClock: () => number,
    private readonly offset: number,
    private readonly fps = 30,
    private readonly phase = Math.random() * 33,
    private readonly payloadBytes = 40_000,
  ) {}

  async capture(req: CaptureRequest): Promise<CapturedFrames> {
    const interval = 1000 / this.fps;
    const localTarget = req.toLocal(req.target);
    const deadline = localTarget + 3.5 * interval + 60;
    await new Promise((r) => setTimeout(r, Math.max(0, deadline - this.localClock())));
    const now = Date.now();
    const frames: { hostTime: number; trueTime: number }[] = [];
    for (let t = Math.floor((now - 1500) / interval) * interval + this.phase; t <= now; t += interval) {
      frames.push({ trueTime: t, hostTime: req.toHost(t + this.offset) });
    }
    const sel = selectAround(frames, req.target, 3)!;
    const body = (label: string, trueTime: number) => {
      const head = enc.encode(JSON.stringify({ label, trueTime }) + '\n');
      const out = new Uint8Array(this.payloadBytes);
      out.set(head);
      return out;
    };
    return {
      report: {
        captureId: req.captureId,
        ok: true,
        errorMs: sel.errorMs,
        intervalMs: interval,
        timestampSource: 'synthetic',
        neighbors: sel.neighborOffsets,
      },
      main: body('main', frames[sel.chosen].trueTime),
      neighbors: sel.neighbors.map((i, k) => ({ offset: sel.neighborOffsets[k], data: body('n', frames[i].trueTime).slice(0, 5000) })),
    };
  }
}

function readTrueTime(data: Uint8Array): number {
  const text = dec.decode(data.slice(0, 200)).split('\n')[0];
  return JSON.parse(text).trueTime;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

interface Rig {
  host: HostSession;
  hostOffset: number;
  shooters: { session: ShooterSession; offset: number; links: Link[] }[];
}

function makeRig(n: number, net: (i: number) => [MemoryLinkOptions, MemoryLinkOptions], seed = 1): Rig {
  const rand = rng(seed);
  const hostOffset = (rand() - 0.5) * 1e6;
  const host = new HostSession('ABC123', () => Date.now() + hostOffset);
  const shooters: Rig['shooters'] = [];
  for (let i = 0; i < n; i++) {
    const offset = (rand() - 0.5) * 1e6;
    const clock = () => Date.now() + offset;
    const links: Link[] = [];
    const session = new ShooterSession({
      clock,
      clientId: `client-${i}`,
      name: `Shooter ${i + 1}`,
      deviceInfo: { ua: 'test', mobile: true },
      device: new FakeCamera(clock, offset, 30, rand() * 33),
      lobbySyncMs: 0,
      reconnectDelaysMs: [200, 400, 800, 1600],
      connect: async () => {
        const [up, down] = net(i);
        const [s, h] = createMemoryLinkPair(up, down);
        links.push(s);
        host.addConnection(h);
        return s;
      },
    });
    shooters.push({ session, offset, links });
  }
  return { host, hostOffset, shooters };
}

async function joinAll(rig: Rig) {
  const joins = rig.shooters.map((s) => s.session.start());
  await vi.advanceTimersByTimeAsync(3000);
  await Promise.all(joins);
}

describe('host and shooters end to end (simulated)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('joins, syncs, counts down and captures the same instant on every phone', async () => {
    const rand = rng(9);
    const rig = makeRig(5, () => [
      { latencyMs: () => 3 + rand() * 12, rng: rand },
      { latencyMs: () => 3 + rand() * 12, rng: rand },
    ]);
    await joinAll(rig);
    expect(rig.host.shooters.value).toHaveLength(5);
    // Join order follows network timing; every phone is placed exactly once.
    expect([...rig.host.order.value].sort()).toEqual(['client-0', 'client-1', 'client-2', 'client-3', 'client-4']);
    rig.host.setOrder(['client-0', 'client-1', 'client-2', 'client-3', 'client-4']);
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.shooters.map((s) => s.session.lineup.value?.index)).toEqual([1, 2, 3, 4, 5]);
    expect(rig.shooters.every((s) => s.session.phase.value === 'lobby')).toBe(true);

    // Reorder: the lineup reaches the phones.
    rig.host.setOrder(['client-4', 'client-3', 'client-2', 'client-1', 'client-0']);
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.shooters[4].session.lineup.value).toEqual({ index: 1, total: 5 });

    const started = rig.host.startCapture('moment');
    await vi.advanceTimersByTimeAsync(4500);
    const run = await started;
    expect(rig.host.phase.value).toBe('countdown');
    expect(rig.shooters.every((s) => s.session.phase.value === 'countdown')).toBe(true);
    for (const s of rig.shooters) {
      // Each phone shows the countdown for the same host instant, on its own clock.
      expect(s.session.countdown.value!.targetLocal - s.offset).toBeCloseTo(run.target - rig.hostOffset, -1);
    }

    await vi.advanceTimersByTimeAsync(run.target - (Date.now() + rig.hostOffset) + 6000);
    expect(rig.host.phase.value).toBe('review');
    const trueT = run.target - rig.hostOffset;
    for (const f of Object.values(rig.host.frames.value)) {
      expect(f.status).toBe('done');
      const err = readTrueTime(f.main!) - trueT;
      // Within half a frame interval plus clock-sync error.
      expect(Math.abs(err)).toBeLessThan(1000 / 30 / 2 + 8);
      expect(Math.abs(f.report!.errorMs!)).toBeLessThan(1000 / 30 / 2 + 1);
      expect(Object.keys(f.neighbors).length).toBe(6);
    }
    expect(rig.shooters.every((s) => s.session.phase.value === 'waiting')).toBe(true);

    // The finished clip goes back to everyone.
    const clip = new Uint8Array(150_000).map((_, i) => i % 251);
    const delivered = rig.host.sendResult(clip, { mime: 'video/mp4', name: 'frozen-moment.mp4' });
    await vi.advanceTimersByTimeAsync(3000);
    await delivered;
    for (const s of rig.shooters) {
      expect(s.session.phase.value).toBe('result');
      expect(s.session.result.value!.data).toEqual(clip);
      expect(s.session.result.value!.mime).toBe('video/mp4');
    }
    expect(Object.values(rig.host.delivery.value).every((d) => d.state === 'done')).toBe(true);
  });

  it('continues without a phone that never delivers, after 20 s', async () => {
    const rig = makeRig(3, (i) => [i === 2 ? { latencyMs: 5, bytesPerMs: 0.5 } : { latencyMs: 5 }, { latencyMs: 5 }]);
    await joinAll(rig);
    const started = rig.host.startCapture();
    await vi.advanceTimersByTimeAsync(5000);
    const run = await started;
    await vi.advanceTimersByTimeAsync(run.target - (Date.now() + rig.hostOffset) + 3000);
    expect(rig.host.phase.value).toBe('collecting');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rig.host.phase.value).toBe('review');
    const frames = rig.host.frames.value;
    expect(frames['client-0'].status).toBe('done');
    expect(frames['client-2'].status).toBe('missing');
    expect(rig.host.notice.value).toMatch(/Shooter 3/);
  });

  it('resumes a transfer after the connection drops and reconnects', async () => {
    // A slow uplink so the frame is still in flight when we cut the connection.
    const rig = makeRig(1, () => [
      { latencyMs: 5, bytesPerMs: 20, ordered: true },
      { latencyMs: 5, ordered: true },
    ]);
    await joinAll(rig);
    const started = rig.host.startCapture();
    await vi.advanceTimersByTimeAsync(5000);
    const run = await started;
    await vi.advanceTimersByTimeAsync(run.target - (Date.now() + rig.hostOffset) + 1200);
    const shooter = rig.shooters[0];
    expect(shooter.session.phase.value).toBe('sending');
    expect(rig.host.frames.value['client-0'].status).toBe('receiving');

    shooter.links[0].close();
    await vi.advanceTimersByTimeAsync(50);
    expect(shooter.session.phase.value).toBe('reconnecting');
    expect(rig.host.shooters.value[0].connected).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(shooter.links.length).toBeGreaterThanOrEqual(2);
    expect(rig.host.shooters.value[0].connected).toBe(true);
    expect(rig.host.frames.value['client-0'].status).toBe('done');
    expect(shooter.session.phase.value).toBe('waiting');
  });

  it('lets the host cancel a countdown', async () => {
    const rig = makeRig(2, () => [{ latencyMs: 4 }, { latencyMs: 4 }]);
    await joinAll(rig);
    const started = rig.host.startCapture();
    await vi.advanceTimersByTimeAsync(4500);
    await started;
    rig.host.abortCapture();
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.host.phase.value).toBe('lobby');
    expect(rig.shooters.every((s) => s.session.phase.value === 'lobby')).toBe(true);
  });

  it('refuses joins with a different protocol version and when locked', async () => {
    const host = new HostSession('ROOM01', () => Date.now());
    host.locked.value = true;
    const s = new ShooterSession({
      clock: () => Date.now(),
      clientId: 'x1',
      name: 'Late',
      deviceInfo: { ua: 't', mobile: false },
      device: new FakeCamera(() => Date.now(), 0),
      lobbySyncMs: 0,
      connect: async () => {
        const [a, b] = createMemoryLinkPair({ latencyMs: 2 }, { latencyMs: 2 });
        host.addConnection(b);
        return a;
      },
    });
    const joined = s.start();
    const assertion = expect(joined).rejects.toThrow(/closed the room/);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('kicks a shooter and closes the room', async () => {
    const rig = makeRig(2, () => [{ latencyMs: 2 }, { latencyMs: 2 }]);
    await joinAll(rig);
    rig.host.kick('client-1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.shooters[1].session.phase.value).toBe('ended');
    expect(rig.host.order.value).toEqual(['client-0']);
    expect(rig.shooters[0].session.lineup.value).toEqual({ index: 1, total: 1 });
    rig.host.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.shooters[0].session.phase.value).toBe('ended');
    expect(rig.shooters[0].session.endedReason.value).toMatch(/ended/);
  });
});
