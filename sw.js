// Lumina AI — Service Worker (yalnızca bildirimler için; önbellek tutmaz)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const c of all) {
            if ("focus" in c) { await c.focus(); return; }
        }
        if (self.clients.openWindow) await self.clients.openWindow(self.registration.scope);
    })());
});
