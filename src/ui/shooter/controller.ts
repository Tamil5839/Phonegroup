/** Glue for a shooter's phone: camera + rolling buffer + session + sounds. */
import { signal } from '@preact/signals-core';
import { localNow } from '../../core/time';
import { sound } from '../../media/audio';
import { openCamera, type CameraHandle } from '../../media/camera';
import { CameraCapture } from '../../media/capture';
import { tilt } from '../../media/tilt';
import { keepScreenOn } from '../../media/wakeLock';
import { RoomConnector } from '../../net/peer';
import { JoinError, ShooterSession } from '../../session/shooter';
import { deviceInfo } from '../share';
import { clientId, latencyCorrection, saveName, setLatencyCorrection } from '../storage';

export type JoinStep = 'form' | 'starting' | 'joined' | 'error';

export class ShooterController {
  readonly step = signal<JoinStep>('form');
  readonly error = signal<string | null>(null);
  readonly resultUrl = signal<string | null>(null);
  readonly videoShape = signal<'portrait' | 'landscape'>('portrait');
  session: ShooterSession | null = null;
  readonly video: HTMLVideoElement;
  private camera: CameraHandle | null = null;
  private capture: CameraCapture | null = null;
  private connector: RoomConnector | null = null;
  private cancelSounds: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private shapeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly code: string) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
  }

  /** Called from the Join tap: unlocks audio/sensors (need a gesture), opens the camera, connects. */
  async join(name: string): Promise<void> {
    saveName(name);
    sound.unlock();
    void tilt.requestPermission().then(() => tilt.start());
    this.step.value = 'starting';
    this.error.value = null;
    try {
      if (!this.camera) {
        this.camera = await openCamera(this.video);
        this.capture = new CameraCapture(this.video, {
          latencyCorrection,
          rollAt: (t) => tilt.rollAt(t),
        });
        this.capture.start();
        this.shapeTimer = setInterval(() => {
          if (this.video.videoWidth) this.videoShape.value = this.video.videoWidth > this.video.videoHeight ? 'landscape' : 'portrait';
        }, 1000);
      }
    } catch (err) {
      this.error.value = (err as Error).message;
      this.step.value = 'error';
      return;
    }
    this.connector ??= new RoomConnector(this.code);
    const connector = this.connector;
    const session = new ShooterSession({
      clock: localNow,
      connect: () => connector.connect(),
      device: this.capture!,
      clientId: clientId(),
      name,
      deviceInfo: deviceInfo(),
      getLatencyCorrection: latencyCorrection,
      setLatencyCorrection,
    });
    try {
      await session.start();
    } catch (err) {
      this.error.value = err instanceof JoinError ? err.message : 'Could not join the moment.';
      this.step.value = 'error';
      return;
    }
    this.session = session;
    const cam = this.camera!;
    session.setCameraStatus({
      state: 'ready',
      width: cam.width,
      height: cam.height,
      fps: cam.fps,
      timestampSource: this.capture!.timestampSource,
    });
    // Report where frame timestamps come from once frames have flowed for a moment.
    setTimeout(
      () =>
        session.setCameraStatus({
          state: 'ready',
          width: this.video.videoWidth,
          height: this.video.videoHeight,
          fps: cam.fps,
          timestampSource: this.capture!.timestampSource,
        }),
      2000,
    );
    this.unsubs.push(
      session.countdown.subscribe((c) => {
        this.cancelSounds?.();
        this.cancelSounds = c ? sound.scheduleCountdown(c.targetLocal, { chirp: false }) : null;
      }),
      session.result.subscribe((r) => {
        if (this.resultUrl.value) URL.revokeObjectURL(this.resultUrl.value);
        this.resultUrl.value = r ? URL.createObjectURL(new Blob([r.data as BlobPart], { type: r.mime })) : null;
      }),
    );
    keepScreenOn(true);
    this.step.value = 'joined';
  }

  leave(): void {
    this.session?.leave();
  }

  dispose(): void {
    this.cancelSounds?.();
    for (const u of this.unsubs) u();
    if (this.shapeTimer) clearInterval(this.shapeTimer);
    this.session?.leave();
    this.capture?.stop();
    this.camera?.stop();
    setTimeout(() => this.connector?.destroy(), 800);
    if (this.resultUrl.value) URL.revokeObjectURL(this.resultUrl.value);
    keepScreenOn(false);
  }
}
