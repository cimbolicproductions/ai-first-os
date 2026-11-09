self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

// The push is empty on purpose: it only says "look", and the page reads the words itself.
self.addEventListener("push", event => {
  event.waitUntil(self.registration.showNotification("AI-first OS", { body: "Something needs you.", tag: "aios" }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window" })
      .then(list => (list[0] ? list[0].focus() : self.clients.openWindow(self.registration.scope)))
  );
});
