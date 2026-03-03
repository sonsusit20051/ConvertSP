(function (self) {
  const cfg = self.ExtConfig;
  const backendApi = self.ExtBackendApi;
  const runner = self.ExtWorkerRunner;
  const keepAlive = self.ExtKeepAlive;
  const connection = self.ExtConnectionState;

  async function buildStatusPayload() {
    const [keepAliveStatus, connectionStatus] = await Promise.all([
      keepAlive.getStatus(),
      connection ? connection.getStatus() : Promise.resolve({ connected: true })
    ]);
    const backendHealth = connectionStatus.connected === false
      ? {
          ok: false,
          status: 0,
          error: "Extension đang ngắt kết nối."
        }
      : await backendApi.checkBackendHealth();
    const headerCache = self.ExtHeaderCache ? self.ExtHeaderCache.getStatus() : null;

    return {
      backendBaseUrl: cfg.BACKEND_BASE_URL,
      authMode: cfg.INTERNAL_API_AUTH_MODE || "bearer",
      backendHealth,
      keepAlive: keepAliveStatus,
      connection: connectionStatus,
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
          if (connection && !(await connection.isConnected())) {
            sendResponse({
              ok: false,
              error: "Extension đang ngắt kết nối. Hãy bấm Kết nối lại trước."
            });
            return;
          }
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

    if (message.type === "POPUP_SET_CONNECTION") {
      (async () => {
        try {
          const nextConnected = Boolean(message.connected);
          if (connection) {
            await connection.setConnected(nextConnected, "popupToggle");
          }
          if (keepAlive && typeof keepAlive.reportWorkerPing === "function") {
            await keepAlive.reportWorkerPing(nextConnected, true);
          } else if (backendApi && typeof backendApi.reportWorkerPing === "function") {
            await backendApi.reportWorkerPing(nextConnected);
          }
          if (nextConnected) {
            runner.runWorkerCycle("popupReconnect").catch(() => {});
          }
          const status = await buildStatusPayload();
          sendResponse({ ok: true, status });
        } catch (err) {
          sendResponse({
            ok: false,
            error: (err && err.message) || "Không đổi được trạng thái kết nối."
          });
        }
      })();
      return true;
    }

    return false;
  });
})(self);
