/**
 * A Link is one bidirectional message pipe between two phones (in practice a
 * WebRTC data channel). Protocol code only talks to this interface, so it can
 * be exercised in unit tests with simulated latency, loss and disconnects.
 */
export type WireData = string | ArrayBuffer;

export interface Link {
  readonly id: string;
  send(data: WireData): void;
  /** Bytes queued but not yet handed to the network (for flow control). */
  bufferedAmount(): number;
  isOpen(): boolean;
  onMessage(cb: (data: WireData) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

/** Minimal listener set used by Link implementations. */
export class Emitter<T extends unknown[]> {
  private listeners = new Set<(...args: T) => void>();
  on(cb: (...args: T) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(...args: T): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(err);
      }
    }
  }
  clear(): void {
    this.listeners.clear();
  }
  get size(): number {
    return this.listeners.size;
  }
}

export interface MemoryLinkOptions {
  /** One-way delay in ms (number or generator). */
  latencyMs?: number | (() => number);
  /** Probability that a message silently disappears. */
  dropRate?: number;
  /** Probability that one byte of a binary message is flipped. */
  corruptRate?: number;
  /** Keep delivery order even when latency jitters (like a reliable ordered channel). */
  ordered?: boolean;
  rng?: () => number;
  /** Simulated throughput; adds size/bytesPerMs to the delay and to bufferedAmount. */
  bytesPerMs?: number;
}

interface Direction {
  opts: MemoryLinkOptions;
  lastDelivery: number;
  /** When the simulated wire finishes sending what is already queued. */
  busyUntil: number;
  queued: number;
}

let memoryLinkCounter = 0;

class MemoryLink implements Link {
  readonly id: string;
  peer!: MemoryLink;
  open = true;
  readonly messages = new Emitter<[WireData]>();
  readonly closes = new Emitter<[]>();

  constructor(
    id: string,
    private readonly dir: Direction,
  ) {
    this.id = id;
  }

  send(data: WireData): void {
    if (!this.open) throw new Error('link closed');
    const { opts } = this.dir;
    const rng = opts.rng ?? Math.random;
    if (opts.dropRate && rng() < opts.dropRate) return;
    let payload: WireData = data;
    if (typeof data !== 'string') {
      payload = data.slice(0);
      if (opts.corruptRate && rng() < opts.corruptRate && payload.byteLength > 0) {
        const view = new Uint8Array(payload);
        const at = Math.floor(rng() * view.length);
        view[at] ^= 0xff;
      }
    }
    const size = typeof payload === 'string' ? payload.length : payload.byteLength;
    const base = typeof opts.latencyMs === 'function' ? opts.latencyMs() : (opts.latencyMs ?? 0);
    const now = Date.now();
    let sentAt = now;
    if (opts.bytesPerMs) {
      // Messages leave one after another at the simulated throughput.
      sentAt = Math.max(now, this.dir.busyUntil) + size / opts.bytesPerMs;
      this.dir.busyUntil = sentAt;
    }
    let deliverAt = sentAt + base;
    if (opts.ordered) deliverAt = Math.max(deliverAt, this.dir.lastDelivery);
    this.dir.lastDelivery = deliverAt;
    this.dir.queued += size;
    setTimeout(() => {
      this.dir.queued -= size;
      if (!this.open || !this.peer.open) return;
      this.peer.messages.emit(payload);
    }, deliverAt - now);
  }

  bufferedAmount(): number {
    return this.dir.opts.bytesPerMs ? this.dir.queued : 0;
  }

  isOpen(): boolean {
    return this.open;
  }

  onMessage(cb: (data: WireData) => void): () => void {
    return this.messages.on(cb);
  }

  onClose(cb: () => void): () => void {
    return this.closes.on(cb);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.closes.emit();
    if (this.peer.open) this.peer.close();
  }
}

/** Create two connected in-memory links. `aToB` configures messages sent by the first link. */
export function createMemoryLinkPair(
  aToB: MemoryLinkOptions = {},
  bToA: MemoryLinkOptions = {},
): [Link, Link] {
  const n = ++memoryLinkCounter;
  const a = new MemoryLink(`mem-${n}-a`, { opts: aToB, lastDelivery: 0, busyUntil: 0, queued: 0 });
  const b = new MemoryLink(`mem-${n}-b`, { opts: bToA, lastDelivery: 0, busyUntil: 0, queued: 0 });
  a.peer = b;
  b.peer = a;
  return [a, b];
}
