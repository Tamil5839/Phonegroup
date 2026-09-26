/**
 * Chunked, checksummed, resumable transfers over a Link.
 *
 * Sender:   xfer-begin → binary chunks → xfer-end → (xfer-need → chunks → xfer-end)* → xfer-done
 * Receiver: stores chunks whose CRC matches, answers xfer-end/xfer-query with the
 *           missing chunk list or xfer-done once the whole-file CRC checks out.
 *
 * If the link drops, the endpoint (kept per phone, not per connection) pauses;
 * after reconnecting the sender asks `xfer-query` and only resends what is missing.
 */
import { crc32 } from './crc32';
import { Emitter } from './link';

export const CHUNK_MAGIC = 0xf7;
export const CHUNK_HEADER_BYTES = 13;
export const DEFAULT_CHUNK_SIZE = 16 * 1024;
/** Hard caps protect the receiver from malformed or hostile senders. */
export const MAX_TRANSFER_BYTES = 96 * 1024 * 1024;
const MAX_MISSING_PER_MESSAGE = 4096;
/** Unfinished incoming transfers allowed per phone (a capture sends at most 7). */
const MAX_INCOMING = 32;

export type TransferMeta = { kind: string } & Record<string, unknown>;

export type TransferControl =
  | { t: 'xfer-begin'; id: number; size: number; chunkSize: number; count: number; crc: number; meta: TransferMeta }
  | { t: 'xfer-end'; id: number }
  | { t: 'xfer-need'; id: number; missing: number[] }
  | { t: 'xfer-done'; id: number }
  | { t: 'xfer-query'; id: number }
  | { t: 'xfer-unknown'; id: number }
  | { t: 'xfer-cancel'; id: number; reason: string };

export const TRANSFER_CONTROL_TYPES = new Set([
  'xfer-begin',
  'xfer-end',
  'xfer-need',
  'xfer-done',
  'xfer-query',
  'xfer-unknown',
  'xfer-cancel',
]);

export interface TransferPort {
  sendControl(msg: TransferControl): void;
  sendBinary(buf: ArrayBuffer): void;
  bufferedAmount(): number;
  isOpen(): boolean;
}

export interface TransferOptions {
  chunkSize?: number;
  /** Stop queueing chunks while more than this many bytes wait in the channel. */
  highWaterBytes?: number;
  /** How long to wait for xfer-done / xfer-need after xfer-end before asking again. */
  ackTimeoutMs?: number;
  /** Consecutive unanswered queries before giving up. */
  maxQueries?: number;
  /** Resend rounds before giving up. */
  maxRounds?: number;
  wait?: (ms: number) => Promise<void>;
}

export function encodeChunk(id: number, index: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.length);
  const view = new DataView(buf);
  view.setUint8(0, CHUNK_MAGIC);
  view.setUint32(1, id >>> 0);
  view.setUint32(5, index >>> 0);
  view.setUint32(9, crc32(payload));
  new Uint8Array(buf, CHUNK_HEADER_BYTES).set(payload);
  return buf;
}

export interface DecodedChunk {
  id: number;
  index: number;
  payload: Uint8Array;
  valid: boolean;
}

export function decodeChunk(buf: ArrayBuffer): DecodedChunk | null {
  if (buf.byteLength < CHUNK_HEADER_BYTES) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== CHUNK_MAGIC) return null;
  const id = view.getUint32(1);
  const index = view.getUint32(5);
  const crc = view.getUint32(9);
  const payload = new Uint8Array(buf, CHUNK_HEADER_BYTES);
  return { id, index, payload, valid: crc32(payload) === crc };
}

export function randomTransferId(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  }
  return Math.floor(Math.random() * 0xfffffffe) + 1;
}

export type OutgoingState = 'queued' | 'sending' | 'awaiting' | 'paused' | 'done' | 'failed' | 'canceled';

export class TransferError extends Error {}

export class OutgoingTransfer {
  readonly count: number;
  readonly crc: number;
  state: OutgoingState = 'queued';
  rounds = 0;
  queries = 0;
  sentBytes = 0;
  error: string | null = null;
  readonly progressChanged = new Emitter<[number]>();
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: number,
    readonly data: Uint8Array,
    readonly meta: TransferMeta,
    readonly chunkSize: number,
  ) {
    this.count = Math.max(1, Math.ceil(data.length / chunkSize));
    this.crc = crc32(data);
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // Callers may not await `done`; never leave an unhandled rejection behind.
    this.done.catch(() => {});
  }

  get size(): number {
    return this.data.length;
  }

  chunk(i: number): Uint8Array {
    return this.data.subarray(i * this.chunkSize, Math.min(this.data.length, (i + 1) * this.chunkSize));
  }

  get finished(): boolean {
    return this.state === 'done' || this.state === 'failed' || this.state === 'canceled';
  }

  /** @internal */
  settle(state: 'done' | 'failed' | 'canceled', error?: string): void {
    if (this.finished) return;
    this.state = state;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (state === 'done') {
      this.progressChanged.emit(1);
      this.resolveDone();
    } else {
      this.error = error ?? state;
      this.rejectDone(new TransferError(this.error));
    }
  }
}

export class IncomingTransfer {
  readonly chunks: (Uint8Array | undefined)[];
  receivedCount = 0;
  receivedBytes = 0;
  corruptChunks = 0;
  complete = false;

  constructor(
    readonly id: number,
    readonly size: number,
    readonly chunkSize: number,
    readonly count: number,
    readonly crc: number,
    readonly meta: TransferMeta,
  ) {
    this.chunks = new Array(count);
  }

  get progress(): number {
    return this.size === 0 ? (this.complete ? 1 : 0) : this.receivedBytes / this.size;
  }

  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) if (!this.chunks[i]) out.push(i);
    return out;
  }

  assemble(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      if (!c) throw new Error('missing chunk');
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

function validBegin(m: Extract<TransferControl, { t: 'xfer-begin' }>): boolean {
  return (
    Number.isInteger(m.size) &&
    m.size >= 0 &&
    m.size <= MAX_TRANSFER_BYTES &&
    Number.isInteger(m.chunkSize) &&
    m.chunkSize >= 256 &&
    m.chunkSize <= 256 * 1024 &&
    Number.isInteger(m.count) &&
    m.count === Math.max(1, Math.ceil(m.size / m.chunkSize)) &&
    typeof m.meta === 'object' &&
    m.meta !== null &&
    typeof m.meta.kind === 'string'
  );
}

interface Job {
  tx: OutgoingTransfer;
  full: boolean;
  indices: number[];
}

/**
 * Handles transfers in both directions for one remote phone. Survives
 * reconnects: call `detach()` when the link drops and `attach()` with the new one.
 */
export class TransferEndpoint {
  private port: TransferPort | null = null;
  private generation = 0;
  private readonly outgoing = new Map<number, OutgoingTransfer>();
  private readonly incoming = new Map<number, IncomingTransfer>();
  private readonly completedIncoming = new Set<number>();
  private jobs: Job[] = [];
  private pumping = false;
  private readonly opts: Required<TransferOptions>;

  readonly incomingStarted = new Emitter<[IncomingTransfer]>();
  readonly incomingProgress = new Emitter<[IncomingTransfer]>();
  readonly incomingComplete = new Emitter<[IncomingTransfer, Uint8Array]>();

  constructor(opts: TransferOptions = {}) {
    this.opts = {
      chunkSize: opts.chunkSize ?? DEFAULT_CHUNK_SIZE,
      highWaterBytes: opts.highWaterBytes ?? 1024 * 1024,
      ackTimeoutMs: opts.ackTimeoutMs ?? 3000,
      maxQueries: opts.maxQueries ?? 5,
      maxRounds: opts.maxRounds ?? 12,
      wait: opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  get attached(): boolean {
    return this.port !== null;
  }

  attach(port: TransferPort): void {
    this.port = port;
    const gen = ++this.generation;
    for (const tx of this.outgoing.values()) {
      if (tx.finished) continue;
      if (tx.state === 'queued') {
        this.enqueue({ tx, full: true, indices: [] });
      } else {
        // We don't know what arrived before the drop: ask.
        tx.state = 'awaiting';
        this.sendQuery(tx, gen);
      }
    }
  }

  detach(): void {
    this.port = null;
    this.generation++;
    this.jobs = [];
    for (const tx of this.outgoing.values()) {
      if (tx.finished) continue;
      if (tx.timer) clearTimeout(tx.timer);
      tx.timer = null;
      if (tx.state !== 'queued') tx.state = 'paused';
    }
  }

  send(data: Uint8Array, meta: TransferMeta, id = randomTransferId()): OutgoingTransfer {
    if (data.length > MAX_TRANSFER_BYTES) throw new TransferError('transfer too large');
    const tx = new OutgoingTransfer(id, data, meta, this.opts.chunkSize);
    this.outgoing.set(tx.id, tx);
    // Keep finished entries briefly for duplicate acks, then forget them.
    const forget = () => setTimeout(() => this.outgoing.delete(tx.id), 60_000);
    tx.done.then(forget, forget);
    if (this.port) this.enqueue({ tx, full: true, indices: [] });
    return tx;
  }

  cancel(tx: OutgoingTransfer, reason = 'canceled'): void {
    if (tx.finished) return;
    tx.settle('canceled', reason);
    this.port?.sendControl({ t: 'xfer-cancel', id: tx.id, reason });
  }

  /** Stop everything (e.g. the phone left the room). */
  dispose(reason = 'closed'): void {
    for (const tx of this.outgoing.values()) tx.settle('failed', reason);
    this.outgoing.clear();
    this.incoming.clear();
    this.detach();
  }

  handleControl(msg: TransferControl): void {
    switch (msg.t) {
      case 'xfer-begin':
        return this.onBegin(msg);
      case 'xfer-end':
      case 'xfer-query':
        return this.onEndOrQuery(msg.id);
      case 'xfer-need': {
        const tx = this.outgoing.get(msg.id);
        if (!tx || tx.finished) return;
        this.clearTimer(tx);
        tx.queries = 0;
        if (++tx.rounds > this.opts.maxRounds) return tx.settle('failed', 'too many resend rounds');
        const indices = (Array.isArray(msg.missing) ? msg.missing : []).filter((i) => Number.isInteger(i) && i >= 0 && i < tx.count);
        this.enqueue({ tx, full: false, indices });
        return;
      }
      case 'xfer-done': {
        const tx = this.outgoing.get(msg.id);
        if (tx) tx.settle('done');
        return;
      }
      case 'xfer-unknown': {
        const tx = this.outgoing.get(msg.id);
        if (!tx || tx.finished) return;
        this.clearTimer(tx);
        if (++tx.rounds > this.opts.maxRounds) return tx.settle('failed', 'receiver lost the transfer');
        this.enqueue({ tx, full: true, indices: [] });
        return;
      }
      case 'xfer-cancel': {
        const tx = this.outgoing.get(msg.id);
        if (tx) tx.settle('canceled', msg.reason || 'canceled by receiver');
        this.incoming.delete(msg.id);
        return;
      }
    }
  }

  /** Returns true if `buf` was a transfer chunk (consumed). */
  handleBinary(buf: ArrayBuffer): boolean {
    const chunk = decodeChunk(buf);
    if (!chunk) return false;
    const rx = this.incoming.get(chunk.id);
    if (!rx || rx.complete) return true;
    if (chunk.index >= rx.count) return true;
    if (!chunk.valid) {
      rx.corruptChunks++;
      return true;
    }
    const expected = chunk.index === rx.count - 1 ? rx.size - chunk.index * rx.chunkSize : rx.chunkSize;
    if (chunk.payload.length !== expected || rx.chunks[chunk.index]) return true;
    rx.chunks[chunk.index] = chunk.payload.slice();
    rx.receivedCount++;
    rx.receivedBytes += chunk.payload.length;
    this.incomingProgress.emit(rx);
    return true;
  }

  private onBegin(msg: Extract<TransferControl, { t: 'xfer-begin' }>): void {
    if (this.completedIncoming.has(msg.id)) return;
    if (!validBegin(msg)) {
      this.port?.sendControl({ t: 'xfer-cancel', id: msg.id, reason: 'invalid transfer' });
      return;
    }
    const existing = this.incoming.get(msg.id);
    if (existing && existing.size === msg.size && existing.crc === msg.crc && existing.chunkSize === msg.chunkSize) {
      return; // a restart of something we already know: keep what we have
    }
    if (!existing && this.incoming.size >= MAX_INCOMING) {
      this.port?.sendControl({ t: 'xfer-cancel', id: msg.id, reason: 'too many transfers' });
      return;
    }
    const rx = new IncomingTransfer(msg.id, msg.size, msg.chunkSize, msg.count, msg.crc >>> 0, msg.meta);
    this.incoming.set(msg.id, rx);
    this.incomingStarted.emit(rx);
  }

  private onEndOrQuery(id: number): void {
    const port = this.port;
    if (!port) return;
    if (this.completedIncoming.has(id)) {
      port.sendControl({ t: 'xfer-done', id });
      return;
    }
    const rx = this.incoming.get(id);
    if (!rx) {
      port.sendControl({ t: 'xfer-unknown', id });
      return;
    }
    const missing = rx.missing();
    if (missing.length > 0) {
      port.sendControl({ t: 'xfer-need', id, missing: missing.slice(0, MAX_MISSING_PER_MESSAGE) });
      return;
    }
    const data = rx.assemble();
    if (crc32(data) !== rx.crc) {
      // Every chunk passed its own check but the whole doesn't: start over.
      rx.chunks.fill(undefined);
      rx.receivedCount = 0;
      rx.receivedBytes = 0;
      port.sendControl({ t: 'xfer-need', id, missing: rx.missing().slice(0, MAX_MISSING_PER_MESSAGE) });
      return;
    }
    rx.complete = true;
    rx.chunks.length = 0;
    this.incoming.delete(id);
    this.completedIncoming.add(id);
    port.sendControl({ t: 'xfer-done', id });
    this.incomingComplete.emit(rx, data);
  }

  private enqueue(job: Job): void {
    job.tx.state = 'sending';
    this.jobs.push(job);
    if (!this.pumping) void this.pump();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!;
        const gen = this.generation;
        const ok = await this.runJob(job, gen);
        if (ok && gen === this.generation && !job.tx.finished) {
          job.tx.state = 'awaiting';
          this.armTimer(job.tx, gen);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runJob({ tx, full, indices }: Job, gen: number): Promise<boolean> {
    const alive = () => gen === this.generation && this.port !== null && !tx.finished;
    if (!alive()) return false;
    const port = this.port!;
    if (full) {
      port.sendControl({
        t: 'xfer-begin',
        id: tx.id,
        size: tx.size,
        chunkSize: tx.chunkSize,
        count: tx.count,
        crc: tx.crc,
        meta: tx.meta,
      });
      tx.sentBytes = 0;
    }
    const list = full ? Array.from({ length: tx.count }, (_, i) => i) : indices;
    for (const i of list) {
      while (alive() && port.bufferedAmount() > this.opts.highWaterBytes) await this.opts.wait(5);
      if (!alive()) return false;
      const payload = tx.chunk(i);
      try {
        port.sendBinary(encodeChunk(tx.id, i, payload));
      } catch {
        return false; // the link died under us; attach() will resume
      }
      if (full) {
        tx.sentBytes += payload.length;
        const pending = Math.max(0, port.bufferedAmount());
        tx.progressChanged.emit(Math.min(0.99, Math.max(0, tx.sentBytes - pending) / Math.max(1, tx.size)));
      }
      // Yield now and then so the UI (and other links) stay responsive.
      if (i % 64 === 63) await this.opts.wait(0);
    }
    if (!alive()) return false;
    port.sendControl({ t: 'xfer-end', id: tx.id });
    return true;
  }

  private armTimer(tx: OutgoingTransfer, gen: number): void {
    this.clearTimer(tx);
    tx.timer = setTimeout(() => {
      tx.timer = null;
      if (gen !== this.generation || tx.finished || tx.state !== 'awaiting') return;
      if (++tx.queries > this.opts.maxQueries) {
        tx.settle('failed', 'receiver stopped answering');
        return;
      }
      this.sendQuery(tx, gen);
    }, this.opts.ackTimeoutMs);
  }

  private sendQuery(tx: OutgoingTransfer, gen: number): void {
    try {
      this.port?.sendControl({ t: 'xfer-query', id: tx.id });
    } catch {
      /* resumed on next attach */
    }
    this.armTimer(tx, gen);
  }

  private clearTimer(tx: OutgoingTransfer): void {
    if (tx.timer) clearTimeout(tx.timer);
    tx.timer = null;
  }
}
