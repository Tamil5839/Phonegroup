/**
 * A shooter's side of a room: connects to the host, keeps its clock in sync,
 * follows the countdown, captures the frame nearest the moment and sends it
 * (plus neighbours) to the host, then receives the finished clip.
 * Reconnects by itself if the connection drops; unfinished transfers resume.
 */
import { batch, signal } from '@preact/signals-core';
import { Bus } from '../core/bus';
import { runClockSync, type SyncEstimate } from '../core/clockSync';
import type { Link } from '../core/link';
import {
  DEFAULT_SETTINGS,
  parseHostMessage,
  PROTOCOL_VERSION,
  type CameraStatus,
  type CaptureMode,
  type CaptureReport,
  type DeviceInfo,
  type HostMessage,
  type RoomSettings,
  type ShooterMessage,
} from '../core/protocol';
import type { Clock } from '../core/time';
import { TRANSFER_CONTROL_TYPES, TransferEndpoint, type TransferControl, type TransferPort } from '../core/transfer';
import type { CaptureDevice } from './types';

export type ShooterPhase =
  | 'connecting'
  | 'lobby'
  | 'countdown'
  | 'sending'
  | 'waiting'
  | 'result'
  | 'reconnecting'
  | 'ended';

export interface ShooterDeps {
  clock: Clock;
  /** Open a new connection to the host (called again to reconnect). */
  connect: () => Promise<Link>;
  device: CaptureDevice;
  clientId: string;
  name: string;
  deviceInfo: DeviceInfo;
  getLatencyCorrection?: () => number;
  setLatencyCorrection?: (ms: number) => void;
  /** Delays between reconnection attempts. */
  reconnectDelaysMs?: number[];
  welcomeTimeoutMs?: number;
  /** Interval of light re-syncs while waiting in the lobby (0 = off). */
  lobbySyncMs?: number;
}

export interface CountdownState {
  captureId: string;
  mode: CaptureMode;
  /** The moment T in host time. */
  target: number;
  /** The same moment on this phone's clock. */
  targetLocal: number;
}

export interface ResultClip {
  data: Uint8Array;
  mime: string;
  name: string;
}

export class JoinError extends Error {}

function busPort(bus: Bus<HostMessage, ShooterMessage>): TransferPort {
  return {
    sendControl: (m: TransferControl) => void bus.send(m),
    sendBinary: (b) => bus.sendBinary(b),
    bufferedAmount: () => bus.bufferedAmount(),
    isOpen: () => bus.isOpen,
  };
}

const DEFAULT_RECONNECT_DELAYS = [500, 1000, 2000, 3000, 5000, 5000, 8000, 10_000, 10_000, 10_000];

export class ShooterSession {
  readonly phase = signal<ShooterPhase>('connecting');
  readonly lineup = signal<{ index: number; total: number } | null>(null);
  readonly settings = signal<RoomSettings>({ ...DEFAULT_SETTINGS });
  readonly sync = signal<SyncEstimate | null>(null);
  readonly syncing = signal(false);
  readonly countdown = signal<CountdownState | null>(null);
  readonly sendProgress = signal(0);
  readonly lastReport = signal<CaptureReport | null>(null);
  readonly hostStage = signal<string | null>(null);
  readonly resultProgress = signal<number | null>(null);
  readonly result = signal<ResultClip | null>(null);
  readonly error = signal<string | null>(null);
  readonly endedReason = signal<string | null>(null);

  private readonly bus: Bus<HostMessage, ShooterMessage>;
  private readonly endpoint = new TransferEndpoint();
  private stopped = false;
  private camera: CameraStatus = { state: 'off' };
  private syncPromise: Promise<SyncEstimate | null> | null = null;
  private lobbyTimer: ReturnType<typeof setInterval> | null = null;
  private captureAbort: AbortController | null = null;
  private welcomeWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private stablePhase: ShooterPhase = 'lobby';
  private reconnecting = false;

  constructor(private readonly deps: ShooterDeps) {
    this.bus = new Bus<HostMessage, ShooterMessage>(parseHostMessage, deps.clock);
    this.wire();
  }

  /* ----------------------------- lifecycle ----------------------------- */

  /** Connect and join. Rejects with a readable JoinError if that fails. */
  async start(): Promise<void> {
    this.phase.value = 'connecting';
    await this.connectOnce();
    this.phase.value = 'lobby';
    this.stablePhase = 'lobby';
    void this.syncNow(true);
    const every = this.deps.lobbySyncMs ?? 10_000;
    if (every > 0) {
      this.lobbyTimer = setInterval(() => {
        if (this.phase.value === 'lobby' && !this.syncing.value) void this.syncNow(false);
      }, every);
    }
  }

  private async connectOnce(): Promise<void> {
    let link: Link;
    try {
      link = await this.deps.connect();
    } catch (err) {
      throw new JoinError((err as Error).message || 'Could not connect to the host.');
    }
    if (this.stopped) {
      link.close();
      throw new JoinError('Stopped.');
    }
    const welcomed = new Promise<void>((resolve, reject) => {
      this.welcomeWaiter = { resolve, reject };
    });
    const timer = setTimeout(
      () => this.welcomeWaiter?.reject(new JoinError('The host did not answer. Try scanning the code again.')),
      this.deps.welcomeTimeoutMs ?? 10_000,
    );
    this.bus.attach(link);
    this.bus.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      clientId: this.deps.clientId,
      name: this.deps.name,
      device: this.deps.deviceInfo,
    });
    try {
      await welcomed;
    } catch (err) {
      this.bus.detach();
      link.close();
      throw err;
    } finally {
      clearTimeout(timer);
      this.welcomeWaiter = null;
    }
    this.endpoint.attach(busPort(this.bus));
    if (this.camera.state !== 'off') this.bus.send({ t: 'status', camera: this.camera });
  }

  leave(): void {
    if (this.stopped) return;
    this.bus.send({ t: 'bye' });
    this.end('You left the moment.');
  }

  private end(reason: string): void {
    this.stopped = true;
    if (this.lobbyTimer) clearInterval(this.lobbyTimer);
    this.captureAbort?.abort();
    this.endpoint.dispose(reason);
    const link = this.bus.current;
    this.bus.detach();
    setTimeout(() => link?.close(), 300);
    batch(() => {
      this.endedReason.value = reason;
      if (this.phase.value !== 'result') this.phase.value = 'ended';
    });
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.reconnectLoop();
    } finally {
      this.reconnecting = false;
    }
  }

  private async reconnectLoop(): Promise<void> {
    const delays = this.deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    const previous = this.phase.value === 'reconnecting' ? this.stablePhase : this.phase.value;
    this.stablePhase = previous === 'countdown' ? 'waiting' : previous;
    this.phase.value = 'reconnecting';
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      if (this.stopped) return;
      try {
        await this.connectOnce();
        this.phase.value = this.stablePhase;
        void this.syncNow(true);
        return;
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof JoinError && /left|closed|removed|ended/i.test(err.message)) break;
      }
    }
    if (!this.stopped) this.end('Lost the connection to the host.');
  }

  /* ----------------------------- messages ----------------------------- */

  private wire(): void {
    const bus = this.bus;
    bus.on('welcome', (m) => {
      batch(() => {
        this.settings.value = m.settings;
        this.lineup.value = { index: m.index, total: m.total };
      });
      this.welcomeWaiter?.resolve();
    });
    bus.on('reject', (m) => this.welcomeWaiter?.reject(new JoinError(m.reason)));
    bus.on('lineup', (m) => (this.lineup.value = { index: m.index, total: m.total }));
    bus.on('settings', (m) => (this.settings.value = m.settings));
    bus.on('sync-request', (m) => void this.syncNow(m.full));
    bus.on('countdown', (m) => void this.onCountdown(m));
    bus.on('abort', (m) => {
      if (this.countdown.value?.captureId !== m.captureId) return;
      this.captureAbort?.abort();
      batch(() => {
        this.countdown.value = null;
        this.hostStage.value = m.reason;
        this.phase.value = 'lobby';
      });
    });
    bus.on('progress', (m) => (this.hostStage.value = m.stage));
    bus.on('calibrate', (m) => {
      const cur = this.deps.getLatencyCorrection?.() ?? 0;
      this.deps.setLatencyCorrection?.(cur + m.latencyMs);
    });
    bus.on('kick', (m) => this.end(m.reason));
    bus.on('room-closed', () => this.end('The host ended this moment.'));
    for (const type of TRANSFER_CONTROL_TYPES) {
      bus.on(type as TransferControl['t'], (m) => this.endpoint.handleControl(m as TransferControl));
    }
    bus.binary.on((buf) => this.endpoint.handleBinary(buf));
    bus.closed.on(() => {
      this.endpoint.detach();
      this.welcomeWaiter?.reject(new JoinError('The connection closed before the host answered.'));
      if (!this.stopped && this.phase.value !== 'connecting') void this.reconnect();
    });

    this.endpoint.incomingStarted.on((rx) => {
      if (rx.meta.kind === 'clip') this.resultProgress.value = 0;
    });
    this.endpoint.incomingProgress.on((rx) => {
      if (rx.meta.kind === 'clip') this.resultProgress.value = rx.progress;
    });
    this.endpoint.incomingComplete.on((rx, data) => {
      if (rx.meta.kind !== 'clip') return;
      const mime = typeof rx.meta.mime === 'string' ? rx.meta.mime : 'video/mp4';
      const name = typeof rx.meta.name === 'string' ? rx.meta.name.replace(/[^\w.\- ]/g, '') : 'frozen-moment.mp4';
      batch(() => {
        this.result.value = { data, mime, name };
        this.resultProgress.value = 1;
        this.phase.value = 'result';
        this.stablePhase = 'result';
      });
    });
  }

  setCameraStatus(camera: CameraStatus): void {
    this.camera = camera;
    this.bus.send({ t: 'status', camera });
  }

  /** Run a clock-sync exchange (deduplicated) and report the result to the host. */
  syncNow(full: boolean): Promise<SyncEstimate | null> {
    if (this.syncPromise) return this.syncPromise;
    this.syncing.value = true;
    const run = async (): Promise<SyncEstimate | null> => {
      try {
        const est = await runClockSync(
          {
            sendPing: (id, t0) => this.bus.send({ t: 'ping', id, t0 }),
            onPong: (cb) => this.bus.on('pong', (m) => cb(m.id, m.h1, m.h2)),
          },
          this.deps.clock,
          full ? { count: 32, intervalMs: 25 } : { count: 10, intervalMs: 30, minReplies: 4, minKeep: 3 },
        );
        const prev = this.sync.value;
        // A light lobby check only replaces a full sync if it is at least as good.
        if (full || !prev || est.uncertainty <= prev.uncertainty * 1.5) this.sync.value = est;
        this.bus.send({
          t: 'sync',
          offset: this.sync.value!.offset,
          uncertainty: this.sync.value!.uncertainty,
          bestRtt: est.bestRtt,
          samples: est.samples,
          full,
        });
        return est;
      } catch (err) {
        this.bus.send({ t: 'sync-failed', reason: (err as Error).message });
        return null;
      } finally {
        this.syncPromise = null;
        this.syncing.value = false;
      }
    };
    this.syncPromise = run();
    return this.syncPromise;
  }

  private async onCountdown(m: Extract<HostMessage, { t: 'countdown' }>): Promise<void> {
    if (this.syncPromise) await this.syncPromise;
    this.captureAbort?.abort();
    const abort = new AbortController();
    this.captureAbort = abort;
    const est = this.sync.value;
    const offset = est?.offset ?? 0;
    batch(() => {
      this.countdown.value = { captureId: m.captureId, mode: m.mode, target: m.target, targetLocal: m.target - offset };
      this.phase.value = 'countdown';
      this.sendProgress.value = 0;
      this.hostStage.value = null;
      this.result.value = null;
      this.resultProgress.value = null;
    });
    let frames;
    try {
      frames = await this.deps.device.capture({
        captureId: m.captureId,
        mode: m.mode,
        target: m.target,
        toHost: (local) => local + offset,
        toLocal: (host) => host - offset,
        syncUncertainty: est?.uncertainty ?? Infinity,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      const report: CaptureReport = { captureId: m.captureId, ok: false, error: (err as Error).message || 'Capture failed' };
      this.lastReport.value = report;
      this.bus.send({ t: 'report', report });
      this.phase.value = 'lobby';
      return;
    }
    if (abort.signal.aborted) return;
    this.lastReport.value = frames.report;
    this.bus.send({ t: 'report', report: frames.report });
    if (!frames.main) {
      this.phase.value = 'lobby';
      return;
    }
    this.phase.value = 'sending';
    this.stablePhase = 'sending';
    const main = this.endpoint.send(frames.main, { kind: 'frame', captureId: m.captureId });
    main.progressChanged.on((p) => (this.sendProgress.value = p));
    for (const n of frames.neighbors) {
      this.endpoint.send(n.data, { kind: 'neighbor', captureId: m.captureId, offset: n.offset });
    }
    try {
      await main.done;
      this.sendProgress.value = 1;
      // Read afresh: the phase may have changed while we awaited.
      const phase = this.phase.peek();
      if (phase === 'sending') {
        this.phase.value = 'waiting';
        this.stablePhase = 'waiting';
      }
    } catch (err) {
      const phase = this.phase.peek();
      if (phase !== 'ended') {
        this.error.value = `Could not send your photo: ${(err as Error).message}`;
        this.phase.value = 'lobby';
        this.stablePhase = 'lobby';
      }
    }
  }
}
