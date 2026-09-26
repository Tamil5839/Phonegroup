/** Main-thread handle on the feature worker (OpenCV runs there). */
import type { GrayImage, MatchSet } from './features';
import type { WorkerRequest, WorkerResponse } from './align.worker';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export class FeatureClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;

  private request(msg: DistributiveOmit<WorkerRequest, 'reqId'>, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('Feature worker not started'));
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      worker.postMessage({ ...msg, reqId } as WorkerRequest, transfer);
    });
  }

  /** Spawn the worker and download/compile OpenCV (~11 MB, cached after the first time). */
  init(): Promise<void> {
    this.ready ??= (async () => {
      const worker = new Worker(new URL('./align.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.reqId);
        if (!p) return;
        this.pending.delete(e.data.reqId);
        if (e.data.type === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data);
      };
      worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Feature worker crashed'));
        this.pending.clear();
      };
      // The pinned OpenCV build is shipped as a static file next to the app (see build/plugins.ts).
      await this.request({ type: 'init', url: new URL(__OPENCV_FILE__, document.baseURI).href });
    })();
    this.ready.catch(() => {
      this.ready = null;
      this.worker?.terminate();
      this.worker = null;
    });
    return this.ready;
  }

  async detect(id: string, image: GrayImage, nfeatures = 2000): Promise<number> {
    await this.init();
    const data = image.data.slice();
    const res = await this.request({ type: 'detect', id, image: { data, width: image.width, height: image.height }, nfeatures }, [
      data.buffer,
    ]);
    return res.type === 'ok' ? (res.count ?? 0) : 0;
  }

  async match(a: string, b: string): Promise<MatchSet> {
    await this.init();
    const res = await this.request({ type: 'match', a, b });
    if (res.type !== 'matched') throw new Error('Unexpected worker reply');
    return { src: res.src, dst: res.dst, count: res.count };
  }

  async clear(): Promise<void> {
    if (this.worker) await this.request({ type: 'clear' });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
  }
}
