let unlockKey;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  event.waitUntil(
    (async () => {
      if (event.data.type === "unlock" && event.data.key instanceof CryptoKey) {
        unlockKey = event.data.key;
        event.ports[0].postMessage(true);
      } else if (event.data.type === "fingerprint") {
        const encrypted =
          unlockKey &&
          (await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: new Uint8Array(12) },
            unlockKey,
            new TextEncoder().encode("fixture key identity"),
          ));
        event.ports[0].postMessage(
          encrypted ? Array.from(new Uint8Array(encrypted)) : null,
        );
      }
    })(),
  );
});
