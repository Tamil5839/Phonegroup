import qrcode from 'qrcode-generator';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SYNC_WARN_MS } from '../core/clockSync';
import { localNow } from '../core/time';
import { tilt } from '../media/tilt';

/* ------------------------------ QR code ------------------------------ */

export function QRCode({ value, label, level = 'M' }: { value: string; label: string; level?: 'L' | 'M' | 'Q' | 'H' }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, level);
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const m = 3;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
    return { n: n + 2 * m, d };
  }, [value, level]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/* ------------------------------ progress ------------------------------ */

export function Bar({ value, label, fill = false }: { value: number; label: string; fill?: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      class="bar"
      style={fill ? { width: '100%' } : undefined}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Ring({ value, size = 120, children }: { value: number; size?: number; children?: ComponentChildren }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      style={{ position: 'relative', width: size, height: size }}
      role="progressbar"
      aria-valuenow={Math.round(v * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg viewBox="0 0 120 120" width={size} height={size}>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--surface-3)" stroke-width="8" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="var(--accent)"
          stroke-width="8"
          stroke-linecap="round"
          stroke-dasharray={c}
          stroke-dashoffset={c * (1 - v)}
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dashoffset .25s' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontWeight: 800 }}>{children}</div>
    </div>
  );
}

/* ------------------------------ countdown ------------------------------ */

function labelFor(remaining: number): string {
  if (remaining > 3000) return 'ready';
  if (remaining > 0) return String(Math.ceil(remaining / 1000));
  return 'hold';
}

/**
 * Big synchronized countdown. Every phone computes the remaining time from
 * the shared moment converted to its own clock, so the numbers change at the
 * same instant everywhere.
 */
export function Countdown({
  targetLocal,
  compact = false,
  holdText = 'Hold still…',
}: {
  targetLocal: number;
  compact?: boolean;
  holdText?: string;
}) {
  const [label, setLabel] = useState(() => labelFor(targetLocal - localNow()));
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      const l = labelFor(targetLocal - localNow());
      if (l !== last) {
        if (l === 'hold' && last !== '') setFlash(true);
        last = l;
        setLabel(l);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetLocal]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 400);
    return () => clearTimeout(t);
  }, [flash]);
  return (
    <>
      <div class={`countdown${compact ? ' compact' : ''}`} aria-live="assertive" aria-atomic="true">
        <div>
          {label === 'ready' && <div class="caption">Get ready — frame the subject</div>}
          {label !== 'ready' && label !== 'hold' && (
            <div key={label} class="num pop">
              {label}
            </div>
          )}
          {label === 'hold' && (
            <div class="caption" style={{ fontSize: 30, color: 'var(--text)' }}>
              {holdText}
            </div>
          )}
        </div>
      </div>
      {flash && !compact && <div class="flash" aria-hidden="true" />}
    </>
  );
}

/* ------------------------------ aiming ------------------------------ */

/** Crosshair, "keep the subject here" circle and a level line that turns cyan when level. */
export function AimOverlay() {
  const roll = tilt.roll.value;
  const level = roll !== null && Math.abs(roll) < 1.5;
  const color = level ? 'var(--accent)' : 'rgba(255,255,255,0.85)';
  return (
    <svg class="aim-overlay" viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <circle r="17" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="0.35" stroke-dasharray="1.2 1.2" />
      <line x1="-3.5" y1="0" x2="3.5" y2="0" stroke="#fff" stroke-width="0.35" />
      <line x1="0" y1="-3.5" x2="0" y2="3.5" stroke="#fff" stroke-width="0.35" />
      {roll !== null && (
        <g transform={`rotate(${-roll})`}>
          <line x1="-30" y1="0" x2="-20" y2="0" stroke={color} stroke-width="0.6" stroke-linecap="round" />
          <line x1="20" y1="0" x2="30" y2="0" stroke={color} stroke-width="0.6" stroke-linecap="round" />
        </g>
      )}
    </svg>
  );
}

export function LevelChip() {
  const roll = tilt.roll.value;
  if (roll === null) return null;
  const level = Math.abs(roll) < 1.5;
  return (
    <span class={`chip ${level ? 'accent' : 'warn'}`} aria-live="polite">
      {level ? 'Level' : `Tilted ${Math.abs(roll).toFixed(0)}° ${roll > 0 ? '↻' : '↺'}`}
    </span>
  );
}

/* ------------------------------ chips ------------------------------ */

export function SyncChip({ uncertainty, rtt }: { uncertainty: number | null | undefined; rtt?: number | null }) {
  if (uncertainty === null || uncertainty === undefined) return <span class="chip">Syncing…</span>;
  const cls = uncertainty <= 10 ? 'ok' : uncertainty <= SYNC_WARN_MS ? 'accent' : 'warn';
  return (
    <span class={`chip ${cls}`} title="Estimated clock-sync uncertainty">
      <span class="dot" />±{uncertainty.toFixed(0)} ms{rtt !== undefined && rtt !== null ? ` · ${rtt.toFixed(0)} ms RTT` : ''}
    </span>
  );
}

/* ------------------------------ images ------------------------------ */

export function JpegThumb({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })), [bytes]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt={alt} decoding="async" />;
}

export function BitmapThumb({ bitmap, alt, width = 160 }: { bitmap: ImageBitmap; alt: string; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = width / bitmap.width;
    c.width = width;
    c.height = Math.round(bitmap.height * k);
    c.getContext('2d')?.drawImage(bitmap, 0, 0, c.width, c.height);
  }, [bitmap, width]);
  return <canvas ref={ref} role="img" aria-label={alt} />;
}

/* ------------------------------ controls ------------------------------ */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.id} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label class="toggle">
      <span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {hint && (
          <span class="muted small" style={{ display: 'block' }}>
            {hint}
          </span>
        )}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
    </label>
  );
}

/** Mounts an existing (persistent) element, e.g. the live camera <video>, into this spot. */
export function Mount({ el, class: cls }: { el: HTMLElement | null; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || !el) return;
    host.appendChild(el);
    if (el instanceof HTMLVideoElement && el.paused) void el.play().catch(() => {});
    return () => {
      if (el.parentElement === host) host.removeChild(el);
    };
  }, [el]);
  return <div ref={ref} class={cls} />;
}

export function TopBar({ title, onBack, right }: { title?: string; onBack?: () => void; right?: ComponentChildren }) {
  return (
    <div class="topbar">
      {onBack && (
        <button type="button" class="icon-btn" onClick={onBack} aria-label="Back">
          ←
        </button>
      )}
      {title && <div class="title">{title}</div>}
      <div class="spacer" />
      {right}
    </div>
  );
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(localNow());
  useEffect(() => {
    const t = setInterval(() => setNow(localNow()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** A small countdown line that doesn't cover the screen (used over the sync-test clock). */
export function InlineCountdown({ targetLocal }: { targetLocal: number }) {
  const [text, setText] = useState('');
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const r = targetLocal - localNow();
      setText(r > 0 ? `Capturing in ${Math.ceil(r / 1000)}…` : 'Hold still…');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetLocal]);
  return (
    <div class="chip accent" style={{ fontSize: 18, padding: '8px 16px' }} aria-live="assertive">
      {text}
    </div>
  );
}
