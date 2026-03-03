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
    lastKeepaliveTickAt: null,
    lastDashboardReloadAt: null,
    lastDashboardReloadCount: 0
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

  function setupAlarms() {
    chrome.alarms.create(cfg.WORKER_ALARM, {
      periodInMinutes: cfg.WORKER_ALARM_MINUTES
    });

    if (cfg.DASHBOARD_AUTO_RELOAD_ENABLED) {
      chrome.alarms.create(cfg.DASHBOARD_RELOAD_ALARM, {
        periodInMinutes: cfg.DASHBOARD_RELOAD_MINUTES
      });
    }
  }

  async function reloadAffiliateDashboardTabs(trigger) {
    if (!cfg.DASHBOARD_AUTO_RELOAD_ENABLED) return;

    const patterns = Array.isArray(cfg.DASHBOARD_RELOAD_URL_PATTERNS)
      ? cfg.DASHBOARD_RELOAD_URL_PATTERNS
      : [];
    if (patterns.length === 0) return;

    const tabs = await chrome.tabs.query({ url: patterns });
    if (!tabs || tabs.length === 0) {
      keepAliveStatus.lastDashboardReloadAt = new Date().toISOString();
      keepAliveStatus.lastDashboardReloadCount = 0;
      return;
    }

    let reloaded = 0;
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== "number") continue;
      try {
        await chrome.tabs.reload(tab.id);
        reloaded += 1;
      } catch (err) {
        console.warn("Dashboard reload warning:", trigger, tab.id, err);
      }
    }

    keepAliveStatus.lastDashboardReloadAt = new Date().toISOString();
    keepAliveStatus.lastDashboardReloadCount = reloaded;
  }

  function bindLifecycleHandlers() {
    if (lifecycleBound) return;
    lifecycleBound = true;

    chrome.runtime.onInstalled.addListener(() => {
      setupAlarms();
      ensureOffscreenDocument().catch((err) => console.error("Offscreen init failed:", err));
      runner.runWorkerCycle("onInstalled").catch((err) => console.error("Worker init failed:", err));
    });

    chrome.runtime.onStartup.addListener(() => {
      setupAlarms();
      ensureOffscreenDocument().catch((err) => console.error("Offscreen startup failed:", err));
      runner.runWorkerCycle("onStartup").catch((err) => console.error("Worker startup failed:", err));
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === cfg.WORKER_ALARM) {
        runner.runWorkerCycle("alarm").catch((err) => {
          console.error("Worker alarm cycle failed:", err);
        });
        return;
      }

      if (cfg.DASHBOARD_AUTO_RELOAD_ENABLED && alarm.name === cfg.DASHBOARD_RELOAD_ALARM) {
        reloadAffiliateDashboardTabs("dashboardAlarm").catch((err) => {
          console.error("Dashboard auto-reload failed:", err);
        });
      }
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
      setupAlarms();
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
