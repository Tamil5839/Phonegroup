import { useSignalEffect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { simApply, type Pt } from '../../core/geometry';
import { CLIP_STYLES, frameAt, timelineDuration, type TimelineFrame } from '../../core/sequence';
import { createRenderer, type FrameRenderer } from '../../process/renderer';
import type { Project, ProjectFrame } from '../../process/project';
import { Bar, BitmapThumb, Segmented, Toggle, TopBar } from '../components';

type PreviewMode = { kind: 'play' } | { kind: 'frame'; index: number; blinkWith: number | null };

/** Live preview: plays the clip (or holds one frame) through the same renderer as the export. */
function PreviewPlayer({ project, mode, onDrag }: { project: Project; mode: PreviewMode; onDrag?: (dx: number, dy: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FrameRenderer | null>(null);
  const dirty = useRef(0);

  useEffect(() => {
    rendererRef.current = createRenderer(canvasRef.current!);
    dirty.current++;
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useSignalEffect(() => {
    // Touch every input of the picture so any change re-uploads and redraws.
    void project.plan.value;
    void project.luts.value;
    void project.ordered.value;
    void project.settings.value;
    void project.captionText.value;
    const r = rendererRef.current;
    if (r) project.prepare(r);
    dirty.current++;
  });

  // Where the subject sits in the output (shown while adjusting one frame).
  const marker = ((): Pt | null => {
    const al = project.alignment.value;
    if (mode.kind !== 'frame' || !al) return null;
    const f = project.ordered.value[mode.index];
    const a = f && al[f.id];
    if (!a) return null;
    const plan = project.plan.value;
    const p = simApply(plan.transforms[mode.index], a.point.x, a.point.y);
    return { x: p.x / plan.width, y: p.y / plan.height };
  })();

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    let lastKey = '';
    let lastDirty = -1;
    const tick = (ts: number) => {
      const r = rendererRef.current;
      if (r) {
        let item: TimelineFrame | null;
        if (mode.kind === 'play') item = frameAt(project.timeline.value, ts - start);
        else {
          const blink = mode.blinkWith !== null && Math.floor((ts - start) / 350) % 2 === 1;
          item = { frame: blink ? mode.blinkWith! : mode.index, sub: 0, ms: 0 };
        }
        if (item) {
          const key = `${item.frame}:${item.sub}`;
          if (key !== lastKey || dirty.current !== lastDirty) {
            project.drawItem(r, item);
            lastKey = key;
            lastDirty = dirty.current;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode.kind, mode.kind === 'frame' ? mode.index : -1, mode.kind === 'frame' ? mode.blinkWith : -1]);

  const drag = useRef<{ x: number; y: number } | null>(null);
  const toCanvas = (dx: number) => {
    const c = canvasRef.current!;
    return (dx * c.width) / c.getBoundingClientRect().width;
  };

  return (
    <div
      class="preview-box"
      onPointerDown={(e) => {
        if (!onDrag) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!drag.current || !onDrag) return;
        const dx = e.clientX - drag.current.x;
        const dy = e.clientY - drag.current.y;
        drag.current = { x: e.clientX, y: e.clientY };
        onDrag(toCanvas(dx), toCanvas(dy));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <canvas ref={canvasRef} aria-label="Clip preview" />
      {marker && <div class="marker" style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }} aria-hidden="true" />}
    </div>
  );
}

/** Shows a whole photo; a tap reports the tapped point in the photo's own pixels. */
function SubjectPicker({ frame, point, onPick, hint }: { frame: ProjectFrame; point: Pt | null; onPick: (p: Pt) => void; hint: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    c.width = frame.bitmap.width;
    c.height = frame.bitmap.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(frame.bitmap, 0, 0);
    if (point) {
      const r = Math.max(10, Math.min(c.width, c.height) * 0.025);
      ctx.lineWidth = r * 0.35;
      ctx.strokeStyle = '#3de0ff';
      ctx.beginPath();
      ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [frame, point]);
  return (
    <div>
      <div class="picker-hint" role="status">
        {hint}
      </div>
      <div class="picker">
        <canvas
          ref={ref}
          aria-label={`${frame.name}: tap the subject`}
          onPointerUp={(e) => {
            const c = e.currentTarget as HTMLCanvasElement;
            const r = c.getBoundingClientRect();
            // object-fit: contain — find the drawn image box inside the element.
            const k = Math.min(r.width / c.width, r.height / c.height);
            const w = c.width * k;
            const h = c.height * k;
            const x = (e.clientX - r.left - (r.width - w) / 2) / k;
            const y = (e.clientY - r.top - (r.height - h) / 2) / k;
            if (x >= 0 && y >= 0 && x <= c.width && y <= c.height) onPick({ x, y });
          }}
        />
      </div>
    </div>
  );
}

function Filmstrip({ project, selected, onSelect }: { project: Project; selected: string | null; onSelect: (id: string) => void }) {
  const frames = project.frames.value;
  const order = project.order.value;
  const excluded = new Set(project.excluded.value);
  const al = project.alignment.value;
  const heroId = project.ordered.value[project.heroIndex.value]?.id;
  const style = project.settings.value.style;
  const byId = new Map(frames.map((f) => [f.id, f]));
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const grip = (id: string) => ({
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDragId(id);
    },
    onPointerMove: (e: PointerEvent) => {
      if (dragId !== id || !listRef.current) return;
      const tiles = Array.from(listRef.current.children) as HTMLElement[];
      let best = 0;
      let bestD = Infinity;
      tiles.forEach((t, i) => {
        const r = t.getBoundingClientRect();
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const cur = order.indexOf(id);
      if (best !== cur) {
        const next = order.filter((x) => x !== id);
        next.splice(best, 0, id);
        project.order.value = next;
      }
    },
    onPointerUp: () => {
      if (dragId) project.setOrder([...project.order.value]);
      setDragId(null);
    },
    onPointerCancel: () => setDragId(null),
  });

  let pos = 0;
  return (
    <div class="row wrap" ref={listRef} role="list" aria-label="Frames in order">
      {order.map((id) => {
        const f = byId.get(id);
        if (!f) return null;
        const out = excluded.has(id);
        if (!out) pos++;
        const conf = al?.[id]?.confidence;
        const flag = f.warning || conf === 'failed' || conf === 'weak';
        return (
          <div key={id} role="listitem" style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: dragId === id ? 0.6 : 1 }}>
            <button
              class={`film${out ? ' excluded' : ''}`}
              aria-pressed={selected === id}
              aria-label={`${f.name}${out ? ' (left out)' : `, position ${pos}`}`}
              onClick={() => onSelect(id)}
            >
              <BitmapThumb bitmap={f.bitmap} alt="" width={120} />
              <span class="tag">{out ? '—' : pos}</span>
              <span class="flag">
                {style === 'sweep-life' && heroId === id ? '★' : ''}
                {flag ? '⚠' : ''}
              </span>
            </button>
            <span class="grip" style={{ textAlign: 'center', fontSize: 16 }} aria-hidden="true" {...grip(id)}>
              ⋯
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FramePanel({
  project,
  frame,
  index,
  blink,
  setBlink,
  onPick,
}: {
  project: Project;
  frame: ProjectFrame;
  index: number;
  blink: boolean;
  setBlink: (b: boolean) => void;
  onPick: () => void;
}) {
  const al = project.alignment.value?.[frame.id];
  const excluded = project.excluded.value.includes(frame.id);
  const style = project.settings.value.style;
  const step = 3;
  const deg = Math.PI / 180;
  const n = (c: Parameters<Project['nudge']>[1]) => project.nudge(frame.id, c);
  return (
    <div class="card panel">
      <div class="row">
        <h3 style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{frame.name}</h3>
        {frame.errorMs !== null && <span class="chip">{`${frame.errorMs >= 0 ? '+' : '−'}${Math.abs(frame.errorMs).toFixed(0)} ms`}</span>}
        {al && (
          <span class={`chip ${al.confidence === 'good' || al.confidence === 'anchor' || al.confidence === 'manual' ? 'ok' : 'warn'}`}>
            {al.confidence}
          </span>
        )}
      </div>
      {frame.warning && <div class="notice warn small">{frame.warning}</div>}
      <button class="btn block" onClick={onPick}>
        Tap the subject in this photo
      </button>
      <div class="nudge-grid" role="group" aria-label="Nudge alignment">
        <button class="icon-btn" aria-label="Move left" onClick={() => n({ dx: -step })}>
          ←
        </button>
        <button class="icon-btn" aria-label="Move up" onClick={() => n({ dy: -step })}>
          ↑
        </button>
        <button class="icon-btn" aria-label="Move down" onClick={() => n({ dy: step })}>
          ↓
        </button>
        <button class="icon-btn" aria-label="Move right" onClick={() => n({ dx: step })}>
          →
        </button>
        <button class="icon-btn" aria-label="Rotate left" onClick={() => n({ rotate: -0.5 * deg })}>
          ↺
        </button>
        <button class="icon-btn" aria-label="Rotate right" onClick={() => n({ rotate: 0.5 * deg })}>
          ↻
        </button>
        <button class="icon-btn" aria-label="Smaller" onClick={() => n({ zoom: 1 / 1.01 })}>
          −
        </button>
        <button class="icon-btn" aria-label="Bigger" onClick={() => n({ zoom: 1.01 })}>
          +
        </button>
      </div>
      <p class="muted small">Drag the preview to shift this photo. Blink compares it with its neighbour.</p>
      <Toggle label="Blink with neighbour" checked={blink} onChange={setBlink} />
      <div class="row wrap">
        <button class="btn small" disabled={index <= 0} onClick={() => project.move(frame.id, -1)}>
          ◀ Earlier
        </button>
        <button class="btn small" onClick={() => project.move(frame.id, 1)}>
          Later ▶
        </button>
        <button class="btn small" onClick={() => project.toggleExcluded(frame.id)}>
          {excluded ? 'Include' : 'Leave out'}
        </button>
        {style === 'sweep-life' && (
          <button class="btn small" onClick={() => project.updateSettings({ heroId: frame.id })}>
            ★ Comes alive
          </button>
        )}
        <button class="btn small ghost" onClick={() => project.resetAdjustments(frame.id)}>
          Reset
        </button>
      </div>
    </div>
  );
}

function StylePanel({ project, onImport }: { project: Project; onImport: (files: File[]) => void }) {
  const s = project.settings.value;
  const fileRef = useRef<HTMLInputElement>(null);
  const dur = timelineDuration(project.timeline.value) / 1000;
  const set = (p: Partial<typeof s>) => project.updateSettings(p);
  return (
    <div class="card panel">
      <div class="field">
        <span class="label">Style</span>
        <Segmented
          label="Clip style"
          value={s.style}
          options={CLIP_STYLES.map((c) => ({ id: c.id, label: c.label }))}
          onChange={(style) => set({ style })}
        />
        <span class="muted small">{CLIP_STYLES.find((c) => c.id === s.style)?.hint}</span>
      </div>
      <div class="field">
        <label for="fps">
          Speed: {s.fps} frames/s · clip {dur.toFixed(1)} s
        </label>
        <input
          id="fps"
          type="range"
          min={12}
          max={18}
          step={1}
          value={s.fps}
          onInput={(e) => set({ fps: Number((e.currentTarget as HTMLInputElement).value) })}
        />
      </div>
      <div class="field">
        <label for="dur">Target length: {(s.durationMs / 1000).toFixed(1)} s</label>
        <input
          id="dur"
          type="range"
          min={3000}
          max={6000}
          step={250}
          value={s.durationMs}
          onInput={(e) => set({ durationMs: Number((e.currentTarget as HTMLInputElement).value) })}
        />
      </div>
      <div class="field">
        <span class="label">Shape</span>
        <Segmented
          label="Aspect ratio"
          value={s.aspect}
          options={[
            { id: '9:16', label: 'Tall 9:16' },
            { id: '16:9', label: 'Wide 16:9' },
          ]}
          onChange={(aspect) => set({ aspect })}
        />
      </div>
      <Toggle
        label="Match colours"
        hint="Evens out the phones' different colours, gently"
        checked={s.colorMatch}
        onChange={(colorMatch) => set({ colorMatch })}
      />
      {s.colorMatch && (
        <div class="field">
          <label for="strength">Strength: {Math.round(s.colorStrength * 100)}%</label>
          <input
            id="strength"
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={s.colorStrength}
            onInput={(e) => set({ colorStrength: Number((e.currentTarget as HTMLInputElement).value) })}
          />
        </div>
      )}
      <Toggle
        label="Level with tilt sensors"
        hint="Uses each phone's level reading when available"
        checked={s.levelWithSensors}
        onChange={(levelWithSensors) => set({ levelWithSensors })}
      />
      <Toggle label="Subtle vignette" checked={s.vignette} onChange={(vignette) => set({ vignette })} />
      <Toggle label="Caption" hint={project.captionText.value} checked={s.caption} onChange={(caption) => set({ caption })} />
      <div class="row wrap">
        <button class="btn small" onClick={() => void project.autoOrder()} disabled={project.ordered.value.length < 3}>
          Auto order
        </button>
        <button class="btn small" onClick={() => fileRef.current?.click()}>
          Add photos &amp; videos
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          class="visually-hidden"
          onChange={(e) => {
            const files = Array.from((e.currentTarget as HTMLInputElement).files ?? []);
            (e.currentTarget as HTMLInputElement).value = '';
            if (files.length) onImport(files);
          }}
        />
      </div>
    </div>
  );
}

export interface EditProps {
  project: Project;
  onBack: () => void;
  onCreate: () => void;
  onCancelExport: () => void;
  onImport: (files: File[]) => void;
  exporting: { progress: number } | null;
  exportError: string | null;
  importNote: string | null;
  importing: { done: number; total: number } | null;
}

export function EditScreen(props: EditProps) {
  const { project } = props;
  const frames = project.ordered.value;
  const subject = project.subject.value;
  const busy = project.busy.value;
  const [selected, setSelected] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [blink, setBlink] = useState(false);

  // Sweep + Life needs the hero's neighbour frames: decode them when needed.
  useSignalEffect(() => {
    const s = project.settings.value;
    const hero = project.ordered.value[project.heroIndex.value];
    if (s.style === 'sweep-life' && hero) void project.ensureNeighbors(hero.id);
  });

  const selIndex = selected ? frames.findIndex((f) => f.id === selected) : -1;
  const selFrame = selIndex >= 0 ? frames[selIndex] : null;
  const anchorFrame = frames[0];
  const needSubject = !subject && anchorFrame;
  const pickFrame = picking ? frames.find((f) => f.id === picking) : needSubject ? anchorFrame : null;

  const mode: PreviewMode =
    selFrame && selIndex >= 0
      ? { kind: 'frame', index: selIndex, blinkWith: blink ? (selIndex > 0 ? selIndex - 1 : frames.length > 1 ? 1 : null) : null }
      : { kind: 'play' };

  const pickedPoint = (() => {
    if (!pickFrame) return null;
    if (subject?.frameId === pickFrame.id) return subject.point;
    const pin = project.manualPoints.value[pickFrame.id];
    if (pin) return pin;
    return project.alignment.value?.[pickFrame.id]?.point ?? null;
  })();

  return (
    <main class="screen wide">
      <TopBar title="Edit" onBack={props.onBack} right={<span class="chip">{frames.length} photos</span>} />
      {frames.length === 0 ? (
        <div class="notice">No photos yet. Add photos or videos to start.</div>
      ) : (
        <div class="edit-layout">
          <div class="stack">
            <div style={{ position: 'relative' }}>
              {pickFrame ? (
                <SubjectPicker
                  frame={pickFrame}
                  point={pickedPoint}
                  hint={needSubject && !picking ? 'Tap the centre of the subject' : `Tap the subject in ${pickFrame.name}`}
                  onPick={(p) => {
                    if (picking && subject) project.pinSubject(picking, p);
                    else project.setSubject(pickFrame.id, p);
                    setPicking(null);
                  }}
                />
              ) : (
                <PreviewPlayer
                  project={project}
                  mode={mode}
                  onDrag={selFrame ? (dx, dy) => project.nudge(selFrame.id, { dx, dy }) : undefined}
                />
              )}
              {busy && (
                <div class="busy" role="status">
                  <div class="stack" style={{ alignItems: 'center' }}>
                    <strong>{busy.label}</strong>
                    <Bar value={busy.progress} label={busy.label} />
                  </div>
                </div>
              )}
            </div>
            {project.alignNote.value && <div class="notice warn small">{project.alignNote.value}</div>}
            {props.importNote && <div class="notice warn small">{props.importNote}</div>}
            {props.importing && (
              <div class="notice info small" role="status">
                Importing {props.importing.done}/{props.importing.total}…
              </div>
            )}
            <Filmstrip
              project={project}
              selected={selected}
              onSelect={(id) => {
                setPicking(null);
                setSelected(selected === id ? null : id);
              }}
            />
            {selected && (
              <button class="btn small ghost" onClick={() => setSelected(null)}>
                ▶ Play the clip
              </button>
            )}
          </div>
          <div class="stack">
            {selFrame && (
              <FramePanel
                project={project}
                frame={selFrame}
                index={selIndex}
                blink={blink}
                setBlink={setBlink}
                onPick={() => setPicking(selFrame.id)}
              />
            )}
            <StylePanel project={project} onImport={props.onImport} />
          </div>
        </div>
      )}
      {props.exportError && <div class="notice error">{props.exportError}</div>}
      <div class="bottom-actions">
        {props.exporting ? (
          <div class="card stack" role="status">
            <strong>Creating the clip…</strong>
            <Bar value={props.exporting.progress} label="Export progress" />
            <button class="btn small ghost" onClick={props.onCancelExport}>
              Cancel
            </button>
          </div>
        ) : (
          <button class="btn primary big block" disabled={frames.length < 2 || !!busy} onClick={props.onCreate}>
            Create clip
          </button>
        )}
        {!subject && frames.length >= 2 && (
          <p class="muted small" style={{ textAlign: 'center' }}>
            Tip: tap the subject first so it stays put while the view sweeps.
          </p>
        )}
      </div>
    </main>
  );
}
