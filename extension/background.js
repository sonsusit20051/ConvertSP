importScripts(
  "config.js",
  "header-cache.js",
  "internal-api.js",
  "backend-api.js",
  "worker-runner.js",
  "keepalive.js",
  "popup-bridge.js"
);

// Capture anti-abuse headers from real Shopee Affiliate traffic when available.
self.ExtHeaderCache.initHeaderCapture();

// Boot keep-alive orchestration every time service worker starts.
self.ExtKeepAlive.initKeepAlive().catch((err) => {
  console.error("Failed to initialize extension keepalive:", err);
});
