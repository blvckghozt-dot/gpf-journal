const CACHE = 'gpfj-v8';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const net = () => fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; });
  if (u.pathname.includes('/data/') || u.pathname.endsWith('/') || u.pathname.endsWith('index.html')) { e.respondWith(net().catch(() => caches.match(e.request))); return; }
  e.respondWith(caches.match(e.request).then(r => r || net()));
});
