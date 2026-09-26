import { useEffect, useState } from 'preact/hooks';
import { formatRoomCode, normalizeRoomCode } from '../../core/roomCode';
import { AimOverlay, Bar, Countdown, LevelChip, Mount, SyncChip, TopBar } from '../components';
import { navigate } from '../router';
import { download, shareFile } from '../share';
import { savedName } from '../storage';
import { ShooterController } from './controller';

function CodeEntry() {
  const [code, setCode] = useState('');
  const normalized = normalizeRoomCode(code);
  return (
    <main class="screen">
      <TopBar title="Join a moment" onBack={() => navigate('/')} />
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (normalized) navigate(`/j/${normalized}`);
        }}
      >
        <div class="field">
          <label for="code">Code on the host's screen</label>
          <input
            id="code"
            class="input code"
            autoComplete="off"
            autoCapitalize="characters"
            spellcheck={false}
            maxLength={9}
            placeholder="ABC 123"
            value={code}
            onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
            autoFocus
          />
        </div>
        <button class="btn primary big block" disabled={!normalized}>
          Continue
        </button>
      </form>
    </main>
  );
}

function ConsentForm({ ctl }: { ctl: ShooterController }) {
  const [name, setName] = useState(savedName());
  const busy = ctl.step.value === 'starting';
  return (
    <main class="screen">
      <TopBar title={`Moment ${formatRoomCode(ctl.code)}`} onBack={() => navigate('/')} />
      <div class="stack">
        <div class="eyebrow">You're invited</div>
        <h2>Become one of the cameras</h2>
        <p class="muted">Everyone stands in a curve around the subject. A countdown runs on every phone and all of them capture the same instant.</p>
      </div>
      <div class="notice info">
        <strong>Your privacy:</strong> your photo is sent only to the host's phone, and the finished clip comes back to the people in this moment.
        Nothing is uploaded to a server. Please make sure the person you're filming is happy to be filmed.
      </div>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void ctl.join(name.trim() || 'Shooter');
        }}
      >
        <div class="field">
          <label for="name">Your name (so the host can place you)</label>
          <input id="name" class="input" maxLength={24} autoComplete="nickname" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </div>
        {ctl.error.value && <div class="notice error">{ctl.error.value}</div>}
        <button class="btn primary big block" disabled={busy}>
          {busy ? 'Connecting…' : 'Join & allow camera'}
        </button>
        {ctl.step.value === 'error' && (
          <button class="link-btn" type="button" onClick={() => navigate('/help')}>
            Trouble connecting? Read the tips, or use manual mode.
          </button>
        )}
      </form>
    </main>
  );
}

function ShooterView({ ctl }: { ctl: ShooterController }) {
  const s = ctl.session!;
  const phase = s.phase.value;
  const lineup = s.lineup.value;
  const settings = s.settings.value;
  const countdown = s.countdown.value;
  const report = s.lastReport.value;
  const result = s.result.value;
  const url = ctl.resultUrl.value;
  const wrongShape = settings.orientation !== ctl.videoShape.value;

  if (phase === 'ended') {
    return (
      <main class="screen">
        <TopBar title="Moment ended" />
        <div class="notice">{s.endedReason.value}</div>
        {result && url && <video class="clip" src={url} autoplay loop muted playsInline controls />}
        <div class="bottom-actions">
          <button class="btn primary block" onClick={() => navigate('/')}>
            Home
          </button>
        </div>
      </main>
    );
  }

  if (phase === 'result' && result && url) {
    return (
      <main class="screen">
        <TopBar title="Your frozen moment" />
        <video class="clip" src={url} autoplay loop muted playsInline controls aria-label="The finished clip" />
        <div class="bottom-actions">
          <button class="btn primary big block" onClick={() => void shareFile(new Blob([result.data as BlobPart], { type: result.mime }), result.name, 'Made with Frozen Moment')}>
            Share
          </button>
          <button class="btn block" onClick={() => download(new Blob([result.data as BlobPart], { type: result.mime }), result.name)}>
            Save
          </button>
          <p class="muted small" style={{ textAlign: 'center' }}>
            Stay on this page for another moment — the next countdown will start automatically.
          </p>
        </div>
      </main>
    );
  }

  const busyPanel =
    phase === 'sending' ? (
      <div class="glass stack" role="status">
        <strong>Got it! Sending your photo to the host…</strong>
        <Bar value={s.sendProgress.value} label="Sending" />
        {report?.errorMs !== undefined && <span class="muted small">Your frame was {Math.abs(report.errorMs).toFixed(0)} ms from the moment.</span>}
      </div>
    ) : phase === 'waiting' ? (
      <div class="glass stack" role="status">
        <strong>Sent. The host is making the clip…</strong>
        {s.resultProgress.value !== null ? (
          <Bar value={s.resultProgress.value} label="Receiving the clip" />
        ) : (
          <span class="muted small">
            {s.hostStage.value === 'rendering' ? 'Rendering…' : s.hostStage.value === 'editing' ? 'Lining up the photos…' : 'Hang on — the clip will appear here.'}
          </span>
        )}
      </div>
    ) : null;

  return (
    <>
      <div class="camera-stage">
        <Mount el={ctl.video} />
      </div>
      <AimOverlay />
      <div class="camera-ui">
        <div class="glass stack" style={{ gap: 8 }}>
          <div class="row">
            <div class="position-badge" aria-live="polite">
              <span class="muted small">You are</span>
              <span class="big">#{lineup?.index ?? '–'}</span>
              <span class="muted small">of {lineup?.total ?? '–'}</span>
            </div>
            <div class="spacer" />
            <button class="btn small ghost" onClick={() => confirm('Leave this moment?') && (ctl.leave(), navigate('/'))}>
              Leave
            </button>
          </div>
          <div class="row wrap">
            <SyncChip uncertainty={s.sync.value?.uncertainty} rtt={s.sync.value?.bestRtt} />
            <LevelChip />
            {phase === 'reconnecting' && (
              <span class="chip warn">
                <span class="dot" />
                Reconnecting…
              </span>
            )}
          </div>
        </div>
        <div class="spacer" />
        {s.error.value && <div class="notice error">{s.error.value}</div>}
        {busyPanel}
        {phase === 'lobby' && (
          <div class="glass stack" style={{ gap: 6 }}>
            <strong>Keep the subject in the circle.</strong>
            <span class="muted small">
              Stand in a curve around the subject, about 2–3 m away, in number order from the left. Hold your phone at chest height,{' '}
              {settings.orientation === 'portrait' ? 'upright' : 'sideways'}, and keep the line level.
            </span>
            {wrongShape && (
              <span class="chip warn" style={{ alignSelf: 'flex-start' }}>
                Turn your phone {settings.orientation === 'portrait' ? 'upright' : 'sideways'}
              </span>
            )}
            <span class="muted small">Waiting for the host to start the countdown…</span>
          </div>
        )}
      </div>
      {phase === 'countdown' && countdown && <Countdown targetLocal={countdown.targetLocal} />}
    </>
  );
}

export function JoinApp({ code }: { code: string | null }) {
  if (!code) return <CodeEntry />;
  return <JoinFlow key={code} code={code} />;
}

function JoinFlow({ code }: { code: string }) {
  const [ctl] = useState(() => new ShooterController(code));
  useEffect(() => () => ctl.dispose(), [ctl]);
  if (ctl.step.value === 'joined' && ctl.session) return <ShooterView ctl={ctl} />;
  return <ConsentForm ctl={ctl} />;
}
