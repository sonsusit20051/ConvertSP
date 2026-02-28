(function () {
  const cfg = self.ExtConfig;

  async function pingWorker() {
    try {
      await chrome.runtime.sendMessage({
        type: cfg.KEEPALIVE_MESSAGE_TYPE,
        source: "offscreen"
      });
    } catch (err) {
      // Worker may be reloading; ignore transient errors.
      console.debug("Keepalive ping warning:", err);
    }
  }

  // Immediate ping then periodic ping to keep the worker frequently awakened.
  pingWorker();
  setInterval(pingWorker, cfg.KEEPALIVE_PING_INTERVAL_SEC * 1000);
})();
