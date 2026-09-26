/**
 * The host's editing session for one moment: the frames, their order, the
 * subject point, alignment, colour matching, clip style — and everything
 * derived from them (output plan, lookup tables, timeline). The Edit screen
 * binds to these signals; the preview player and the exporter both draw
 * through `drawItem`, so what you preview is what you export.
 */
import { batch, computed, signal } from '@preact/signals-core';
import {
  alignChain,
  planCenterCrop,
  planOutput,
  type AspectChoice,
  type FrameAlignment,
  type OutputPlan,
  type PairMatches,
} from '../core/align';
import { buildMatchLuts, computeStats, medianReference, type ColorStats } from '../core/color';
import { simCompose, type Pt, type Sim } from '../core/geometry';
import { bestPath, orientLike } from '../core/order';
import { buildTimeline, type ClipStyle, type TimelineFrame } from '../core/sequence';
import { exportClip, type ExportMethod, type ExportResult } from './export';
import { FeatureClient } from './featureClient';
import { toGray, type GrayImage, type MatchSet } from './features';
import { createRenderer, makeCaption, type FrameRenderer, type Luts } from './renderer';

export interface ProjectFrame {
  id: string;
  name: string;
  bitmap: ImageBitmap;
  /** Decoded neighbour frames (only for the frame that "comes alive"; decoded on demand). */
  neighbors: Record<number, ImageBitmap>;
  /** Neighbour offsets this frame can provide. */
  neighborOffsets: number[];
  /** Decodes the neighbour frames when they are first needed. */
  loadNeighbors?: () => Promise<Record<number, ImageBitmap>>;
  /** Device roll in degrees at capture (clockwise positive). */
  roll: number | null;
  /** Capture timing error reported by the phone (ms). */
  errorMs: number | null;
  origin: 'live' | 'photo' | 'video';
  warning?: string;
  file?: File;
}

export interface EditSettings {
  style: ClipStyle;
  fps: number;
  durationMs: number;
  aspect: AspectChoice;
  vignette: boolean;
  caption: boolean;
  colorMatch: boolean;
  colorStrength: number;
  levelWithSensors: boolean;
  heroId: string | null;
}

export const DEFAULT_EDIT: EditSettings = {
  style: 'sweep',
  fps: 15,
  durationMs: 4000,
  aspect: '9:16',
  vignette: true,
  caption: true,
  colorMatch: true,
  colorStrength: 0.7,
  levelWithSensors: true,
  heroId: null,
};

const ANALYSIS_SIDE = 960;

export function sourceKey(frameId: string, sub: number): string {
  return sub === 0 ? frameId : `${frameId}#${sub}`;
}

export class Project {
  readonly frames = signal<ProjectFrame[]>([]);
  readonly order = signal<string[]>([]);
  readonly excluded = signal<string[]>([]);
  readonly settings = signal<EditSettings>({ ...DEFAULT_EDIT });
  readonly subject = signal<{ frameId: string; point: Pt } | null>(null);
  readonly manualPoints = signal<Record<string, Pt>>({});
  readonly adjustments = signal<Record<string, Sim>>({});
  readonly alignment = signal<Record<string, FrameAlignment> | null>(null);
  readonly busy = signal<{ label: string; progress: number } | null>(null);
  readonly alignNote = signal<string | null>(null);
  readonly captionText = signal(
    `Frozen moment · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
  );

  private readonly features = new FeatureClient();
  private readonly detected = new Set<string>();
  private readonly pairCache = new Map<string, MatchSet>();
  private readonly statsCache = new Map<string, ColorStats>();
  private readonly grayCache = new Map<string, GrayImage>();
  private alignRun = 0;

  readonly ordered = computed(() => {
    const byId = new Map(this.frames.value.map((f) => [f.id, f]));
    const skip = new Set(this.excluded.value);
    return this.order.value
      .filter((id) => !skip.has(id))
      .map((id) => byId.get(id))
      .filter((f): f is ProjectFrame => !!f);
  });

  readonly plan = computed<OutputPlan>(() => {
    const frames = this.ordered.value;
    const s = this.settings.value;
    const geoms = frames.map((f) => ({ width: f.bitmap.width, height: f.bitmap.height, roll: f.roll }));
    const al = this.alignment.value;
    if (al && frames.length && frames.every((f) => al[f.id])) {
      const adj = this.adjustments.value;
      const p = planOutput(
        geoms,
        frames.map((f) => al[f.id]),
        s.aspect,
        frames.map((f) => adj[f.id] ?? null),
      );
      if (p) return p;
    }
    return planCenterCrop(geoms, s.aspect);
  });

  readonly luts = computed<Record<string, Luts> | null>(() => {
    const s = this.settings.value;
    const frames = this.ordered.value;
    if (!s.colorMatch || frames.length < 2) return null;
    const stats = frames.map((f) => this.statsFor(f));
    const ref = medianReference(stats);
    return Object.fromEntries(frames.map((f, i) => [f.id, buildMatchLuts(stats[i], ref, { strength: s.colorStrength })]));
  });

  readonly heroIndex = computed(() => {
    const frames = this.ordered.value;
    const id = this.settings.value.heroId;
    const chosen = id ? frames.findIndex((f) => f.id === id) : -1;
    if (chosen >= 0) return chosen;
    // Default: the phone nearest the middle that sent neighbour frames.
    const mid = (frames.length - 1) / 2;
    let best = -1;
    frames.forEach((f, i) => {
      if (f.neighborOffsets.some((k) => k > 0) && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    });
    return best >= 0 ? best : Math.floor(mid);
  });

  readonly timeline = computed<TimelineFrame[]>(() => {
    const frames = this.ordered.value;
    const s = this.settings.value;
    const hero = frames[this.heroIndex.value];
    const heroForward = hero
      ? Object.keys(hero.neighbors)
          .map(Number)
          .filter((k) => k > 0)
          .sort((a, b) => a - b)
      : [];
    const style = s.style === 'sweep-life' && heroForward.length === 0 ? 'sweep' : s.style;
    return buildTimeline({ style, count: frames.length, fps: s.fps, targetMs: s.durationMs, heroIndex: this.heroIndex.value, heroForward });
  });

  /* ------------------------------ frames ------------------------------ */

  addFrames(list: ProjectFrame[]): void {
    const existing = new Set(this.frames.value.map((f) => f.id));
    const fresh = list.filter((f) => !existing.has(f.id));
    batch(() => {
      this.frames.value = [...this.frames.value, ...fresh];
      this.order.value = [...this.order.value, ...fresh.map((f) => f.id)];
    });
    if (this.subject.value) void this.runAlignment();
  }

  setOrder(ids: string[]): void {
    this.order.value = ids;
    if (this.subject.value) void this.runAlignment();
  }

  move(id: string, delta: number): void {
    const order = [...this.order.value];
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    this.setOrder(order);
  }

  toggleExcluded(id: string): void {
    const ex = new Set(this.excluded.value);
    if (ex.has(id)) ex.delete(id);
    else ex.add(id);
    this.excluded.value = [...ex];
    if (this.subject.value?.frameId === id && ex.has(id)) this.subject.value = null;
    if (this.subject.value) void this.runAlignment();
  }

  updateSettings(patch: Partial<EditSettings>): void {
    const prev = this.settings.value;
    this.settings.value = { ...prev, ...patch };
    if (patch.levelWithSensors !== undefined && patch.levelWithSensors !== prev.levelWithSensors && this.subject.value) {
      void this.runAlignment();
    }
  }

  /** Decode a frame's neighbour frames (for the "life" effect) if not done yet. */
  async ensureNeighbors(id: string): Promise<void> {
    const f = this.frames.value.find((x) => x.id === id);
    if (!f?.loadNeighbors || Object.keys(f.neighbors).length > 0) return;
    const load = f.loadNeighbors;
    this.frames.value = this.frames.value.map((x) => (x.id === id ? { ...x, loadNeighbors: undefined } : x));
    try {
      const neighbors = await load();
      this.frames.value = this.frames.value.map((x) => (x.id === id ? { ...x, neighbors } : x));
    } catch (err) {
      console.warn('Could not decode neighbour frames', err);
    }
  }

  /** The host tapped the subject in `frameId` at `point` (bitmap pixels). */
  setSubject(frameId: string, point: Pt): void {
    this.subject.value = { frameId, point };
    this.manualPoints.value = {};
    this.adjustments.value = {};
    void this.runAlignment();
  }

  /** Manual correction: the subject is at `point` in this frame. */
  pinSubject(frameId: string, point: Pt): void {
    if (!this.subject.value) return this.setSubject(frameId, point);
    if (this.subject.value.frameId === frameId) this.subject.value = { frameId, point };
    else this.manualPoints.value = { ...this.manualPoints.value, [frameId]: point };
    void this.runAlignment();
  }

  /** Nudge a frame in aligned space: shift (in output pixels), rotate (radians), zoom (factor). */
  nudge(frameId: string, change: { dx?: number; dy?: number; rotate?: number; zoom?: number }): void {
    const plan = this.plan.value;
    const perOutputPx = plan.crop.w / plan.width;
    const cur = this.adjustments.value[frameId] ?? { a: 1, b: 0, tx: 0, ty: 0 };
    const scale = change.zoom ?? 1;
    const ang = change.rotate ?? 0;
    const step: Sim = {
      a: scale * Math.cos(ang),
      b: scale * Math.sin(ang),
      tx: (change.dx ?? 0) * perOutputPx,
      ty: (change.dy ?? 0) * perOutputPx,
    };
    this.adjustments.value = { ...this.adjustments.value, [frameId]: simCompose(step, cur) };
  }

  resetAdjustments(frameId: string): void {
    const adj = { ...this.adjustments.value };
    delete adj[frameId];
    const pins = { ...this.manualPoints.value };
    const hadPin = frameId in pins;
    delete pins[frameId];
    batch(() => {
      this.adjustments.value = adj;
      this.manualPoints.value = pins;
    });
    if (hadPin) void this.runAlignment();
  }

  /* ----------------------------- analysis ----------------------------- */

  private statsFor(f: ProjectFrame): ColorStats {
    let s = this.statsCache.get(f.id);
    if (!s) {
      const k = Math.min(1, 192 / Math.max(f.bitmap.width, f.bitmap.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(f.bitmap.width * k));
      c.height = Math.max(1, Math.round(f.bitmap.height * k));
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(f.bitmap, 0, 0, c.width, c.height);
      s = computeStats(ctx.getImageData(0, 0, c.width, c.height).data);
      this.statsCache.set(f.id, s);
    }
    return s;
  }

  private grayFor(f: ProjectFrame): GrayImage {
    let g = this.grayCache.get(f.id);
    if (!g) {
      const k = Math.min(1, ANALYSIS_SIDE / Math.max(f.bitmap.width, f.bitmap.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(f.bitmap.width * k));
      c.height = Math.max(1, Math.round(f.bitmap.height * k));
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(f.bitmap, 0, 0, c.width, c.height);
      g = toGray(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      this.grayCache.set(f.id, g);
    }
    return g;
  }

  private async ensureFeatures(frames: ProjectFrame[], label: string): Promise<void> {
    this.busy.value = { label: 'Loading the alignment engine…', progress: 0 };
    await this.features.init();
    let i = 0;
    for (const f of frames) {
      if (!this.detected.has(f.id)) {
        this.busy.value = { label, progress: i / frames.length };
        await this.features.detect(f.id, this.grayFor(f));
        this.detected.add(f.id);
      }
      i++;
    }
  }

  /** Matches between a and b in bitmap pixel coordinates (cached). */
  private async matches(a: ProjectFrame, b: ProjectFrame): Promise<MatchSet> {
    const key = `${a.id}>${b.id}`;
    const hit = this.pairCache.get(key);
    if (hit) return hit;
    const rev = this.pairCache.get(`${b.id}>${a.id}`);
    if (rev) return { src: rev.dst, dst: rev.src, count: rev.count };
    const m = await this.features.match(a.id, b.id);
    const ka = a.bitmap.width / this.grayFor(a).width;
    const kb = b.bitmap.width / this.grayFor(b).width;
    for (let i = 0; i < m.src.length; i++) {
      m.src[i] *= ka;
      m.dst[i] *= kb;
    }
    this.pairCache.set(key, m);
    return m;
  }

  /** (Re)compute alignment from the subject point, reusing cached feature matches. */
  async runAlignment(): Promise<void> {
    const run = ++this.alignRun;
    const subject = this.subject.value;
    const frames = this.ordered.value;
    const anchor = frames.findIndex((f) => f.id === subject?.frameId);
    if (!subject || anchor < 0) {
      this.alignment.value = null;
      return;
    }
    const geoms = frames.map((f) => ({ width: f.bitmap.width, height: f.bitmap.height, roll: f.roll }));
    const pins: Record<number, Pt> = {};
    frames.forEach((f, i) => {
      const p = this.manualPoints.value[f.id];
      if (p) pins[i] = p;
    });
    const opts = { useSensorRoll: this.settings.value.levelWithSensors, manualPoints: pins };
    let pairs: (PairMatches | null)[] = frames.slice(1).map(() => null);
    let note: string | null = null;
    try {
      await this.ensureFeatures(frames, 'Finding details in each photo…');
      pairs = [];
      for (let i = 0; i < frames.length - 1; i++) {
        if (run !== this.alignRun) return;
        this.busy.value = { label: 'Matching neighbouring views…', progress: i / Math.max(1, frames.length - 1) };
        pairs.push(await this.matches(frames[i], frames[i + 1]));
      }
    } catch (err) {
      note = `Automatic alignment is unavailable here (${(err as Error).message}). Tap the subject in each photo to line them up.`;
    } finally {
      if (run === this.alignRun) this.busy.value = null;
    }
    if (run !== this.alignRun) return;
    const result = alignChain(geoms, { index: anchor, point: subject.point }, pairs, opts);
    const unsure = frames.filter((_, i) => result[i].confidence === 'failed' || result[i].confidence === 'weak').map((f) => f.name);
    if (!note && unsure.length)
      note = `Check ${unsure.join(', ')}: few matching details were found, so their alignment is a guess. Tap one to fix it.`;
    batch(() => {
      this.alignment.value = Object.fromEntries(frames.map((f, i) => [f.id, result[i]]));
      this.alignNote.value = note;
    });
  }

  /** Suggest a left-to-right order from how much neighbouring views have in common. */
  async autoOrder(): Promise<void> {
    const frames = this.ordered.value;
    if (frames.length < 3) return;
    try {
      await this.ensureFeatures(frames, 'Finding details in each photo…');
      const n = frames.length;
      const sim = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      let done = 0;
      const total = (n * (n - 1)) / 2;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          this.busy.value = { label: 'Comparing every pair of views…', progress: done++ / total };
          sim[i][j] = sim[j][i] = (await this.matches(frames[i], frames[j])).count;
        }
      }
      const path = orientLike(
        bestPath(sim),
        frames.map((_, i) => i),
      );
      const excluded = this.order.value.filter((id) => this.excluded.value.includes(id));
      this.setOrder([...path.map((i) => frames[i].id), ...excluded]);
    } catch (err) {
      this.alignNote.value = `Auto order is unavailable here (${(err as Error).message}).`;
    } finally {
      this.busy.value = null;
    }
  }

  /* ----------------------------- rendering ----------------------------- */

  /** Upload what the renderer needs (textures, LUTs, caption) for the current state. */
  prepare(r: FrameRenderer): void {
    const plan = this.plan.value;
    r.resize(plan.width, plan.height);
    const luts = this.luts.value;
    for (const f of this.ordered.value) {
      if (!r.hasSource(f.id)) r.setSource(f.id, f.bitmap);
      r.setLuts(f.id, luts?.[f.id] ?? null);
      for (const [sub, bmp] of Object.entries(f.neighbors)) {
        const key = sourceKey(f.id, Number(sub));
        if (!r.hasSource(key)) r.setSource(key, bmp);
        r.setLuts(key, luts?.[f.id] ?? null);
      }
    }
    r.setCaption(this.settings.value.caption ? makeCaption(plan.width, plan.height, this.captionText.value) : null);
  }

  drawItem(r: FrameRenderer, item: TimelineFrame): void {
    const frames = this.ordered.value;
    const f = frames[item.frame];
    if (!f) return;
    let sim = this.plan.value.transforms[item.frame];
    let key = f.id;
    const nb = item.sub !== 0 ? f.neighbors[item.sub] : undefined;
    if (nb) {
      key = sourceKey(f.id, item.sub);
      // Neighbour frames come at a lower resolution: scale up to the main frame's pixel grid.
      const k = f.bitmap.width / nb.width;
      sim = simCompose(sim, { a: k, b: 0, tx: 0, ty: 0 });
    }
    const s = this.settings.value;
    r.draw(key, sim, { vignette: s.vignette ? 0.42 : 0, caption: s.caption });
  }

  async export(onProgress?: (p: number) => void, signal?: AbortSignal, methods?: ExportMethod[]): Promise<ExportResult> {
    const plan = this.plan.value;
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const r = createRenderer(canvas);
    try {
      this.prepare(r);
      return await exportClip({
        canvas,
        timeline: this.timeline.value,
        draw: (item) => this.drawItem(r, item),
        onProgress,
        signal,
        methods,
      });
    } finally {
      r.dispose();
    }
  }

  dispose(): void {
    this.features.dispose();
    for (const f of this.frames.value) {
      f.bitmap.close();
      for (const b of Object.values(f.neighbors)) b.close();
    }
    this.frames.value = [];
  }
}
