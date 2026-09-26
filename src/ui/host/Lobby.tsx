import { useRef, useState } from 'preact/hooks';
import { SYNC_WARN_MS } from '../../core/clockSync';
import { formatRoomCode } from '../../core/roomCode';
import type { ShooterState } from '../../session/host';
import { Mount, QRCode, Segmented, SyncChip, Toggle, TopBar, useNow } from '../components';
import { joinUrl, navigate } from '../router';
import type { HostController } from './controller';

function ShooterRow({
  s,
  index,
  onKick,
  onMove,
  total,
  gripProps,
  dragging,
}: {
  s: ShooterState;
  index: number;
  total: number;
  onKick: () => void;
  onMove: (d: number) => void;
  gripProps: Record<string, unknown>;
  dragging: boolean;
}) {
  const now = useNow(2000);
  const quiet = !s.isHost && s.connected && now - s.lastSeen > 25_000;
  const cam = s.camera.state;
  return (
    <li class={`shooter${dragging ? ' dragging' : ''}`}>
      <span class="grip" aria-hidden="true" {...gripProps}>
        ⋮⋮
      </span>
      <span class="pos" aria-label={`Position ${index + 1}`}>
        {index + 1}
      </span>
      <div class="who">
        <div class="name">{s.name}</div>
        <div class="meta">
          {!s.connected ? (
            <span class="chip bad">
              <span class="dot" />
              Reconnecting…
            </span>
          ) : quiet ? (
            <span class="chip warn">Not responding</span>
          ) : null}
          <span class={`chip ${cam === 'ready' ? 'ok' : cam === 'error' ? 'bad' : ''}`}>
            {cam === 'ready' ? 'Camera ready' : cam === 'error' ? 'Camera problem' : 'Camera starting'}
          </span>
          {!s.isHost && <SyncChip uncertainty={s.sync?.uncertainty} rtt={s.sync?.bestRtt} />}
          {s.sync && s.sync.uncertainty > SYNC_WARN_MS && <span class="chip warn">Shaky sync</span>}
          {s.syncError && <span class="chip warn">Sync failed</span>}
        </div>
      </div>
      <div class="row" style={{ gap: 4 }}>
        <button class="icon-btn" aria-label={`Move ${s.name} left`} disabled={index === 0} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button class="icon-btn" aria-label={`Move ${s.name} right`} disabled={index === total - 1} onClick={() => onMove(1)}>
          ↓
        </button>
        {!s.isHost && (
          <button class="icon-btn" aria-label={`Remove ${s.name}`} onClick={onKick}>
            ✕
          </button>
        )}
      </div>
    </li>
  );
}

export function Lobby({ ctl }: { ctl: HostController }) {
  const session = ctl.session!;
  const shooters = session.shooters.value;
  const order = session.order.value;
  const settings = session.settings.value;
  const notice = session.notice.value;
  const byId = new Map(shooters.map((s) => [s.id, s]));
  const connected = order.filter((id) => byId.get(id)?.connected);
  const remote = connected.filter((id) => !byId.get(id)?.isHost);
  const code = ctl.code.value;
  const listRef = useRef<HTMLUListElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const grip = (id: string) => ({
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDragId(id);
    },
    onPointerMove: (e: PointerEvent) => {
      if (dragId !== id || !listRef.current) return;
      const items = Array.from(listRef.current.children) as HTMLElement[];
      let target = items.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      if (target < 0) target = items.length - 1;
      const cur = order.indexOf(id);
      if (target !== cur) {
        const next = order.filter((x) => x !== id);
        next.splice(target, 0, id);
        session.setOrder(next);
      }
    },
    onPointerUp: () => setDragId(null),
    onPointerCancel: () => setDragId(null),
  });

  const leave = () => {
    if (shooters.some((s) => !s.isHost) && !confirm('End this moment for everyone?')) return;
    navigate('/');
  };

  return (
    <main class="screen">
      <TopBar
        title="Your moment"
        onBack={leave}
        right={
          ctl.signaling.value !== 'online' ? (
            <span class="chip warn">Reconnecting to signaling…</span>
          ) : (
            <span class="chip ok">
              <span class="dot" />
              Open
            </span>
          )
        }
      />

      <section class="card qr-card">
        <QRCode value={joinUrl(code)} label={`QR code to join moment ${formatRoomCode(code)}`} />
        <div class="room-code" aria-label={`Code ${code.split('').join(' ')}`}>
          {formatRoomCode(code)}
        </div>
        <p class="muted small">Scan with the phone camera — or open Frozen Moment and type the code.</p>
      </section>

      <p class="lead">Stand in a curve around the subject, about 2–3 metres away, spaced evenly. Put names in left-to-right order.</p>

      <section class="stack">
        <div class="row">
          <h3>Cameras</h3>
          <span class="chip accent">{connected.length} ready</span>
        </div>
        {order.length === 0 ? (
          <div class="notice">Waiting for phones to join… Everyone should be on the same Wi-Fi as you, or on your hotspot.</div>
        ) : (
          <ul class="shooter-list" ref={listRef}>
            {order.map((id, i) => {
              const s = byId.get(id);
              if (!s) return null;
              return (
                <ShooterRow
                  key={id}
                  s={s}
                  index={i}
                  total={order.length}
                  dragging={dragId === id}
                  gripProps={grip(id)}
                  onMove={(d) => session.move(id, d)}
                  onKick={() => {
                    if (confirm(`Remove ${s.name} from this moment?`)) session.kick(id);
                  }}
                />
              );
            })}
          </ul>
        )}
      </section>

      <section class="card stack">
        <div class="field">
          <span class="label">Phones held</span>
          <Segmented
            label="Phone orientation"
            value={settings.orientation}
            options={[
              { id: 'portrait', label: 'Upright (9:16)' },
              { id: 'landscape', label: 'Sideways (16:9)' },
            ]}
            onChange={(o) => session.updateSettings({ orientation: o })}
          />
        </div>
        <Toggle label="Use my camera too" hint="Your phone becomes one of the cameras" checked={ctl.hostShoots.value} onChange={(on) => void ctl.setHostShoots(on)} />
        {ctl.hostShoots.value && (
          <div class="row">
            <Mount el={ctl.video} class="mini-preview" />
            <p class="muted small">Your camera is live. During the countdown it fills the screen.</p>
          </div>
        )}
        {ctl.cameraError.value && <div class="notice error">{ctl.cameraError.value}</div>}
        <Toggle label="Close the room" hint="No new phones can join" checked={session.locked.value} onChange={(v) => (session.locked.value = v)} />
      </section>

      {notice && (
        <div class="notice warn" role="status">
          {notice}{' '}
          <button class="link-btn" onClick={() => (session.notice.value = null)}>
            OK
          </button>
        </div>
      )}

      <div class="bottom-actions">
        <button class="btn primary big block" disabled={connected.length === 0} onClick={() => void ctl.freeze()}>
          Freeze the moment
        </button>
        <div class="row">
          <button class="btn block" disabled={remote.length === 0} onClick={() => (ctl.view.value = 'synctest')}>
            Sync test
          </button>
        </div>
        <button class="link-btn" onClick={() => (ctl.view.value = 'manual')}>
          Some phones can't connect? Schedule a manual moment
        </button>
        <p class="muted small" style={{ textAlign: 'center' }}>
          {connected.length === 0
            ? 'Freeze becomes available once a camera is ready.'
            : `The countdown starts on all ${connected.length} phone${connected.length === 1 ? '' : 's'} at once (${(settings.countdownMs / 1000).toFixed(1)} s).`}
        </p>
      </div>
    </main>
  );
}
