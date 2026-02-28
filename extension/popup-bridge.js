(function (self) {
  const cfg = self.ExtConfig;
  const backendApi = self.ExtBackendApi;
  const runner = self.ExtWorkerRunner;
  const keepAlive = self.ExtKeepAlive;

  async function buildStatusPayload() {
    const [backendHealth, keepAliveStatus] = await Promise.all([
      backendApi.checkBackendHealth(),
      keepAlive.getStatus()
    ]);
    const headerCache = self.ExtHeaderCache ? self.ExtHeaderCache.getStatus() : null;

    return {
      backendBaseUrl: cfg.BACKEND_BASE_URL,
      authMode: cfg.INTERNAL_API_AUTH_MODE || "bearer",
      backendHealth,
      keepAlive: keepAliveStatus,
      worker: runner.getStatus(),
      headerCache
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === "POPUP_GET_STATUS") {
      (async () => {
        try {
          const status = await buildStatusPayload();
          sendResponse({ ok: true, status });
        } catch (err) {
          sendResponse({
            ok: false,
            error: (err && err.message) || "Không đọc được trạng thái extension."
          });
        }
      })();
      return true;
    }

    if (message.type === "POPUP_RUN_NOW") {
      (async () => {
        try {
          const result = await runner.runWorkerCycle("popupRunNow");
          const status = await buildStatusPayload();
          sendResponse({ ok: true, result, status });
        } catch (err) {
          sendResponse({
            ok: false,
            error: (err && err.message) || "Run now thất bại."
          });
        }
      })();
      return true;
    }

    return false;
  });
})(self);
