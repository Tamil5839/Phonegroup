import { useState } from 'preact/hooks';
import { normalizeRoomCode } from '../../core/roomCode';
import { navigate } from '../router';

function HeroArt() {
  // Seven phones in an arc around a subject, their "rays" meeting at one instant.
  const phones = Array.from({ length: 7 }, (_, i) => {
    const a = Math.PI * (0.12 + (0.76 * i) / 6);
    return { x: 200 - Math.cos(a) * 150, y: 150 + Math.sin(a) * 105, rot: (-Math.cos(a) * 60).toFixed(1) };
  });
  return (
    <svg class="hero-art" viewBox="0 0 400 290" aria-hidden="true">
      {phones.map((p, i) => (
        <line key={`r${i}`} class="ray" x1={p.x} y1={p.y} x2="200" y2="150" />
      ))}
      <circle class="pulse" cx="200" cy="150" r="46" stroke-width="1.5" />
      <circle class="subject" cx="200" cy="150" r="9" />
      {phones.map((p, i) => (
        <g key={`p${i}`} transform={`translate(${p.x} ${p.y}) rotate(${p.rot})`}>
          <rect class="phone" x="-9" y="-15" width="18" height="30" rx="4" stroke-width="1.5" />
          <circle cx="0" cy="-9" r="2" fill="var(--accent)" />
        </g>
      ))}
    </svg>
  );
}

export function Home() {
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const normalized = normalizeRoomCode(code);

  return (
    <main class="screen">
      <div class="stack" style={{ gap: 10, marginTop: 12 }}>
        <div class="eyebrow">Bullet time for everyone</div>
        <h1>Frozen Moment</h1>
        <p class="lead">Every phone in the room becomes one camera. Freeze a moment and sweep around it.</p>
      </div>
      <HeroArt />
      <ol class="steps">
        <li>One person creates a moment and shows the code.</li>
        <li>Everyone scans it and stands in a curve around the subject.</li>
        <li>A countdown runs on every screen — all phones capture the same instant.</li>
        <li>The clip is made on the host's phone and sent back to everyone.</li>
      </ol>

      <div class="bottom-actions">
        {!joining ? (
          <>
            <button class="btn primary big block" onClick={() => navigate('/host')}>
              Create moment
            </button>
            <button class="btn big block" onClick={() => setJoining(true)}>
              Join with a code
            </button>
          </>
        ) : (
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (normalized) navigate(`/j/${normalized}`);
            }}
          >
            <div class="field">
              <label for="join-code">Code shown on the host's screen</label>
              <input
                id="join-code"
                class="input code"
                inputMode="text"
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
            <button class="btn primary big block" type="submit" disabled={!normalized}>
              Join
            </button>
            <button class="btn ghost block" type="button" onClick={() => setJoining(false)}>
              Cancel
            </button>
          </form>
        )}
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <button class="link-btn" onClick={() => navigate('/manual')}>
            Manual mode
          </button>
          <button class="link-btn" onClick={() => navigate('/help')}>
            How it works &amp; limits
          </button>
        </div>
        <p class="muted small" style={{ textAlign: 'center' }}>
          Free, no install, no accounts. Photos go phone to phone — never to a server.
        </p>
      </div>
    </main>
  );
}
