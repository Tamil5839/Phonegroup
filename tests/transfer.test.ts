import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from '../src/core/crc32';
import { createMemoryLinkPair, type Link, type MemoryLinkOptions } from '../src/core/link';
import { decodeChunk, encodeChunk, TransferEndpoint, type TransferControl, type TransferPort } from '../src/core/transfer';

const enc = new TextEncoder();

describe('crc32', () => {
  it('matches known vectors', () => {
    expect(crc32(enc.encode(''))).toBe(0);
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('can be computed incrementally', () => {
    const a = enc.encode('hello ');
    const b = enc.encode('world');
    expect(crc32(b, crc32(a))).toBe(crc32(enc.encode('hello world')));
  });
});

describe('chunk framing', () => {
  it('round-trips and detects corruption', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const buf = encodeChunk(77, 3, payload);
    const d = decodeChunk(buf)!;
    expect(d.id).toBe(77);
    expect(d.index).toBe(3);
    expect(d.valid).toBe(true);
    expect([...d.payload]).toEqual([1, 2, 3, 4, 5]);
    new Uint8Array(buf)[15] ^= 0x40;
    expect(decodeChunk(buf)!.valid).toBe(false);
    expect(decodeChunk(new ArrayBuffer(4))).toBeNull();
  });
});

function portFor(link: Link): TransferPort {
  return {
    sendControl: (m: TransferControl) => link.send(JSON.stringify(m)),
    sendBinary: (b) => link.send(b),
    bufferedAmount: () => link.bufferedAmount(),
    isOpen: () => link.isOpen(),
  };
}

function wire(endpoint: TransferEndpoint, link: Link) {
  link.onMessage((data) => {
    if (typeof data === 'string') endpoint.handleControl(JSON.parse(data));
    else endpoint.handleBinary(data);
  });
  endpoint.attach(portFor(link));
}

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function setup(ab: MemoryLinkOptions = {}, ba: MemoryLinkOptions = {}, opts = {}) {
  const sender = new TransferEndpoint({ chunkSize: 1024, ackTimeoutMs: 500, ...opts });
  const receiver = new TransferEndpoint({ chunkSize: 1024, ackTimeoutMs: 500, ...opts });
  const [a, b] = createMemoryLinkPair(ab, ba);
  wire(sender, a);
  wire(receiver, b);
  const received: { meta: unknown; data: Uint8Array }[] = [];
  receiver.incomingComplete.on((rx, data) => received.push({ meta: rx.meta, data }));
  return { sender, receiver, a, b, received };
}

describe('TransferEndpoint', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('delivers a file in chunks with progress', async () => {
    const { sender, receiver, received } = setup({ latencyMs: 2, ordered: true }, { latencyMs: 2, ordered: true });
    const data = randomBytes(50_000);
    const progress: number[] = [];
    receiver.incomingProgress.on((rx) => progress.push(rx.progress));
    const tx = sender.send(data, { kind: 'frame', captureId: 'c1' });
    await vi.advanceTimersByTimeAsync(2000);
    await tx.done;
    expect(tx.state).toBe('done');
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual(data);
    expect(received[0].meta).toMatchObject({ kind: 'frame', captureId: 'c1' });
    expect(progress.length).toBe(49);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('handles empty and exact-multiple sizes', async () => {
    const { sender, received } = setup();
    const a = sender.send(new Uint8Array(0), { kind: 'empty' });
    const b = sender.send(randomBytes(4096, 3), { kind: 'exact' });
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([a.done, b.done]);
    expect(received.map((r) => r.data.length)).toEqual([0, 4096]);
  });

  it('recovers from corrupted chunks by asking for them again', async () => {
    let seed = 99;
    const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const { sender, receiver, received } = setup({ corruptRate: 0.2, rng }, {});
    const data = randomBytes(64 * 1024, 7);
    let corrupt = 0;
    receiver.incomingStarted.on((rx) => {
      const id = setInterval(() => (corrupt = rx.corruptChunks), 1);
      setTimeout(() => clearInterval(id), 4000);
    });
    const tx = sender.send(data, { kind: 'frame' });
    await vi.advanceTimersByTimeAsync(5000);
    await tx.done;
    expect(received[0].data).toEqual(data);
    expect(tx.rounds).toBeGreaterThan(0);
    expect(corrupt).toBeGreaterThan(0);
  });

  it('retries when messages are lost', async () => {
    let seed = 5;
    const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const { sender, received } = setup({ dropRate: 0.15, rng }, { dropRate: 0.15, rng });
    const data = randomBytes(40 * 1024, 11);
    const tx = sender.send(data, { kind: 'frame' });
    await vi.advanceTimersByTimeAsync(30_000);
    await tx.done;
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual(data);
  });

  it('resumes after the connection drops mid-transfer, resending only what is missing', async () => {
    const sender = new TransferEndpoint({ chunkSize: 1024, ackTimeoutMs: 500 });
    const receiver = new TransferEndpoint({ chunkSize: 1024, ackTimeoutMs: 500 });
    const received: Uint8Array[] = [];
    receiver.incomingComplete.on((_rx, d) => received.push(d));

    // Slow link: ~20 KB/s so we can cut it halfway.
    const [a1, b1] = createMemoryLinkPair({ bytesPerMs: 20, ordered: true }, { ordered: true });
    wire(sender, a1);
    wire(receiver, b1);
    let chunksSeen = 0;
    b1.onMessage((d) => {
      if (typeof d !== 'string') chunksSeen++;
    });
    const data = randomBytes(100 * 1024, 21);
    const tx = sender.send(data, { kind: 'frame' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(chunksSeen).toBeGreaterThan(10);
    expect(chunksSeen).toBeLessThan(100);

    a1.close();
    sender.detach();
    receiver.detach();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tx.state).toBe('paused');

    const [a2, b2] = createMemoryLinkPair({ ordered: true, latencyMs: 1 }, { ordered: true, latencyMs: 1 });
    let resent = 0;
    b2.onMessage((d) => {
      if (typeof d !== 'string') resent++;
    });
    wire(sender, a2);
    wire(receiver, b2);
    await vi.advanceTimersByTimeAsync(3000);
    await tx.done;
    expect(received[0]).toEqual(data);
    expect(resent).toBe(100 - chunksSeen);
  });

  it('fails cleanly when the receiver disappears for good', async () => {
    const { sender, b } = setup({}, {}, { ackTimeoutMs: 200, maxQueries: 3 });
    // The receiver stops answering but the link stays up.
    b.onMessage(() => {});
    const data = randomBytes(2048);
    const [a2] = createMemoryLinkPair({ dropRate: 1 }, {});
    sender.detach();
    sender.attach(portFor(a2));
    const tx = sender.send(data, { kind: 'frame' });
    const assertion = expect(tx.done).rejects.toThrow(/stopped answering/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(tx.state).toBe('failed');
  });

  it('does not deliver the same file twice when acks are lost', async () => {
    let n = 0;
    // Drop the first two xfer-done messages coming back.
    const { sender, received, b } = setup();
    const origSend = b.send.bind(b);
    b.send = (d) => {
      if (typeof d === 'string' && d.includes('xfer-done') && n++ < 2) return;
      origSend(d);
    };
    const tx = sender.send(randomBytes(3000), { kind: 'frame' });
    await vi.advanceTimersByTimeAsync(5000);
    await tx.done;
    expect(received).toHaveLength(1);
  });

  it('limits how many unfinished transfers one phone can open', async () => {
    const { receiver, a } = setup();
    const started: unknown[] = [];
    receiver.incomingStarted.on((rx) => started.push(rx));
    for (let id = 1; id <= 40; id++) {
      a.send(JSON.stringify({ t: 'xfer-begin', id, size: 10, chunkSize: 1024, count: 1, crc: 0, meta: { kind: 'x' } }));
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toHaveLength(32);
  });

  it('rejects oversized or malformed transfers', async () => {
    const { receiver, a } = setup();
    const started: unknown[] = [];
    receiver.incomingStarted.on((rx) => started.push(rx));
    a.send(JSON.stringify({ t: 'xfer-begin', id: 1, size: 1e12, chunkSize: 1024, count: 1e9, crc: 0, meta: { kind: 'x' } }));
    a.send(JSON.stringify({ t: 'xfer-begin', id: 2, size: 100, chunkSize: 1024, count: 5, crc: 0, meta: { kind: 'x' } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toHaveLength(0);
  });
});
