// Dismissal Magic service worker: makes the app installable.
// Always uses the network first, so schools get updates right away;
// if the network is down, it shows the last copy of the app it saw.
const CACHE = "dm-shell-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return; // database & live updates go straight through
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === "navigate" || /\.(js|css|svg|png|webmanifest)$/.test(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "/" : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === "navigate" ? "/" : req))
  );
});
