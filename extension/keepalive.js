(function (self) {
  const cfg = self.ExtConfig;
  const runner = self.ExtWorkerRunner;
  const backendApi = self.ExtBackendApi;
  const connection = self.ExtConnectionState;

  const OFFSCREEN_PATH = "offscreen.html";
  const OFFSCREEN_REASON = "WORKERS";
  const RELOAD_METRICS_STORAGE_KEY = "dashboardReloadMetricsV1";
  let lifecycleBound = false;
  let reloadMetricsLoaded = false;
  let reloadMetricsLoadPromise = null;
  const keepAliveStatus = {
    initializedAt: null,
    lastInitError: null,
    offscreenSupported: Boolean(chrome.offscreen),
    offscreenActive: false,
    lastKeepaliveTickAt: null,
    lastDashboardReloadAt: null,
    lastDashboardReloadCount: 0,
    totalDashboardReloadCount: 0,
    totalDashboardReloadCycles: 0,
    lastMetricReportAt: null,
    lastMetricReportError: null
  };

  function sanitizeNonNegativeInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.trunc(n));
  }

  async function loadReloadMetricsOnce() {
    if (reloadMetricsLoaded) return;
    if (reloadMetricsLoadPromise) {
      await reloadMetricsLoadPromise;
      return;
    }

    reloadMetricsLoadPromise = (async () => {
      if (!chrome.storage || !chrome.storage.local) {
        reloadMetricsLoaded = true;
        return;
      }

      const stored = await chrome.storage.local.get(RELOAD_METRICS_STORAGE_KEY).catch(() => ({}));
      const data = stored && stored[RELOAD_METRICS_STORAGE_KEY] ? stored[RELOAD_METRICS_STORAGE_KEY] : {};
      keepAliveStatus.totalDashboardReloadCount = sanitizeNonNegativeInt(data.totalDashboardReloadCount);
      keepAliveStatus.totalDashboardReloadCycles = sanitizeNonNegativeInt(data.totalDashboardReloadCycles);
      keepAliveStatus.lastDashboardReloadAt = data.lastDashboardReloadAt || keepAliveStatus.lastDashboardReloadAt;
      keepAliveStatus.lastDashboardReloadCount = sanitizeNonNegativeInt(data.lastDashboardReloadCount);
      keepAliveStatus.lastMetricReportAt = data.lastMetricReportAt || keepAliveStatus.lastMetricReportAt;
      keepAliveStatus.lastMetricReportError = data.lastMetricReportError || null;
      reloadMetricsLoaded = true;
    })();

    try {
      await reloadMetricsLoadPromise;
    } finally {
      reloadMetricsLoadPromise = null;
    }
  }

  async function persistReloadMetrics() {
    if (!chrome.storage || !chrome.storage.local) return;

    const payload = {
      totalDashboardReloadCount: keepAliveStatus.totalDashboardReloadCount,
      totalDashboardReloadCycles: keepAliveStatus.totalDashboardReloadCycles,
      lastDashboardReloadAt: keepAliveStatus.lastDashboardReloadAt,
      lastDashboardReloadCount: keepAliveStatus.lastDashboardReloadCount,
      lastMetricReportAt: keepAliveStatus.lastMetricReportAt,
      lastMetricReportError: keepAliveStatus.lastMetricReportError
    };
    await chrome.storage.local.set({ [RELOAD_METRICS_STORAGE_KEY]: payload });
  }

  async function reportDashboardReloadMetric(reloadedTabs, cycleCount, lastReloadAt) {
    if (!backendApi || typeof backendApi.reportDashboardReloadMetric !== "function") return;
    if (!cfg.BACKEND_BASE_URL || !cfg.WORKER_KEY) return;

    try {
      await backendApi.reportDashboardReloadMetric(reloadedTabs, cycleCount, lastReloadAt);
      keepAliveStatus.lastMetricReportAt = new Date().toISOString();
      keepAliveStatus.lastMetricReportError = null;
    } catch (err) {
      keepAliveStatus.lastMetricReportError = (err && err.message) || "Không gửi được metric reload.";
      console.warn("Reload metric report warning:", keepAliveStatus.lastMetricReportError);
    }
  }

  async function trackDashboardReloadMetric(reloadedTabs, cycleCount, lastReloadAt) {
    await loadReloadMetricsOnce();
    keepAliveStatus.totalDashboardReloadCount += sanitizeNonNegativeInt(reloadedTabs);
    keepAliveStatus.totalDashboardReloadCycles += sanitizeNonNegativeInt(cycleCount);
    keepAliveStatus.lastDashboardReloadAt = lastReloadAt || keepAliveStatus.lastDashboardReloadAt;
    keepAliveStatus.lastDashboardReloadCount = sanitizeNonNegativeInt(reloadedTabs);
    await reportDashboardReloadMetric(reloadedTabs, cycleCount, lastReloadAt);
    await persistReloadMetrics().catch(() => {});
  }

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
    if (connection && !(await connection.isConnected())) return;
    await loadReloadMetricsOnce();

    const patterns = Array.isArray(cfg.DASHBOARD_RELOAD_URL_PATTERNS)
      ? cfg.DASHBOARD_RELOAD_URL_PATTERNS
      : [];
    if (patterns.length === 0) return;

    const tabs = await chrome.tabs.query({ url: patterns });
    const reloadAt = new Date().toISOString();
    if (!tabs || tabs.length === 0) {
      await trackDashboardReloadMetric(0, 1, reloadAt);
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

    await trackDashboardReloadMetric(reloaded, 1, reloadAt);
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

      (async () => {
        if (connection && !(await connection.isConnected())) return;
        runner.runWorkerCycle("keepaliveTick").catch((err) => {
          console.error("Worker keepalive cycle failed:", err);
        });
      })();

      sendResponse({ ok: true });
      return true;
    });
  }

  async function initKeepAlive() {
    try {
      bindLifecycleHandlers();
      setupAlarms();
      keepAliveStatus.initializedAt = new Date().toISOString();
      await loadReloadMetricsOnce();
      await ensureOffscreenDocument();
      keepAliveStatus.offscreenActive = await hasOffscreenDocument();
      if (!connection || (await connection.isConnected())) {
        await runner.runWorkerCycle("initKeepAlive");
      }
      keepAliveStatus.lastInitError = null;
    } catch (err) {
      keepAliveStatus.lastInitError = (err && err.message) || "Keepalive init failed.";
      throw err;
    }
  }

  async function getStatus() {
    await loadReloadMetricsOnce();
    const offscreenActive = await hasOffscreenDocument().catch(() => false);
    keepAliveStatus.offscreenActive = offscreenActive;
    return { ...keepAliveStatus };
  }

  self.ExtKeepAlive = {
    initKeepAlive,
    getStatus
  };
})(self);
