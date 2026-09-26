/**
 * Feature worker: loads OpenCV.js (lazily, only when the host starts editing)
 * and runs ORB detection and matching off the main thread.
 */
import { detectOrb, matchFeatures, type FeatureSet, type GrayImage } from './features';

export type WorkerRequest =
  | { type: 'init'; reqId: number; url: string }
  | { type: 'detect'; reqId: number; id: string; image: GrayImage; nfeatures?: number }
  | { type: 'match'; reqId: number; a: string; b: string }
  | { type: 'clear'; reqId: number };

export type WorkerResponse =
  | { type: 'ok'; reqId: number; count?: number }
  | { type: 'matched'; reqId: number; src: Float32Array; dst: Float32Array; count: number }
  | { type: 'error'; reqId: number; message: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CV = any;

const scope = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  cv?: CV;
};

// Wrapped in an object: the OpenCV module is a thenable and must never be awaited itself.
let loading: Promise<{ cv: CV }> | null = null;
const features = new Map<string, FeatureSet>();

function loadOpenCV(url: string): Promise<{ cv: CV }> {
  loading ??= (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download OpenCV (${res.status}).`);
    const code = await res.text();
    // The UMD bundle sets `cv` on the global object when evaluated in global scope.
    (0, eval)(code);
    const mod = scope.cv;
    if (!mod) throw new Error('OpenCV did not initialise.');
    if (!mod.Mat) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('OpenCV took too long to start.')), 60_000);
        mod.onRuntimeInitialized = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    return { cv: mod };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await loadOpenCV(msg.url);
        scope.postMessage({ type: 'ok', reqId: msg.reqId });
        return;
      case 'detect': {
        if (!loading) throw new Error('OpenCV not loaded');
        const { cv } = await loading;
        const set = detectOrb(cv, msg.image, msg.nfeatures ?? 2000);
        features.set(msg.id, set);
        scope.postMessage({ type: 'ok', reqId: msg.reqId, count: set.count });
        return;
      }
      case 'match': {
        if (!loading) throw new Error('OpenCV not loaded');
        const { cv } = await loading;
        const a = features.get(msg.a);
        const b = features.get(msg.b);
        if (!a || !b) throw new Error('Unknown frame');
        const m = matchFeatures(cv, a, b);
        scope.postMessage({ type: 'matched', reqId: msg.reqId, src: m.src, dst: m.dst, count: m.count }, [m.src.buffer, m.dst.buffer]);
        return;
      }
      case 'clear':
        features.clear();
        scope.postMessage({ type: 'ok', reqId: msg.reqId });
        return;
    }
  } catch (err) {
    scope.postMessage({ type: 'error', reqId: msg.reqId, message: (err as Error).message || String(err) });
  }
};
