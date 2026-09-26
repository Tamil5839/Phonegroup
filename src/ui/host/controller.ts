/**
 * Glue for the host's phone: signaling + session + (optionally) its own
 * camera, countdown sounds, turning collected frames into an editing
 * project, sync-test measurements, export and delivery.
 */
import { batch, signal } from '@preact/signals-core';
import { generateRoomCode } from '../../core/roomCode';
import { localNow, median } from '../../core/time';
import { TimecodeLog } from '../../core/timecode';
import { sound } from '../../media/audio';
import { openCamera, type CameraHandle } from '../../media/camera';
import { CameraCapture } from '../../media/capture';
import { tilt } from '../../media/tilt';
import { keepScreenOn } from '../../media/wakeLock';
import { ConnectError, HostSignaling, type SignalingStatus } from '../../net/peer';
import { decodeJpeg, importFiles, type ImportedMedia } from '../../process/importMedia';
import { Project, type ProjectFrame } from '../../process/project';
import { measureSyncFrame } from '../../process/timecodeReader';
import type { ExportResult } from '../../process/export';
import { HOST_ID, HostSession, type FrameEntry } from '../../session/host';

export type HostView = 'lobby' | 'capture' | 'synctest' | 'manual' | 'edit' | 'result';

export interface SyncRow {
  id: string;
  name: string;
  /** Measured from the photo of the host's clock. */
  measuredMs: number | null;
  /** What the phone itself believed. */
  reportedMs: number | null;
  uncertainty: number | null;
  error: string | null;
}

export interface ClipResult {
  blob: Blob;
  url: string;
  name: string;
  mime: string;
  method: ExportResult['method'];
}

function clipName(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `frozen-moment-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

export async function projectFramesFromCapture(entries: FrameEntry[], names: Map<string, string>): Promise<ProjectFrame[]> {
  const out: ProjectFrame[] = [];
  for (const f of entries) {
    if (!f.main) continue;
    try {
      const bitmap = await decodeJpeg(f.main);
      const neighborBytes = { ...f.neighbors };
      out.push({
        id: f.shooterId,
        name: names.get(f.shooterId) ?? f.name,
        bitmap,
        neighbors: {},
        neighborOffsets: Object.keys(neighborBytes).map(Number),
        loadNeighbors: async () => {
          const res: Record<number, ImageBitmap> = {};
          for (const [k, bytes] of Object.entries(neighborBytes)) if (Number(k) > 0) res[Number(k)] = await decodeJpeg(bytes);
          return res;
        },
        roll: typeof f.report?.roll === 'number' ? f.report.roll : null,
        errorMs: typeof f.report?.errorMs === 'number' ? f.report.errorMs : null,
        origin: 'live',
      });
    } catch (err) {
      console.warn('Could not decode frame from', f.name, err);
    }
  }
  return out;
}

export function projectFramesFromImports(items: ImportedMedia[]): ProjectFrame[] {
  return items.map((m) => ({
    id: m.id,
    name: m.name,
    bitmap: m.bitmap,
    neighbors: m.neighbors,
    neighborOffsets: Object.keys(m.neighbors).map(Number),
    roll: null,
    errorMs: null,
    origin: m.kind,
    warning: m.warning,
    file: m.file,
  }));
}

export class HostController {
  readonly status = signal<'starting' | 'ready' | 'error'>('starting');
  readonly error = signal<string | null>(null);
  readonly signaling = signal<SignalingStatus>('online');
  readonly view = signal<HostView>('lobby');
  readonly code = signal('');
  readonly hostShoots = signal(false);
  readonly cameraError = signal<string | null>(null);
  readonly project = signal<Project | null>(null);
  readonly exporting = signal<{ progress: number } | null>(null);
  readonly exportError = signal<string | null>(null);
  readonly result = signal<ClipResult | null>(null);
  readonly syncRows = signal<SyncRow[] | null>(null);
  readonly syncMeasuring = signal(false);
  readonly calibrated = signal(false);
  readonly importing = signal<{ done: number; total: number } | null>(null);
  readonly importNote = signal<string | null>(null);

  session: HostSession | null = null;
  private signalingConn: HostSignaling | null = null;
  readonly video: HTMLVideoElement;
  private camera: CameraHandle | null = null;
  private capture: CameraCapture | null = null;
  private cancelSounds: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private exportAbort: AbortController | null = null;
  /** Sync test: the host screen's time code log. */
  readonly timecodeLog = new TimecodeLog();
  readonly timecodeEpoch = Math.floor(localNow() / 1000) * 1000;
  private disposed = false;

  constructor(readonly offline = false) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
  }

  async start(): Promise<void> {
    this.status.value = 'starting';
    this.error.value = null;
    if (this.offline) {
      // Manual mode without connections: only a code for naming files.
      batch(() => {
        this.code.value = generateRoomCode();
        this.view.value = 'manual';
        this.status.value = 'ready';
      });
      keepScreenOn(true);
      return;
    }
    let conn: HostSignaling | null = null;
    for (let attempt = 0; attempt < 5 && !conn; attempt++) {
      const code = generateRoomCode();
      try {
        conn = await HostSignaling.open(code);
      } catch (err) {
        if ((err as { taken?: boolean }).taken) continue;
        this.error.value = err instanceof ConnectError ? err.message : 'Could not create the moment.';
        this.status.value = 'error';
        return;
      }
    }
    if (!conn || this.disposed) {
      conn?.destroy();
      if (!this.disposed) {
        this.error.value = 'Could not reserve a room code. Try again.';
        this.status.value = 'error';
      }
      return;
    }
    this.signalingConn = conn;
    const session = new HostSession(conn.code, localNow);
    this.session = session;
    conn.connections.on((link) => session.addConnection(link));
    conn.statusChanged.on((s) => (this.signaling.value = s));
    this.unsubs.push(
      session.phase.subscribe((phase) => this.onPhase(phase)),
      session.frames.subscribe(() => void this.addLateFrames()),
    );
    batch(() => {
      this.code.value = conn!.code;
      this.status.value = 'ready';
    });
    keepScreenOn(true);
  }

  /* ------------------------------ host camera ------------------------------ */

  async setHostShoots(on: boolean): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.cameraError.value = null;
    if (!on) {
      session.setLocalDevice(null);
      this.capture?.stop();
      this.camera?.stop();
      this.capture = null;
      this.camera = null;
      this.hostShoots.value = false;
      return;
    }
    try {
      void tilt.requestPermission().then(() => tilt.start());
      this.camera = await openCamera(this.video);
      this.capture = new CameraCapture(this.video, { rollAt: (t) => tilt.rollAt(t) });
      this.capture.start();
      session.setLocalDevice(this.capture, {
        state: 'ready',
        width: this.camera.width,
        height: this.camera.height,
        fps: this.camera.fps,
      });
      this.hostShoots.value = true;
    } catch (err) {
      this.cameraError.value = (err as Error).message;
      this.hostShoots.value = false;
    }
  }

  /* ------------------------------ capture ------------------------------ */

  async freeze(): Promise<void> {
    const session = this.session;
    if (!session) return;
    sound.unlock();
    this.view.value = 'capture';
    try {
      await session.startCapture('moment');
    } catch (err) {
      session.notice.value = (err as Error).message;
      this.view.value = 'lobby';
    }
  }

  async startSyncTest(): Promise<void> {
    const session = this.session;
    if (!session) return;
    sound.unlock();
    this.syncRows.value = null;
    this.calibrated.value = false;
    this.view.value = 'synctest';
    try {
      await session.startCapture('synctest');
    } catch (err) {
      session.notice.value = (err as Error).message;
    }
  }

  cancelCapture(): void {
    this.session?.abortCapture();
    this.cancelSounds?.();
    this.view.value = 'lobby';
  }

  private onPhase(phase: string): void {
    const session = this.session!;
    const run = session.run.value;
    if (phase === 'countdown' && run) {
      this.cancelSounds?.();
      // The host plays the moment chirp at T: manual-mode videos are matched on it.
      this.cancelSounds = sound.scheduleCountdown(run.target, { chirp: run.mode === 'moment' });
    }
    if (phase === 'review' && run) {
      if (run.mode === 'synctest') void this.measureSyncTest();
      else void this.openEditor();
    }
  }

  private names(): Map<string, string> {
    return new Map((this.session?.shooters.value ?? []).map((s) => [s.id, s.name]));
  }

  private async openEditor(): Promise<void> {
    const session = this.session!;
    const order = session.run.value?.participants ?? session.order.value;
    const frames = session.frames.value;
    const entries = order.map((id) => frames[id]).filter((f): f is FrameEntry => !!f && f.status === 'done');
    this.project.value?.dispose();
    const project = new Project();
    project.updateSettings({ aspect: session.settings.value.orientation === 'landscape' ? '16:9' : '9:16' });
    project.addFrames(await projectFramesFromCapture(entries, this.names()));
    this.project.value = project;
    this.view.value = 'edit';
    session.announce('editing');
  }

  /** Frames that arrive after the collection window still join the edit. */
  private async addLateFrames(): Promise<void> {
    const project = this.project.value;
    const session = this.session;
    if (!project || !session || session.run.value?.mode !== 'moment') return;
    const have = new Set(project.frames.value.map((f) => f.id));
    const late = Object.values(session.frames.value).filter((f) => f.status === 'done' && f.main && !have.has(f.shooterId));
    if (late.length) project.addFrames(await projectFramesFromCapture(late, this.names()));
  }

  /* ------------------------------ sync test ------------------------------ */

  private async measureSyncTest(): Promise<void> {
    const session = this.session!;
    const run = session.run.value!;
    this.syncMeasuring.value = true;
    const shooters = new Map(session.shooters.value.map((s) => [s.id, s]));
    const rows: SyncRow[] = [];
    for (const id of run.participants) {
      const f = session.frames.value[id];
      const s = shooters.get(id);
      const row: SyncRow = {
        id,
        name: s?.name ?? f?.name ?? id,
        measuredMs: null,
        reportedMs: typeof f?.report?.errorMs === 'number' ? f.report.errorMs : null,
        uncertainty: s?.sync?.uncertainty ?? null,
        error: null,
      };
      if (!f?.main) row.error = f?.error ?? 'No photo arrived';
      else {
        const m = await measureSyncFrame(f.main, this.timecodeLog, run.target);
        if ('error' in m) row.error = m.error;
        else row.measuredMs = m.errorMs;
      }
      rows.push(row);
    }
    this.syncRows.value = rows;
    this.syncMeasuring.value = false;
  }

  /**
   * Store each phone's measured offset as a correction, relative to the
   * group's median so the whole group isn't shifted by the host display's
   * own latency.
   */
  applyCalibration(): void {
    const rows = this.syncRows.value;
    const session = this.session;
    if (!rows || !session) return;
    const measured = rows.filter((r) => r.measuredMs !== null && r.reportedMs !== null && r.id !== HOST_ID);
    if (measured.length < 2) return;
    const bias = measured.map((r) => r.reportedMs! - r.measuredMs!);
    const mid = median(bias);
    measured.forEach((r, i) => session.calibrate(r.id, bias[i] - mid));
    this.calibrated.value = true;
  }

  backToLobby(): void {
    this.session?.newMoment();
    this.view.value = 'lobby';
  }

  /* ------------------------------ edit & export ------------------------------ */

  /** Manual mode: start editing from imported photos/videos only. */
  async editImports(files: File[]): Promise<void> {
    if (files.length === 0) return;
    this.project.value?.dispose();
    this.project.value = new Project();
    await this.importMedia(files);
    this.view.value = 'edit';
  }

  async importMedia(files: File[]): Promise<void> {
    const project = this.project.value;
    if (!project || files.length === 0) return;
    this.importing.value = { done: 0, total: files.length };
    const { items, failed } = await importFiles(files, (done, total) => (this.importing.value = { done, total }));
    project.addFrames(projectFramesFromImports(items));
    this.importing.value = null;
    const warnings = items.filter((i) => i.warning).map((i) => `${i.name}: ${i.warning}`);
    this.importNote.value = [...failed, ...warnings].join(' ') || null;
  }

  async createClip(): Promise<void> {
    const project = this.project.value;
    if (!project) return;
    this.exportError.value = null;
    this.exportAbort = new AbortController();
    this.exporting.value = { progress: 0 };
    this.session?.announce('rendering');
    try {
      const res = await project.export((p) => (this.exporting.value = { progress: p }), this.exportAbort.signal);
      const name = clipName(res.ext);
      if (this.result.value) URL.revokeObjectURL(this.result.value.url);
      this.result.value = { blob: res.blob, url: URL.createObjectURL(res.blob), name, mime: res.mime, method: res.method };
      this.view.value = 'result';
      const bytes = new Uint8Array(await res.blob.arrayBuffer());
      void this.session?.sendResult(bytes, { mime: res.mime, name });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.exportError.value = `Couldn't create the clip: ${(err as Error).message}`;
        this.session?.announce('failed', 'The host could not create the clip.');
      }
    } finally {
      this.exporting.value = null;
    }
  }

  cancelExport(): void {
    this.exportAbort?.abort();
  }

  editAgain(): void {
    this.view.value = 'edit';
  }

  newMoment(): void {
    this.project.value?.dispose();
    batch(() => {
      this.project.value = null;
      if (this.result.value) URL.revokeObjectURL(this.result.value.url);
      this.result.value = null;
      this.view.value = this.offline ? 'manual' : 'lobby';
    });
    this.session?.newMoment();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSounds?.();
    for (const u of this.unsubs) u();
    this.session?.close();
    setTimeout(() => this.signalingConn?.destroy(), 500);
    this.capture?.stop();
    this.camera?.stop();
    this.project.value?.dispose();
    keepScreenOn(false);
  }
}
