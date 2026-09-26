/**
 * NTP-style clock synchronisation between a shooter and the host.
 *
 * The shooter sends `t0` (its clock), the host notes `h1` on receipt and `h2`
 * when replying, the shooter notes `t1` on receipt:
 *
 *   offset = ((h1 − t0) + (h2 − t1)) / 2        (host − shooter)
 *   rtt    = (t1 − t0) − (h2 − h1)
 *
 * With h1 === h2 this is exactly `h − (t0 + t1) / 2`. Exchanges with the
 * smallest round trips carry the least queueing noise, so we keep the fastest
 * ones and take the median of their offsets. The error of each estimate is
 * bounded by half its round trip, which we report as the uncertainty.
 */
import type { Clock } from './time';
import { median } from './time';

export interface SyncSample {
  t0: number;
  h1: number;
  h2: number;
  t1: number;
}

export interface SyncEstimate {
  /** hostTime ≈ localTime + offset */
  offset: number;
  /** Estimated worst-case error in ms (half the best round trip). */
  uncertainty: number;
  bestRtt: number;
  medianRtt: number;
  /** Number of samples the median was taken over. */
  used: number;
  /** Number of samples collected. */
  samples: number;
  /** Max − min offset among the samples used (a consistency hint). */
  spread: number;
  /** Local time at which the estimate was made. */
  at: number;
}

export interface EstimateOptions {
  /** Fraction of the fastest exchanges to keep. */
  keepFraction?: number;
  /** Minimum number of exchanges to keep (if available). */
  minKeep?: number;
}

/** Timer resolution floor: browsers coarsen performance.now() to 0.1–1 ms. */
const RESOLUTION_FLOOR_MS = 0.5;

export function sampleOffset(s: SyncSample): { offset: number; rtt: number } {
  const offset = (s.h1 - s.t0 + (s.h2 - s.t1)) / 2;
  const rtt = Math.max(0, s.t1 - s.t0 - (s.h2 - s.h1));
  return { offset, rtt };
}

export function estimateOffset(
  samples: readonly SyncSample[],
  { keepFraction = 0.3, minKeep = 5 }: EstimateOptions = {},
): SyncEstimate | null {
  const valid = samples
    .map(sampleOffset)
    .filter((s) => Number.isFinite(s.offset) && Number.isFinite(s.rtt));
  if (valid.length === 0) return null;
  valid.sort((a, b) => a.rtt - b.rtt);
  const keep = Math.min(valid.length, Math.max(minKeep, Math.round(valid.length * keepFraction)));
  const best = valid.slice(0, keep);
  const offsets = best.map((s) => s.offset);
  const bestRtt = valid[0].rtt;
  return {
    offset: median(offsets),
    uncertainty: Math.max(RESOLUTION_FLOOR_MS, bestRtt / 2),
    bestRtt,
    medianRtt: median(valid.map((s) => s.rtt)),
    used: keep,
    samples: valid.length,
    spread: Math.max(...offsets) - Math.min(...offsets),
    at: NaN,
  };
}

/** Transport hooks for running the exchange (implemented on top of the message bus). */
export interface SyncTransport {
  sendPing(id: number, t0: number): void;
  onPong(cb: (id: number, h1: number, h2: number) => void): () => void;
}

export interface SyncRunOptions extends EstimateOptions {
  /** Number of exchanges (the spec asks for 30+). */
  count?: number;
  /** Spacing between pings; short enough to keep Wi-Fi radios awake. */
  intervalMs?: number;
  /** How long to wait for late replies after the last ping. */
  settleMs?: number;
  /** Minimum replies needed for a usable estimate. */
  minReplies?: number;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}

export class SyncError extends Error {}

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run a full sync exchange from the shooter side. */
export async function runClockSync(
  transport: SyncTransport,
  clock: Clock,
  opts: SyncRunOptions = {},
): Promise<SyncEstimate> {
  const {
    count = 32,
    intervalMs = 25,
    settleMs = 600,
    minReplies = 8,
    signal,
    wait = defaultWait,
  } = opts;
  const sent = new Map<number, number>();
  const samples: SyncSample[] = [];
  let outstanding = 0;
  const off = transport.onPong((id, h1, h2) => {
    const t1 = clock();
    const t0 = sent.get(id);
    if (t0 === undefined) return;
    sent.delete(id);
    outstanding--;
    samples.push({ t0, h1, h2, t1 });
  });
  const base = Math.floor(Math.random() * 1e6) * 1000;
  try {
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw new SyncError('sync aborted');
      const id = base + i;
      const t0 = clock();
      sent.set(id, t0);
      outstanding++;
      transport.sendPing(id, t0);
      await wait(intervalMs);
    }
    const deadline = clock() + settleMs;
    while (outstanding > 0 && clock() < deadline) {
      if (signal?.aborted) throw new SyncError('sync aborted');
      await wait(10);
    }
  } finally {
    off();
  }
  if (samples.length < minReplies) {
    throw new SyncError(`only ${samples.length} of ${count} sync replies arrived`);
  }
  const est = estimateOffset(samples, opts);
  if (!est) throw new SyncError('no usable sync samples');
  est.at = clock();
  return est;
}

/** Host side: answer a ping. `receivedAt` must be read as early as possible. */
export function answerPing(id: number, receivedAt: number, clock: Clock) {
  return { id, h1: receivedAt, h2: clock() };
}

/** Uncertainty above which the host shows a warning. */
export const SYNC_WARN_MS = 25;
