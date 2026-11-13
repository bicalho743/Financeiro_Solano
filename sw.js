/* Service worker do Financeiro: permite instalar como app e abrir mesmo sem internet.
   A página vem sempre da rede quando há conexão (o app tem o próprio aviso de versão nova);
   a cópia guardada só é usada offline. Dados (Supabase) e bibliotecas externas não passam por aqui. */
const CACHE = "financeiro-v1";
const BASE = ["./", "./index.html", "./manifest.webmanifest", "./icones/icone-192.png", "./icones/icone-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => {
      const copia = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", copia)); return r;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  if (url.pathname.includes("/icones/") || url.pathname.endsWith(".webmanifest")) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
  }
});
