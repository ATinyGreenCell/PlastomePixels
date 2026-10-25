// The page's side of the engine: a Web Worker when one can start, otherwise the same engine on the
// page. Messages sent before the engine is ready are held and replayed to whichever one answers.
import type { ToEngine, FromEngine } from './protocol';

export interface EngineError extends Error { network?: boolean; aborted?: boolean }

interface Pending { resolve: (v: any) => void; reject: (e: EngineError) => void; onProgress?: (done: number, total: number) => void }

type EngineCtor = new (emit: (m: FromEngine, transfer?: Transferable[]) => void, inWorker: boolean) => { handle(m: ToEngine): void };

export class EngineClient {
  private worker: Worker | null = null;
  private inline: { handle(m: ToEngine): void } | null = null;
  private held: [ToEngine, Transferable[] | undefined][] = [];
  private live = false;
  private seq = 1;
  private pending = new Map<number, Pending>();
  mode: 'worker' | 'page' | 'starting' = 'starting';
  bitmaps = false;
  onTile: (m: Extract<FromEngine, { t: 'tile' }>) => void = () => {};
  onQuad: (m: Extract<FromEngine, { t: 'quad' }>) => void = () => {};

  constructor(workerURL: () => string | null, private loadInline: () => Promise<EngineCtor>) {
    let url: string | null = null;
    try { url = workerURL(); } catch { url = null; }
    if (!url || typeof Worker === 'undefined') { void this.fallBack(); return; }
    try {
      const w = new Worker(url);
      this.worker = w;
      const timer = setTimeout(() => { if (!this.live) void this.fallBack(); }, 6000);
      w.onmessage = (e: MessageEvent<FromEngine>) => {
        const m = e.data;
        if (m.t === 'ready') {
          clearTimeout(timer);
          if (this.mode !== 'starting') return;
          this.mode = 'worker';
          this.bitmaps = m.bitmaps;
          this.go();
          return;
        }
        this.dispatch(m);
      };
      w.onerror = (e) => { e.preventDefault?.(); if (!this.live) { clearTimeout(timer); void this.fallBack(); } };
    } catch {
      void this.fallBack();
    }
  }

  private async fallBack() {
    if (this.mode === 'page') return;
    this.mode = 'page';
    try { this.worker?.terminate(); } catch { /* gone */ }
    this.worker = null;
    try {
      const Ctor = await this.loadInline();
      this.inline = new Ctor(m => this.dispatch(m), false);
      this.go();
    } catch (e) {
      for (const p of this.pending.values()) p.reject(Object.assign(new Error('The page could not start its engine. Reload to try again.'), {}));
      this.pending.clear();
    }
  }

  private go() {
    this.live = true;
    const held = this.held;
    this.held = [];
    for (const [m, tr] of held) this.post(m, tr);
  }

  private post(m: ToEngine, transfer?: Transferable[]) {
    if (!this.live) { this.held.push([m, transfer]); return; }
    if (this.worker) this.worker.postMessage(m, transfer || []);
    else if (this.inline) { const e = this.inline; setTimeout(() => e.handle(m), 0); }
  }

  private dispatch(m: FromEngine) {
    switch (m.t) {
      case 'ok': { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p.resolve(m.result); } break; }
      case 'err': {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p.reject(Object.assign(new Error(m.message), { network: m.network, aborted: m.aborted })); }
        break;
      }
      case 'progress': this.pending.get(m.id)?.onProgress?.(m.done, m.total); break;
      case 'quad': this.onQuad(m); break;
      case 'tile': this.onTile(m); break;
    }
  }

  send(m: ToEngine, transfer?: Transferable[]) { this.post(m, transfer); }

  request<T>(m: ToEngine extends infer U ? (U extends { id: number } ? Omit<U, 'id'> : never) : never,
    onProgress?: (done: number, total: number) => void): { id: number; promise: Promise<T> } {
    const id = this.seq++;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, onProgress }));
    this.post({ ...(m as object), id } as ToEngine);
    return { id, promise };
  }

  cancel(id: number) { this.post({ t: 'cancel', id }); }
}
