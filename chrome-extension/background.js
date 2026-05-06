// Service worker — currently no-op; the heavy lifting is in popup.js.
// Kept for manifest v3 compatibility and future right-click context menu support.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
