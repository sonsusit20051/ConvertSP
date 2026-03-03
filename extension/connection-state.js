(function (self) {
  const STORAGE_KEY = "extensionConnectionEnabledV1";

  let loaded = false;
  let loadPromise = null;
  const status = {
    connected: true,
    lastChangedAt: null,
    lastTrigger: null
  };

  async function ensureLoaded() {
    if (loaded) return;
    if (loadPromise) {
      await loadPromise;
      return;
    }

    loadPromise = (async () => {
      if (!chrome.storage || !chrome.storage.local) {
        loaded = true;
        return;
      }

      const stored = await chrome.storage.local.get(STORAGE_KEY).catch(() => ({}));
      const raw = stored ? stored[STORAGE_KEY] : undefined;
      if (typeof raw === "boolean") {
        status.connected = raw;
      } else {
        status.connected = true;
      }
      loaded = true;
    })();

    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  async function persistConnected(value) {
    if (!chrome.storage || !chrome.storage.local) return;
    await chrome.storage.local.set({ [STORAGE_KEY]: Boolean(value) });
  }

  async function isConnected() {
    await ensureLoaded();
    return Boolean(status.connected);
  }

  async function setConnected(value, trigger) {
    await ensureLoaded();
    status.connected = Boolean(value);
    status.lastChangedAt = new Date().toISOString();
    status.lastTrigger = trigger || "unknown";
    await persistConnected(status.connected).catch(() => {});
    return { ...status };
  }

  async function getStatus() {
    await ensureLoaded();
    return { ...status };
  }

  self.ExtConnectionState = {
    isConnected,
    setConnected,
    getStatus
  };
})(self);
