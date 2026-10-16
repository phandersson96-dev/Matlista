// Sparar appens filer så att den startar snabbt och även utan nät.
// Listan själv synkas av Firebase, som har en egen offline-cache.
const CACHE = "matlista-v15";
// index.html laddar style.css och app.js med ?v=N, så en ny version får alltid nya adresser.
const FILES = ["./", "index.html", "style.css?v=15", "app.js?v=15", "ingredients.js?v=15", "config.js", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Nätet först, cachen som reserv: nya versioner av appen syns direkt.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: fråga alltid servern om filen ändrats, i stället för webbläsarens 10-minuterscache.
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

// Påminnelser från Cloudflare, t.ex. "Ta fram kyckling ur frysen".
self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || "Matlista", {
    body: msg.body || "",
    tag: msg.tag || undefined,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    return win ? win.focus() : self.clients.openWindow("./");
  }));
});
