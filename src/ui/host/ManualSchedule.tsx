import { useEffect, useRef, useState } from 'preact/hooks';
import { localNow } from '../../core/time';
import { sound } from '../../media/audio';
import type { FrameEntry } from '../../session/host';
import { Countdown, QRCode, Segmented, TopBar, useNow } from '../components';
import { manualUrl, navigate } from '../router';
import { TimecodeDisplay } from '../TimecodeDisplay';
import { CollectArc } from './CaptureView';
import type { HostController } from './controller';

const LEADS = [
  { id: '30', label: '30 s' },
  { id: '60', label: '1 min' },
  { id: '120', label: '2 min' },
];

/**
 * Manual mode (host side): announce a moment T ahead of time with a QR code.
 * Phones without a connection scan it and count down on their own clock;
 * connected phones (mixed groups) get the regular synced countdown to the
 * same T. The host plays the moment chirp at T for videos to be matched on.
 */
export function ManualSchedule({ ctl }: { ctl: HostController }) {
  const session = ctl.session;
  const [lead, setLead] = useState('60');
  const [moment, setMoment] = useState<number | null>(null);
  const [connectedAtStart, setConnectedAtStart] = useState(0);
  const now = useNow(200);
  const fileRef = useRef<HTMLInputElement>(null);
  const epoch = ctl.timecodeEpoch;

  useEffect(() => {
    if (moment === null) return;
    const participants = session ? session.readyParticipants() : [];
    setConnectedAtStart(participants.length);
    let cancelSound: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (session && participants.length > 0) {
      // Leave time for the re-sync (up to ~4 s) before the countdown to the fixed moment.
      timer = setTimeout(
        () => {
          session.startCapture('moment', { target: moment }).catch((err: Error) => (session.notice.value = err.message));
        },
        Math.max(0, moment - 8500 - localNow()),
      );
    } else {
      cancelSound = sound.scheduleCountdown(moment, { chirp: true });
    }
    return () => {
      if (timer) clearTimeout(timer);
      cancelSound?.();
    };
  }, [moment]);

  const code = ctl.code.value;
  const url = moment !== null ? manualUrl(code, moment, epoch) : null;
  const remaining = moment !== null ? moment - now : null;
  const passed = remaining !== null && remaining < -800;
  const frames = session?.frames.value ?? {};
  const entries = Object.values(frames).filter((f): f is FrameEntry => !!f);

  const onBack = () => {
    if (moment !== null && remaining !== null && remaining > 0 && !confirm('Cancel this moment?')) return;
    if (ctl.offline) navigate('/');
    else {
      if (session && session.phase.value !== 'lobby') session.abortCapture();
      ctl.view.value = 'lobby';
    }
  };

  return (
    <main class="screen">
      <TopBar title="Manual moment" onBack={onBack} />
      {moment === null ? (
        <>
          <p class="lead">
            For phones that can't connect: announce the moment in advance. Everyone scans the code and their phone counts down to the same
            instant.
          </p>
          <div class="card stack">
            <div class="field">
              <span class="label">The moment happens in</span>
              <Segmented label="Lead time" value={lead} options={LEADS} onChange={setLead} />
            </div>
            <p class="muted small">
              Turn your volume up: at the moment your phone plays a short chirp. People who record a video instead of using the app are
              matched on that sound.
            </p>
            <button class="btn small" onClick={() => sound.testChirp()}>
              Test the chirp
            </button>
          </div>
          {!ctl.offline && session && (
            <div class="notice info">
              {session.readyParticipants().length} connected phone(s) will also count down to this moment automatically.
            </div>
          )}
          <div class="bottom-actions">
            <button
              class="btn primary big block"
              onClick={() => {
                sound.unlock();
                setMoment(Math.round(localNow() + Number(lead) * 1000));
              }}
            >
              Schedule the moment
            </button>
          </div>
        </>
      ) : !passed ? (
        <>
          <div class="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 4 }}>
            <div class="eyebrow">Moment in</div>
            <div class="mono" style={{ fontSize: 56, fontWeight: 850 }} aria-live="off">
              {Math.max(0, Math.ceil((remaining ?? 0) / 1000))} s
            </div>
          </div>
          <p class="muted" style={{ textAlign: 'center' }}>
            Scan with the phone camera. Pointing the camera at this screen after opening the link fine-tunes the timing.
          </p>
          {url && <TimecodeDisplay payload={url} epoch={epoch} />}
          <details class="card">
            <summary>No app? Record a video instead</summary>
            <p class="muted small" style={{ marginTop: 8 }}>
              Start recording with the normal camera app about 5 seconds before the moment and stop 5 seconds after. Send the video to the
              host — the moment is found from the chirp.
            </p>
          </details>
          {remaining !== null && remaining < 3600 && <Countdown targetLocal={moment} />}
        </>
      ) : (
        <>
          <div class="stack" style={{ gap: 6 }}>
            <div class="eyebrow">Captured</div>
            <h2>Now gather the photos</h2>
            <p class="muted">
              Ask everyone to send their photo (the app offers “Send to host”) or their video to you — any messaging app works. Then import
              them here.
            </p>
          </div>
          {connectedAtStart > 0 && entries.length > 0 && <CollectArc entries={entries} />}
          {url && (
            <details class="card">
              <summary>Show the code again</summary>
              <div class="qr-card" style={{ marginTop: 12 }}>
                <QRCode value={url} label="Manual moment code" />
              </div>
            </details>
          )}
          <div class="bottom-actions">
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              multiple
              class="visually-hidden"
              onChange={(e) => {
                const files = Array.from((e.currentTarget as HTMLInputElement).files ?? []);
                if (!files.length) return;
                if (ctl.project.value) void ctl.importMedia(files).then(() => (ctl.view.value = 'edit'));
                else void ctl.editImports(files);
              }}
            />
            {ctl.importing.value && (
              <div class="notice info" role="status">
                Importing {ctl.importing.value.done}/{ctl.importing.value.total}… (videos are searched for the chirp)
              </div>
            )}
            <button class="btn primary big block" onClick={() => fileRef.current?.click()} disabled={!!ctl.importing.value}>
              Import photos &amp; videos
            </button>
            {ctl.project.value && (
              <button class="btn block" onClick={() => (ctl.view.value = 'edit')}>
                Go to the editor
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
