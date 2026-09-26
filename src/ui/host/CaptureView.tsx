import { errorSpread } from '../../core/frames';
import type { FrameEntry } from '../../session/host';
import { AimOverlay, Countdown, JpegThumb, Mount, Ring, useNow } from '../components';
import type { HostController } from './controller';

/** Thumbnails filling an arc, in the same left-to-right order as the phones. */
export function CollectArc({ entries }: { entries: FrameEntry[] }) {
  const n = entries.length;
  const done = entries.filter((f) => f.status === 'done').length;
  return (
    <div class="arc" role="list" aria-label="Photos arriving">
      {entries.map((f, i) => {
        const a = Math.PI * (1 - (i + 0.5) / n);
        const left = 50 + Math.cos(a) * 41;
        const top = 78 - Math.sin(a) * 58;
        // Smaller tiles for big groups so neighbours don't overlap.
        const width = Math.max(6, Math.min(18, 150 / n));
        return (
          <div
            key={f.shooterId}
            role="listitem"
            class={`slot ${f.status}`}
            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%` }}
            aria-label={`${f.name}: ${f.status}`}
          >
            {f.main ? (
              <JpegThumb bytes={f.main} alt={f.name} />
            ) : f.status === 'missing' || f.status === 'failed' ? (
              <span aria-hidden="true">✕</span>
            ) : (
              <Ring value={f.mainProgress} size={44} />
            )}
          </div>
        );
      })}
      <div class="center" aria-live="polite">
        <div class="count">
          {done}/{n}
        </div>
        <div class="muted small">photos in</div>
      </div>
    </div>
  );
}

export function CaptureView({ ctl }: { ctl: HostController }) {
  const session = ctl.session!;
  const phase = session.phase.value;
  const run = session.run.value;
  const frames = session.frames.value;
  const now = useNow(500);
  const entries = (run?.participants ?? Object.keys(frames)).map((id) => frames[id]).filter((f): f is FrameEntry => !!f);
  const hostShoots = ctl.hostShoots.value && !!run?.participants.includes('host');

  if (phase === 'syncing' || (phase === 'countdown' && run)) {
    return (
      <>
        {hostShoots && (
          <>
            <div class="camera-stage">
              <Mount el={ctl.video} />
            </div>
            <AimOverlay />
          </>
        )}
        <div class="camera-ui">
          <div class="glass row">
            <strong>{phase === 'syncing' ? 'Syncing every clock…' : 'Countdown on all phones'}</strong>
            <div class="spacer" />
            <button class="btn small ghost" onClick={() => ctl.cancelCapture()}>
              Cancel
            </button>
          </div>
        </div>
        {phase === 'countdown' && run && <Countdown targetLocal={run.target} />}
        {phase === 'syncing' && (
          <div class="countdown">
            <div class="caption">Syncing clocks…</div>
          </div>
        )}
      </>
    );
  }

  const errors = entries.map((f) => f.report?.errorMs);
  const left = run ? Math.max(0, Math.ceil((run.deadline - now) / 1000)) : 0;
  const done = entries.filter((f) => f.status === 'done').length;
  return (
    <main class="screen">
      <div class="stack" style={{ gap: 6 }}>
        <div class="eyebrow">Captured</div>
        <h2>Collecting the photos</h2>
        <p class="muted">Each phone sends its frame of the moment. This takes a few seconds on Wi-Fi.</p>
      </div>
      <CollectArc entries={entries} />
      <div class="card stack small">
        <div class="row">
          <span class="muted">Timing spread between phones</span>
          <div class="spacer" />
          <span class="mono">{errors.some((e) => typeof e === 'number') ? `${errorSpread(errors).toFixed(0)} ms` : '—'}</span>
        </div>
        <p class="muted">
          Each phone picks its camera frame nearest to the moment; expect about one video frame (~33 ms) plus clock-sync uncertainty.
        </p>
      </div>
      <div class="bottom-actions">
        {phase === 'collecting' && (
          <p class="muted small" style={{ textAlign: 'center' }}>
            {left > 0 ? `Waiting up to ${left} s for the rest…` : 'Wrapping up…'}
          </p>
        )}
        <button class="btn primary block" disabled={done < 1} onClick={() => session.finishCollection()}>
          Continue with {done} photo{done === 1 ? '' : 's'}
        </button>
      </div>
    </main>
  );
}
