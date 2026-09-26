import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { formatRoomCode } from '../../core/roomCode';
import { localNow, median } from '../../core/time';
import { sound } from '../../media/audio';
import { openCamera, type CameraHandle } from '../../media/camera';
import { CameraCapture } from '../../media/capture';
import { tilt } from '../../media/tilt';
import { keepScreenOn } from '../../media/wakeLock';
import { hostTimeFromFormula, readTimecode } from '../../process/timecodeReader';
import { AimOverlay, Countdown, LevelChip, Mount, TopBar, useNow } from '../components';
import { navigate } from '../router';
import { download, shareFile } from '../share';
import { latencyCorrection, saveName, savedName } from '../storage';

interface Photo {
  bytes: Uint8Array;
  url: string;
  errorMs: number;
}

/**
 * Manual mode without a connection. Host time is first estimated from this
 * phone's own clock (phones keep their clocks roughly right); pointing the
 * camera at the host's screen reads its time code and refines the estimate.
 */
class ManualShooterController {
  readonly step = signal<'form' | 'armed' | 'capturing' | 'done' | 'error'>('form');
  readonly error = signal<string | null>(null);
  /** hostTime ≈ localTime + offset */
  readonly offset = signal(Date.now() - localNow());
  readonly optical = signal<{ state: 'idle' | 'reading' | 'locked' | 'failed'; samples: number; spread: number | null }>({
    state: 'idle',
    samples: 0,
    spread: null,
  });
  readonly photo = signal<Photo | null>(null);
  readonly video: HTMLVideoElement;
  private camera: CameraHandle | null = null;
  private capture: CameraCapture | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelSounds: (() => void) | null = null;
  name = '';
  position: number | null = null;

  constructor(
    readonly code: string,
    readonly moment: number,
    readonly epoch: number | null,
  ) {
    this.video = document.createElement('video');
  }

  get targetLocal(): number {
    return this.moment - this.offset.value;
  }

  async arm(name: string, position: number | null): Promise<void> {
    this.name = name;
    this.position = position;
    saveName(name);
    sound.unlock();
    void tilt.requestPermission().then(() => tilt.start());
    try {
      this.camera = await openCamera(this.video);
      this.capture = new CameraCapture(this.video, { latencyCorrection, rollAt: (t) => tilt.rollAt(t) });
      this.capture.start();
    } catch (err) {
      this.error.value = (err as Error).message;
      this.step.value = 'error';
      return;
    }
    keepScreenOn(true);
    this.step.value = 'armed';
    this.schedule();
  }

  /** (Re)schedule sounds and the capture for the current offset estimate. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.cancelSounds?.();
    const target = this.targetLocal;
    if (target - localNow() < -500) {
      this.error.value = 'This moment has already passed.';
      this.step.value = 'error';
      return;
    }
    this.cancelSounds = sound.scheduleCountdown(target, { chirp: false });
    // Start the pick shortly before T, so the latest sync estimate is used.
    this.timer = setTimeout(() => void this.shoot(), Math.max(0, target - 1200 - localNow()));
  }

  private async shoot(): Promise<void> {
    if (!this.capture) return;
    this.step.value = 'capturing';
    const offset = this.offset.value;
    try {
      const frames = await this.capture.capture({
        captureId: 'manual',
        mode: 'moment',
        target: this.moment,
        toHost: (t) => t + offset,
        toLocal: (t) => t - offset,
        syncUncertainty: NaN,
      });
      if (!frames.main) throw new Error('No frame was captured.');
      const url = URL.createObjectURL(new Blob([frames.main as BlobPart], { type: 'image/jpeg' }));
      this.photo.value = { bytes: frames.main, url, errorMs: frames.report.errorMs ?? 0 };
      this.step.value = 'done';
    } catch (err) {
      this.error.value = (err as Error).message;
      this.step.value = 'error';
    }
  }

  /** Read the host screen's time code for a few seconds and average the offset. */
  async opticalSync(): Promise<void> {
    const capture = this.capture;
    if (!capture) return;
    this.optical.value = { state: 'reading', samples: 0, spread: null };
    const samples: number[] = [];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const until = localNow() + 7000;
    while (localNow() < until && samples.length < 12 && this.step.value === 'armed') {
      const frame = capture.latest();
      if (frame) {
        const k = Math.min(1, 1280 / Math.max(frame.canvas.width, frame.canvas.height));
        canvas.width = Math.round(frame.canvas.width * k);
        canvas.height = Math.round(frame.canvas.height * k);
        ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
        const reading = await readTimecode(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (reading && (this.epoch === null || Math.abs(reading.payload.epoch - this.epoch) < 1)) {
          const rough = frame.local + this.offset.value;
          const hostTime = hostTimeFromFormula(reading.read, reading.payload.epoch, rough);
          samples.push(hostTime - frame.local);
          this.optical.value = { state: 'reading', samples: samples.length, spread: null };
        }
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (samples.length >= 3) {
      const m = median(samples);
      const spread = median(samples.map((s) => Math.abs(s - m)));
      this.offset.value = m;
      this.optical.value = { state: 'locked', samples: samples.length, spread };
      this.schedule();
    } else {
      this.optical.value = { state: 'failed', samples: samples.length, spread: null };
    }
  }

  fileName(): string {
    const pos = this.position ? `-pos${String(this.position).padStart(2, '0')}` : '';
    const safe =
      this.name
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20) || 'shooter';
    return `frozen-${this.code}${pos}-${safe}.jpg`;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.cancelSounds?.();
    this.capture?.stop();
    this.camera?.stop();
    if (this.photo.value) URL.revokeObjectURL(this.photo.value.url);
    keepScreenOn(false);
  }
}

export function ManualShooter({ code, moment, epoch }: { code: string; moment: number; epoch: number | null }) {
  const [ctl] = useState(() => new ManualShooterController(code, moment, epoch));
  const [name, setName] = useState(savedName());
  const [position, setPosition] = useState('');
  const now = useNow(250);
  useEffect(() => () => ctl.dispose(), [ctl]);
  const step = ctl.step.value;
  const remaining = ctl.targetLocal - now;
  const photo = ctl.photo.value;
  const optical = ctl.optical.value;

  if (step === 'form' || step === 'error') {
    return (
      <main class="screen">
        <TopBar title={`Manual moment ${formatRoomCode(code)}`} onBack={() => navigate('/')} />
        <div class="stack">
          <div class="eyebrow">Manual mode</div>
          <h2>{remaining > 0 ? `The moment is in ${Math.ceil(remaining / 1000)} s` : 'This moment has passed'}</h2>
          <p class="muted">
            Your phone counts down on its own clock and keeps the frame at the moment. Afterwards, send the photo to the host with any
            messaging app.
          </p>
        </div>
        <div class="notice info small">
          Your photo stays on your phone until you choose to send it. Please make sure the person you're filming is happy to be filmed.
        </div>
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void ctl.arm(name.trim() || 'Shooter', position ? Number(position) : null);
          }}
        >
          <div class="field">
            <label for="mname">Your name</label>
            <input
              id="mname"
              class="input"
              maxLength={24}
              value={name}
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="mpos">Your place in the curve (from the left)</label>
            <select id="mpos" class="input" value={position} onChange={(e) => setPosition((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Not sure</option>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={String(i + 1)}>
                  #{i + 1}
                </option>
              ))}
            </select>
          </div>
          {ctl.error.value && <div class="notice error">{ctl.error.value}</div>}
          <button class="btn primary big block" disabled={remaining < 1500}>
            Start camera
          </button>
        </form>
        <details class="card">
          <summary>Can't use the camera here?</summary>
          <p class="muted small" style={{ marginTop: 8 }}>
            Record a video with your normal camera app from about 5 seconds before the moment until 5 seconds after, then send it to the
            host. The host's phone plays a chirp at the moment, and the app finds your frame from it.
          </p>
        </details>
      </main>
    );
  }

  if (step === 'done' && photo) {
    return (
      <main class="screen">
        <TopBar title="Captured" />
        <img class="clip" src={photo.url} alt="Your frame of the moment" />
        <p class="muted small">
          {optical.state === 'locked' ? 'Timed with the host screen’s clock.' : 'Timed with your phone’s own clock.'} Frame{' '}
          {Math.abs(photo.errorMs).toFixed(0)} ms from the moment.
        </p>
        <div class="bottom-actions">
          <button
            class="btn primary big block"
            onClick={() =>
              void shareFile(new Blob([photo.bytes as BlobPart], { type: 'image/jpeg' }), ctl.fileName(), 'My frame for the frozen moment')
            }
          >
            Send to host
          </button>
          <button class="btn block" onClick={() => download(new Blob([photo.bytes as BlobPart], { type: 'image/jpeg' }), ctl.fileName())}>
            Save photo
          </button>
          <button class="btn ghost block" onClick={() => navigate('/')}>
            Done
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <div class="camera-stage">
        <Mount el={ctl.video} />
      </div>
      <AimOverlay />
      <div class="camera-ui">
        <div class="glass stack" style={{ gap: 8 }}>
          <div class="row">
            <strong>{remaining > 0 ? `Moment in ${Math.ceil(remaining / 1000)} s` : 'Capturing…'}</strong>
            <div class="spacer" />
            <LevelChip />
          </div>
          {step === 'armed' && remaining > 4000 && (
            <div class="row wrap">
              {optical.state === 'idle' && (
                <button class="btn small" onClick={() => void ctl.opticalSync()}>
                  Sync with host screen
                </button>
              )}
              {optical.state === 'reading' && <span class="chip">Point at the host's screen… {optical.samples}/12</span>}
              {optical.state === 'locked' && (
                <span class="chip ok">
                  <span class="dot" />
                  Synced ±{Math.max(1, optical.spread ?? 0).toFixed(0)} ms
                </span>
              )}
              {optical.state === 'failed' && (
                <button class="btn small" onClick={() => void ctl.opticalSync()}>
                  Couldn't read it — try again
                </button>
              )}
            </div>
          )}
        </div>
        <div class="spacer" />
        <div class="glass small muted">Aim at the subject and hold still through the countdown.</div>
      </div>
      {remaining < 4000 && <Countdown targetLocal={ctl.targetLocal} />}
    </>
  );
}
