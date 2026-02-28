(function (self) {
  const cfg = self.ExtConfig;
  const runner = self.ExtWorkerRunner;

  const OFFSCREEN_PATH = "offscreen.html";
  const OFFSCREEN_REASON = "WORKERS";
  let lifecycleBound = false;
  const keepAliveStatus = {
    initializedAt: null,
    lastInitError: null,
    offscreenSupported: Boolean(chrome.offscreen),
    offscreenActive: false,
    lastKeepaliveTickAt: null
  };

  async function hasOffscreenDocument() {
    if (!chrome.runtime.getContexts) return false;

    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    return contexts.length > 0;
  }

  async function ensureOffscreenDocument() {
    if (!chrome.offscreen) return;

    try {
      if (await hasOffscreenDocument()) return;

      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [OFFSCREEN_REASON],
        justification: "Keep worker responsive for continuous queue polling."
      });
      keepAliveStatus.offscreenActive = true;
    } catch (err) {
      // If already exists or browser version edge-case, keep alarm fallback alive.
      console.warn("Offscreen document setup warning:", err);
    }
  }

  function setupAlarm() {
    chrome.alarms.create(cfg.WORKER_ALARM, {
      periodInMinutes: cfg.WORKER_ALARM_MINUTES
    });
  }

  function bindLifecycleHandlers() {
    if (lifecycleBound) return;
    lifecycleBound = true;

    chrome.runtime.onInstalled.addListener(() => {
      setupAlarm();
      ensureOffscreenDocument().catch((err) => console.error("Offscreen init failed:", err));
      runner.runWorkerCycle("onInstalled").catch((err) => console.error("Worker init failed:", err));
    });

    chrome.runtime.onStartup.addListener(() => {
      setupAlarm();
      ensureOffscreenDocument().catch((err) => console.error("Offscreen startup failed:", err));
      runner.runWorkerCycle("onStartup").catch((err) => console.error("Worker startup failed:", err));
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== cfg.WORKER_ALARM) return;
      runner.runWorkerCycle("alarm").catch((err) => {
        console.error("Worker alarm cycle failed:", err);
      });
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== cfg.KEEPALIVE_MESSAGE_TYPE) return false;
      keepAliveStatus.lastKeepaliveTickAt = new Date().toISOString();

      runner.runWorkerCycle("keepaliveTick").catch((err) => {
        console.error("Worker keepalive cycle failed:", err);
      });

      sendResponse({ ok: true });
      return true;
    });
  }

  async function initKeepAlive() {
    try {
      bindLifecycleHandlers();
      setupAlarm();
      keepAliveStatus.initializedAt = new Date().toISOString();
      await ensureOffscreenDocument();
      keepAliveStatus.offscreenActive = await hasOffscreenDocument();
      await runner.runWorkerCycle("initKeepAlive");
      keepAliveStatus.lastInitError = null;
    } catch (err) {
      keepAliveStatus.lastInitError = (err && err.message) || "Keepalive init failed.";
      throw err;
    }
  }

  async function getStatus() {
    const offscreenActive = await hasOffscreenDocument().catch(() => false);
    keepAliveStatus.offscreenActive = offscreenActive;
    return { ...keepAliveStatus };
  }

  self.ExtKeepAlive = {
    initKeepAlive,
    getStatus
  };
})(self);
