import { Fragment } from 'preact';
import { useMemo } from 'preact/hooks';
import { errorSpread } from '../../core/frames';
import { encodePayload } from '../../process/timecodeReader';
import { InlineCountdown, TopBar } from '../components';
import { TimecodeDisplay } from '../TimecodeDisplay';
import type { HostController, SyncRow } from './controller';

function fmt(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${ms >= 0 ? '+' : '−'}${Math.abs(ms).toFixed(0)} ms`;
}

function Results({ ctl, rows }: { ctl: HostController; rows: SyncRow[] }) {
  const measured = rows.map((r) => r.measuredMs).filter((v): v is number => v !== null);
  const spread = errorSpread(measured);
  const worst = measured.length ? Math.max(...measured.map((v) => Math.abs(v))) : null;
  const canCalibrate = rows.filter((r) => r.measuredMs !== null && r.reportedMs !== null && r.id !== 'host').length >= 2;
  return (
    <>
      <div class="card stack">
        <div class="row">
          <span class="muted">Spread between phones</span>
          <div class="spacer" />
          <strong class="mono" style={{ fontSize: 24 }}>
            {measured.length >= 2 ? `${spread.toFixed(0)} ms` : '—'}
          </strong>
        </div>
        <div class="row">
          <span class="muted">Largest error from the target</span>
          <div class="spacer" />
          <span class="mono">{worst === null ? '—' : `${worst.toFixed(0)} ms`}</span>
        </div>
        <p class="muted small">
          Measured = the time actually shown in each phone's photo of this screen, minus the target. It includes this screen's own display
          delay (the same for every phone), so the spread between phones is the number that matters. One video frame is ~33 ms at 30 fps.
        </p>
      </div>
      <div class="card" style={{ overflowX: 'auto' }}>
        <table class="table">
          <thead>
            <tr>
              <th>Phone</th>
              <th style={{ textAlign: 'right' }}>Measured</th>
              <th style={{ textAlign: 'right' }}>Phone's estimate</th>
              <th style={{ textAlign: 'right' }}>Sync ±</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td style={r.error ? { borderBottom: 0 } : undefined}>{r.name}</td>
                  <td class="num" style={r.error ? { borderBottom: 0 } : undefined}>
                    {fmt(r.measuredMs)}
                  </td>
                  <td class="num" style={r.error ? { borderBottom: 0 } : undefined}>
                    {fmt(r.reportedMs)}
                  </td>
                  <td class="num" style={r.error ? { borderBottom: 0 } : undefined}>
                    {r.uncertainty === null ? '—' : `${r.uncertainty.toFixed(0)} ms`}
                  </td>
                </tr>
                {r.error && (
                  <tr>
                    <td colSpan={4} class="small" style={{ color: 'var(--warn)', paddingTop: 0 }}>
                      {r.error}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div class="bottom-actions">
        <button class="btn primary block" disabled={!canCalibrate || ctl.calibrated.value} onClick={() => ctl.applyCalibration()}>
          {ctl.calibrated.value ? 'Calibration saved on each phone' : 'Save as calibration'}
        </button>
        <p class="muted small" style={{ textAlign: 'center' }}>
          Calibration stores each phone's measured offset (relative to the group) and corrects its timestamps from now on.
        </p>
        <div class="row">
          <button
            class="btn block"
            onClick={() => {
              ctl.syncRows.value = null;
              ctl.session?.newMoment();
            }}
          >
            Run again
          </button>
          <button class="btn block" onClick={() => ctl.backToLobby()}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

export function SyncTestView({ ctl }: { ctl: HostController }) {
  const session = ctl.session!;
  const phase = session.phase.value;
  const run = session.run.value;
  const rows = ctl.syncRows.value;
  const frames = session.frames.value;
  const payload = useMemo(() => encodePayload({ room: ctl.code.value, epoch: ctl.timecodeEpoch, moment: null }), [ctl]);
  const running = phase === 'syncing' || phase === 'countdown' || phase === 'collecting';
  const arrived = Object.values(frames).filter((f) => f.status === 'done').length;
  const total = Object.keys(frames).length;

  return (
    <main class="screen">
      <TopBar
        title="Sync test"
        onBack={() => {
          if (running) ctl.cancelCapture();
          ctl.backToLobby();
        }}
      />
      {rows ? (
        <Results ctl={ctl} rows={rows} />
      ) : (
        <>
          <p class="lead">Everyone: point your phone at this screen so the whole code is in view, then hold still.</p>
          <TimecodeDisplay payload={payload} epoch={ctl.timecodeEpoch} log={ctl.timecodeLog} />
          <div class="row" style={{ justifyContent: 'center', minHeight: 44 }} role="status">
            {phase === 'syncing' && <span class="chip">Syncing clocks…</span>}
            {phase === 'countdown' && run && <InlineCountdown targetLocal={run.target} />}
            {phase === 'collecting' && (
              <span class="chip">
                Photos in: {arrived}/{total}
              </span>
            )}
            {ctl.syncMeasuring.value && <span class="chip accent">Reading the clock in each photo…</span>}
          </div>
          {session.notice.value && <div class="notice warn">{session.notice.value}</div>}
          <div class="bottom-actions">
            <button class="btn primary big block" disabled={running || ctl.syncMeasuring.value} onClick={() => void ctl.startSyncTest()}>
              Start test
            </button>
            {phase === 'collecting' && (
              <button class="btn block" onClick={() => session.finishCollection()}>
                Continue with {arrived} photo{arrived === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
