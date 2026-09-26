/**
 * The host's side of a room: accepts shooters, answers clock-sync pings,
 * keeps the left-to-right order, runs the synchronized countdown, collects
 * the captured frames and sends the finished clip back to everyone.
 *
 * Network-agnostic: it is handed Links (WebRTC data channels in the app,
 * in-memory pipes in tests) and exposes its state as signals for the UI.
 */
import { batch, signal } from '@preact/signals-core';
import { Bus } from '../core/bus';
import { answerPing } from '../core/clockSync';
import { randomId } from '../core/ids';
import type { Link } from '../core/link';
import {
  cleanName,
  DEFAULT_SETTINGS,
  parseShooterMessage,
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

export const HOST_ID = 'host';
export const MAX_SHOOTERS = 30;
const HELLO_TIMEOUT_MS = 10_000;
const SYNC_WAIT_MS = 4_000;
export const DELIVERY_TIMEOUT_MS = 20_000;

export interface ShooterSync {
  offset: number;
  uncertainty: number;
  bestRtt: number;
  samples: number;
  full: boolean;
  /** Host time the report arrived. */
  at: number;
}

export interface ShooterState {
  id: string;
  name: string;
  isHost: boolean;
  device: DeviceInfo | null;
  connected: boolean;
  camera: CameraStatus;
  sync: ShooterSync | null;
  syncError: string | null;
  lastSeen: number;
  joinedAt: number;
}

export type HostPhase = 'lobby' | 'syncing' | 'countdown' | 'collecting' | 'review';

export type FrameStatus = 'waiting' | 'receiving' | 'done' | 'failed' | 'missing';

export interface FrameEntry {
  shooterId: string;
  name: string;
  status: FrameStatus;
  report: CaptureReport | null;
  main: Uint8Array | null;
  mainProgress: number;
  neighbors: Record<number, Uint8Array>;
  error: string | null;
  /** Arrived after the 20 s collection window closed. */
  late: boolean;
}

export interface CaptureRun {
  id: string;
  mode: CaptureMode;
  /** The moment T in host time. */
  target: number;
  participants: string[];
  startedAt: number;
  deadline: number;
}

export interface DeliveryState {
  progress: number;
  state: 'sending' | 'done' | 'failed';
}

interface PeerHandle {
  id: string;
  bus: Bus<ShooterMessage, HostMessage>;
  endpoint: TransferEndpoint;
}

function busPort(bus: Bus<ShooterMessage, HostMessage>): TransferPort {
  return {
    sendControl: (m: TransferControl) => void bus.send(m),
    sendBinary: (b) => bus.sendBinary(b),
    bufferedAmount: () => bus.bufferedAmount(),
    isOpen: () => bus.isOpen,
  };
}

export class HostSession {
  readonly shooters = signal<ShooterState[]>([]);
  readonly order = signal<string[]>([]);
  readonly settings = signal<RoomSettings>({ ...DEFAULT_SETTINGS });
  readonly phase = signal<HostPhase>('lobby');
  readonly run = signal<CaptureRun | null>(null);
  readonly frames = signal<Record<string, FrameEntry>>({});
  readonly delivery = signal<Record<string, DeliveryState>>({});
  readonly locked = signal(false);
  readonly notice = signal<string | null>(null);

  private readonly peers = new Map<string, PeerHandle>();
  private localDevice: CaptureDevice | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private captureAbort: AbortController | null = null;
  private closed = false;

  constructor(
    readonly room: string,
    readonly clock: Clock,
  ) {}

  /* ----------------------------- connections ----------------------------- */

  /** Hand over a freshly opened connection; the shooter identifies itself with `hello`. */
  addConnection(link: Link): void {
    let settled = false;
    const finish = () => {
      settled = true;
      offMessage();
      offClose();
      clearTimeout(timer);
    };
    const offMessage = link.onMessage((data) => {
      if (settled || typeof data !== 'string') return;
      const msg = parseShooterMessage(data);
      if (!msg || msg.t !== 'hello') return;
      finish();
      this.acceptShooter(link, msg);
    });
    const offClose = link.onClose(finish);
    const timer = setTimeout(() => {
      if (settled) return;
      finish();
      link.close();
    }, HELLO_TIMEOUT_MS);
  }

  private reject(link: Link, reason: string): void {
    try {
      link.send(JSON.stringify({ t: 'reject', reason } satisfies HostMessage));
    } catch {
      /* ignore */
    }
    setTimeout(() => link.close(), 500);
  }

  private acceptShooter(link: Link, hello: Extract<ShooterMessage, { t: 'hello' }>): void {
    if (this.closed) return this.reject(link, 'This moment has ended.');
    if (hello.v !== PROTOCOL_VERSION) {
      return this.reject(link, 'This phone has a different version of the app. Reload the page and try again.');
    }
    const id = hello.clientId;
    if (id === HOST_ID) return this.reject(link, 'Invalid client.');
    let peer = this.peers.get(id);
    if (!peer) {
      if (this.locked.value) return this.reject(link, 'The host has closed the room to new phones.');
      if (this.peers.size >= MAX_SHOOTERS) return this.reject(link, 'This moment is full.');
      peer = this.createPeer(id);
      const now = this.clock();
      batch(() => {
        this.shooters.value = [
          ...this.shooters.value,
          {
            id,
            name: cleanName(hello.name),
            isHost: false,
            device: hello.device,
            connected: true,
            camera: { state: 'off' },
            sync: null,
            syncError: null,
            lastSeen: now,
            joinedAt: now,
          },
        ];
        this.order.value = [...this.order.value, id];
      });
    } else {
      const old = peer.bus.current;
      if (old && old !== link) old.close();
      this.patchShooter(id, { connected: true, name: cleanName(hello.name), device: hello.device, lastSeen: this.clock() });
    }
    peer.bus.attach(link);
    peer.endpoint.attach(busPort(peer.bus));
    const { index, total } = this.positionOf(id);
    peer.bus.send({ t: 'welcome', v: PROTOCOL_VERSION, room: this.room, settings: this.settings.value, index, total });
    this.broadcastLineup();
  }

  private createPeer(id: string): PeerHandle {
    const bus = new Bus<ShooterMessage, HostMessage>(parseShooterMessage, this.clock);
    const endpoint = new TransferEndpoint();
    const peer: PeerHandle = { id, bus, endpoint };
    this.peers.set(id, peer);

    bus.on('ping', (m, receivedAt) => {
      bus.send({ t: 'pong', ...answerPing(m.id, receivedAt, this.clock) });
    });
    bus.on('sync', (m) => {
      this.patchShooter(id, {
        sync: { offset: m.offset, uncertainty: m.uncertainty, bestRtt: m.bestRtt, samples: m.samples, full: m.full, at: this.clock() },
        syncError: null,
        lastSeen: this.clock(),
      });
    });
    bus.on('sync-failed', (m) => this.patchShooter(id, { syncError: m.reason, lastSeen: this.clock() }));
    bus.on('status', (m) => this.patchShooter(id, { camera: m.camera, lastSeen: this.clock() }));
    bus.on('report', (m) => this.onReport(id, m.report));
    bus.on('bye', () => this.removeShooter(id));
    for (const type of TRANSFER_CONTROL_TYPES) {
      bus.on(type as TransferControl['t'], (m) => endpoint.handleControl(m as TransferControl));
    }
    bus.binary.on((buf) => endpoint.handleBinary(buf));
    bus.closed.on(() => {
      endpoint.detach();
      this.patchShooter(id, { connected: false });
    });

    endpoint.incomingStarted.on((rx) => {
      const run = this.run.value;
      if (!run || rx.meta.captureId !== run.id) return;
      if (rx.meta.kind === 'frame') this.patchFrame(id, { status: 'receiving' });
    });
    endpoint.incomingProgress.on((rx) => {
      const run = this.run.value;
      if (!run || rx.meta.captureId !== run.id || rx.meta.kind !== 'frame') return;
      this.patchFrame(id, { mainProgress: rx.progress });
    });
    endpoint.incomingComplete.on((rx, data) => {
      const run = this.run.value;
      if (!run || rx.meta.captureId !== run.id) return;
      const entry = this.frames.value[id];
      if (!entry) return;
      if (rx.meta.kind === 'frame') {
        const late = this.phase.value === 'review' && entry.status === 'missing';
        this.patchFrame(id, { main: data, status: 'done', mainProgress: 1, late });
        this.checkCollectionComplete();
      } else if (rx.meta.kind === 'neighbor') {
        const offset = rx.meta.offset;
        if (typeof offset === 'number' && Number.isInteger(offset) && Math.abs(offset) <= 3 && offset !== 0) {
          this.patchFrame(id, { neighbors: { ...entry.neighbors, [offset]: data } });
        }
      }
    });
    return peer;
  }

  private removeShooter(id: string): void {
    const peer = this.peers.get(id);
    if (peer) {
      peer.endpoint.dispose('removed');
      peer.bus.current?.close();
      peer.bus.detach();
      this.peers.delete(id);
    }
    batch(() => {
      this.shooters.value = this.shooters.value.filter((s) => s.id !== id);
      this.order.value = this.order.value.filter((x) => x !== id);
    });
    this.broadcastLineup();
  }

  kick(id: string, reason = 'The host removed you from this moment.'): void {
    this.peers.get(id)?.bus.send({ t: 'kick', reason });
    setTimeout(() => this.removeShooter(id), 200);
  }

  /** The host's own camera takes part as one of the shooters. */
  setLocalDevice(device: CaptureDevice | null, camera: CameraStatus = { state: 'ready' }): void {
    this.localDevice = device;
    const exists = this.shooters.value.some((s) => s.id === HOST_ID);
    if (device && !exists) {
      const now = this.clock();
      batch(() => {
        this.shooters.value = [
          ...this.shooters.value,
          {
            id: HOST_ID,
            name: 'Host (you)',
            isHost: true,
            device: null,
            connected: true,
            camera,
            sync: { offset: 0, uncertainty: 0, bestRtt: 0, samples: 0, full: true, at: now },
            syncError: null,
            lastSeen: now,
            joinedAt: now,
          },
        ];
        this.order.value = [...this.order.value, HOST_ID];
      });
    } else if (device) {
      this.patchShooter(HOST_ID, { camera });
    } else if (!device && exists) {
      batch(() => {
        this.shooters.value = this.shooters.value.filter((s) => s.id !== HOST_ID);
        this.order.value = this.order.value.filter((x) => x !== HOST_ID);
      });
    }
    this.broadcastLineup();
  }

  /* ------------------------------ lineup ------------------------------ */

  setOrder(ids: string[]): void {
    const known = new Set(this.order.value);
    const next = ids.filter((id) => known.has(id));
    for (const id of this.order.value) if (!next.includes(id)) next.push(id);
    this.order.value = next;
    this.broadcastLineup();
  }

  move(id: string, delta: number): void {
    const order = [...this.order.value];
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    this.setOrder(order);
  }

  positionOf(id: string): { index: number; total: number } {
    const order = this.order.value;
    return { index: order.indexOf(id) + 1, total: order.length };
  }

  private broadcastLineup(): void {
    for (const peer of this.peers.values()) {
      const { index, total } = this.positionOf(peer.id);
      peer.bus.send({ t: 'lineup', index, total });
    }
  }

  updateSettings(patch: Partial<RoomSettings>): void {
    this.settings.value = { ...this.settings.value, ...patch };
    this.broadcast({ t: 'settings', settings: this.settings.value });
  }

  /* ------------------------------ capture ------------------------------ */

  isConnected(id: string): boolean {
    if (id === HOST_ID) return !!this.localDevice;
    return !!this.peers.get(id)?.bus.isOpen;
  }

  /** Participants a capture would use right now, in order. */
  readyParticipants(): string[] {
    return this.order.value.filter((id) => this.isConnected(id));
  }

  /**
   * Re-sync every phone, then schedule the moment T and start the countdown on
   * all screens. Resolves once the countdown has been sent.
   */
  async startCapture(mode: CaptureMode = 'moment', opts: { target?: number } = {}): Promise<CaptureRun> {
    if (this.phase.value !== 'lobby' && this.phase.value !== 'review') throw new Error('A capture is already running.');
    const participants = this.readyParticipants();
    if (participants.length === 0) throw new Error('No cameras are connected yet.');
    this.clearTimers();
    this.captureAbort = new AbortController();
    const abort = this.captureAbort.signal;
    const captureId = randomId(10);
    const names = new Map(this.shooters.value.map((s) => [s.id, s.name]));
    batch(() => {
      this.run.value = null;
      this.delivery.value = {};
      this.frames.value = Object.fromEntries(
        participants.map((id) => [
          id,
          {
            shooterId: id,
            name: names.get(id) ?? 'Shooter',
            status: 'waiting',
            report: null,
            main: null,
            mainProgress: 0,
            neighbors: {},
            error: null,
            late: false,
          } satisfies FrameEntry,
        ]),
      );
      this.phase.value = 'syncing';
    });

    // Clocks drift: always re-sync right before the countdown.
    const requestedAt = this.clock();
    const remote = participants.filter((id) => id !== HOST_ID);
    for (const id of remote) this.peers.get(id)?.bus.send({ t: 'sync-request', full: true });
    await this.waitFor(
      () =>
        remote.every((id) => {
          const s = this.shooters.value.find((x) => x.id === id);
          return !s || !s.connected || (s.sync && s.sync.at >= requestedAt) || s.syncError !== null;
        }),
      SYNC_WAIT_MS,
      abort,
    );
    if (abort.aborted) throw new Error('Capture canceled.');

    const startedAt = this.clock();
    // A pre-announced moment (manual/mixed mode) keeps its time; otherwise count down from now.
    const target = opts.target ?? startedAt + this.settings.value.countdownMs;
    if (target < startedAt + 500) {
      batch(() => {
        this.frames.value = {};
        this.phase.value = 'lobby';
      });
      throw new Error('The moment is too close to start the countdown.');
    }
    const run: CaptureRun = { id: captureId, mode, target, participants, startedAt, deadline: target + DELIVERY_TIMEOUT_MS };
    batch(() => {
      this.run.value = run;
      this.phase.value = 'countdown';
    });
    for (const id of remote) this.peers.get(id)?.bus.send({ t: 'countdown', captureId, target, mode });
    if (participants.includes(HOST_ID)) void this.captureLocal(run, abort);

    this.after(target + 450 - this.clock(), () => {
      if (this.phase.value === 'countdown' && this.run.value?.id === captureId) this.phase.value = 'collecting';
      this.checkCollectionComplete();
    });
    this.after(run.deadline - this.clock(), () => this.finishCollection());
    return run;
  }

  private async captureLocal(run: CaptureRun, signal: AbortSignal): Promise<void> {
    const device = this.localDevice;
    if (!device) return;
    try {
      const frames = await device.capture({
        captureId: run.id,
        mode: run.mode,
        target: run.target,
        toHost: (t) => t,
        toLocal: (t) => t,
        syncUncertainty: 0,
        signal,
      });
      if (this.run.value?.id !== run.id) return;
      const neighbors: Record<number, Uint8Array> = {};
      for (const n of frames.neighbors) neighbors[n.offset] = n.data;
      this.patchFrame(HOST_ID, {
        report: frames.report,
        main: frames.main,
        neighbors,
        mainProgress: 1,
        status: frames.main ? 'done' : 'failed',
        error: frames.main ? null : (frames.report.error ?? 'No frame captured'),
      });
    } catch (err) {
      this.patchFrame(HOST_ID, { status: 'failed', error: (err as Error).message });
    }
    this.checkCollectionComplete();
  }

  private onReport(id: string, report: CaptureReport): void {
    const run = this.run.value;
    if (!run || report.captureId !== run.id || !this.frames.value[id]) return;
    this.patchFrame(id, report.ok ? { report } : { report, status: 'failed', error: report.error ?? 'Capture failed' });
    this.checkCollectionComplete();
  }

  private checkCollectionComplete(): void {
    const run = this.run.value;
    if (!run) return;
    if (this.phase.value !== 'collecting' && this.phase.value !== 'countdown') return;
    if (this.clock() < run.target) return;
    const entries = Object.values(this.frames.value);
    if (entries.every((f) => f.status === 'done' || f.status === 'failed')) {
      this.clearTimers();
      this.phase.value = 'review';
    }
  }

  /** Close the collection window: whoever hasn't delivered is marked missing. */
  finishCollection(): void {
    const run = this.run.value;
    if (!run || this.phase.value === 'review' || this.phase.value === 'lobby') return;
    batch(() => {
      const next = { ...this.frames.value };
      const missing: string[] = [];
      for (const [id, f] of Object.entries(next)) {
        if (f.status === 'waiting' || f.status === 'receiving') {
          next[id] = { ...f, status: 'missing', error: 'Did not arrive in time' };
          missing.push(f.name);
        }
      }
      this.frames.value = next;
      this.phase.value = 'review';
      if (missing.length) this.notice.value = `Continuing without ${missing.join(', ')} — their photo didn't arrive in time.`;
    });
    this.clearTimers();
  }

  abortCapture(reason = 'The host canceled the countdown.'): void {
    const run = this.run.value;
    this.captureAbort?.abort();
    this.clearTimers();
    if (run) this.broadcast({ t: 'abort', captureId: run.id, reason });
    batch(() => {
      this.run.value = null;
      this.frames.value = {};
      this.phase.value = 'lobby';
    });
  }

  /** Back to the lobby for another moment with the same phones. */
  newMoment(): void {
    this.clearTimers();
    batch(() => {
      this.run.value = null;
      this.frames.value = {};
      this.delivery.value = {};
      this.phase.value = 'lobby';
    });
  }

  /** Let shooters know what the host is doing with their frames. */
  announce(stage: 'editing' | 'rendering' | 'sending' | 'failed', message?: string): void {
    const run = this.run.value;
    if (run) this.broadcast({ t: 'progress', captureId: run.id, stage, message });
  }

  calibrate(id: string, latencyMs: number): void {
    this.peers.get(id)?.bus.send({ t: 'calibrate', latencyMs });
  }

  /* ------------------------------ results ------------------------------ */

  /** Send the finished clip to every shooter that took part (and anyone else still here). */
  sendResult(data: Uint8Array, meta: { mime: string; name: string }): Promise<void> {
    const run = this.run.value;
    const captureId = run?.id ?? 'none';
    const jobs: Promise<void>[] = [];
    const next: Record<string, DeliveryState> = {};
    for (const peer of this.peers.values()) {
      next[peer.id] = { progress: 0, state: 'sending' };
      const tx = peer.endpoint.send(data, { kind: 'clip', captureId, mime: meta.mime, name: meta.name });
      tx.progressChanged.on((p) => this.patchDelivery(peer.id, { progress: p }));
      jobs.push(
        tx.done.then(
          () => this.patchDelivery(peer.id, { progress: 1, state: 'done' }),
          () => this.patchDelivery(peer.id, { state: 'failed' }),
        ),
      );
    }
    this.delivery.value = next;
    this.announce('sending');
    return Promise.all(jobs).then(() => undefined);
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.broadcast({ t: 'room-closed' });
    for (const peer of this.peers.values()) {
      peer.endpoint.dispose('room closed');
      const link = peer.bus.current;
      setTimeout(() => link?.close(), 300);
    }
  }

  /* ------------------------------ helpers ------------------------------ */

  private broadcast(msg: HostMessage): void {
    for (const peer of this.peers.values()) peer.bus.send(msg);
  }

  private patchShooter(id: string, patch: Partial<ShooterState>): void {
    this.shooters.value = this.shooters.value.map((s) => (s.id === id ? { ...s, ...patch } : s));
  }

  private patchFrame(id: string, patch: Partial<FrameEntry>): void {
    const cur = this.frames.value[id];
    if (!cur) return;
    this.frames.value = { ...this.frames.value, [id]: { ...cur, ...patch } };
  }

  private patchDelivery(id: string, patch: Partial<DeliveryState>): void {
    const cur = this.delivery.value[id] ?? { progress: 0, state: 'sending' };
    this.delivery.value = { ...this.delivery.value, [id]: { ...cur, ...patch } };
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, Math.max(0, ms)));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private async waitFor(cond: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!cond() && Date.now() < until && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}
