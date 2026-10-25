/// <reference lib="webworker" />
// Plastome Pixels service worker: the app opens offline and costs nothing to reopen. Changing VERSION
// (set from src/version.ts at build) is how a new version reaches phones: the browser notices this file
// changed and installs the new copy. A plain script, not a module, so it works in every browser.
const sw = self as unknown as ServiceWorkerGlobalScope;

declare const __VERSION__: string;
const VERSION = __VERSION__;
const SHELL = 'ppx-shell-' + VERSION;
const CORE = ['./', './index.html', './app.js', './engine.js'];            // the app cannot run without these
const EXTRA = ['./manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './fonts/fonts.css',
  './fonts/martian-mono-latin-400-normal.woff2', './fonts/martian-mono-latin-500-normal.woff2', './fonts/martian-mono-latin-700-normal.woff2',
  './fonts/atkinson-hyperlegible-latin-400-normal.woff2', './fonts/atkinson-hyperlegible-latin-700-normal.woff2', './fonts/atkinson-hyperlegible-latin-400-italic.woff2'];

// The app's own files come straight from the site (cache: "reload"), never the phone's web cache: that may
// still hold the previous version's, and a new version stored with old files would never update. Icons and
// fonts never change between versions, so the web cache may serve them (on a first visit the page has just
// fetched them: no second download). Only the core files must arrive; a missing icon or font must not
// block an update.
const fresh = (f: string): Promise<Response> => fetch(new Request(f, { cache: 'reload' }));
const stable = (f: string): Promise<Response> => fetch(new Request(f, { cache: 'default' }));
sw.addEventListener('install', (e: ExtendableEvent) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(CORE.map(async f => {
      const r = await fresh(f);
      if (!r.ok) throw new Error(f + ' answered ' + r.status);
      await c.put(f, r);
    }));
    await Promise.all(EXTRA.map(f => stable(f).then(r => (r.ok ? c.put(f, r) : undefined)).catch(() => undefined)));
    await sw.skipWaiting();
  })());
});

sw.addEventListener('activate', (e: ExtendableEvent) => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('ppx-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => sw.clients.claim()));
});

sw.addEventListener('fetch', (e: FetchEvent) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== sw.location.origin) return;  // NCBI: straight through
  if (url.pathname.endsWith('/version.json')) return;                    // always the site's answer
  // the app itself: from the phone, never the network once installed
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit =>
    hit || caches.match(req.mode === 'navigate' ? './index.html' : req.url).then(h2 => h2 || fetch(req))));
});
