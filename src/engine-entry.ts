// Entry point of engine.js. In a Web Worker it answers the page's messages; loaded as an ordinary
// script (the fallback when a worker can't start) it only exposes the Engine class.
import { Engine } from './engine';

const g = globalThis as any;
if (typeof g.WorkerGlobalScope !== 'undefined' && g instanceof g.WorkerGlobalScope) {
  const engine = new Engine((m, transfer) => g.postMessage(m, transfer || []), true);
  g.onmessage = (e: MessageEvent) => engine.handle(e.data);
  g.postMessage({ t: 'ready', bitmaps: engine.bitmaps });
} else {
  g.PPXEngine = Engine;
}
