(() => {
  const $ = (id) => document.getElementById(id);

  const dot = $("dot");
  const authMode = $("authMode");
  const connectionState = $("connectionState");
  const backendHealth = $("backendHealth");
  const keepAlive = $("keepAlive");
  const dashboardReload = $("dashboardReload");
  const capturedHeaders = $("capturedHeaders");
  const lastRun = $("lastRun");
  const errorBox = $("errorBox");
  const btnRefresh = $("btnRefresh");
  const btnRun = $("btnRun");
  const btnToggleConnection = $("btnToggleConnection");
  let currentConnected = true;

  function setError(msg) {
    if (!msg) {
      errorBox.textContent = "";
      errorBox.classList.add("hidden");
      return;
    }
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }

  function humanizeError(msg) {
    const text = String(msg || "");
    if (!text) return "Không xác định được lỗi.";
    if (text.includes("Failed to fetch")) {
      return "Không kết nối được backend. Hãy kiểm tra backend đã chạy và BACKEND_BASE_URL đúng.";
    }
    if (text.toLowerCase().includes("captcha")) {
      return "Shopee đang yêu cầu xác minh captcha. Mở tab affiliate worker và hoàn thành xác minh.";
    }
    return text;
  }

  function fmtIso(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString();
  }

  function setDot(kind) {
    dot.classList.remove("ok", "warn", "err");
    dot.classList.add(kind);
  }

  function renderStatus(payload) {
    const status = payload.status || {};
    const backend = status.backendHealth || {};
    const worker = status.worker || {};
    const ka = status.keepAlive || {};
    const conn = status.connection || {};
    const hc = status.headerCache || {};
    authMode.textContent = String(status.authMode || "unknown").toUpperCase();
    currentConnected = conn.connected !== false;
    connectionState.textContent = currentConnected ? "Đang kết nối" : "Đã ngắt kết nối";
    btnToggleConnection.textContent = currentConnected ? "Ngắt kết nối" : "Kết nối lại";
    btnRun.disabled = !currentConnected;

    backendHealth.textContent = backend.ok ? "Online" : "Offline";
    keepAlive.textContent = ka.offscreenActive ? "On" : "Fallback";
    const totalReloads = Number.isFinite(Number(ka.totalDashboardReloadCount)) ? Number(ka.totalDashboardReloadCount) : 0;
    const lastReloadTabs = Number.isFinite(Number(ka.lastDashboardReloadCount)) ? Number(ka.lastDashboardReloadCount) : 0;
    const lastReloadAt = fmtIso(ka.lastDashboardReloadAt);
    dashboardReload.textContent = `${totalReloads} (gần nhất: ${lastReloadTabs} tab @ ${lastReloadAt})`;
    capturedHeaders.textContent = String(hc.headerCount || 0);
    lastRun.textContent = fmtIso(worker.lastCycleFinishedAt);

    if (!currentConnected) {
      setDot("warn");
      setError("Extension đang ngắt kết nối. Worker sẽ tạm dừng poll job và reload dashboard.");
      return;
    }

    if (worker.lastError) {
      setDot("err");
      setError(worker.lastError);
      return;
    }

    if (!backend.ok) {
      setDot("warn");
      setError(backend.error || "Backend chưa kết nối được.");
      return;
    }

    setDot("ok");
    setError("");
  }

  async function callBackground(type, payload) {
    return chrome.runtime.sendMessage({
      type,
      ...(payload && typeof payload === "object" ? payload : {})
    });
  }

  async function refreshStatus() {
    try {
      const res = await callBackground("POPUP_GET_STATUS");
      if (!res || !res.ok) {
        throw new Error((res && res.error) || "Không đọc được trạng thái extension.");
      }
      renderStatus(res);
    } catch (err) {
      setDot("err");
      setError(humanizeError((err && err.message) || "Popup không kết nối được background."));
    }
  }

  async function runNow() {
    btnRun.disabled = true;
    btnRefresh.disabled = true;
    btnToggleConnection.disabled = true;
    setError("");

    try {
      const res = await callBackground("POPUP_RUN_NOW");
      if (!res || !res.ok) {
        throw new Error((res && res.error) || "Không chạy được worker cycle.");
      }
      renderStatus(res);
    } catch (err) {
      setDot("err");
      setError(humanizeError((err && err.message) || "Run now thất bại."));
    } finally {
      btnRun.disabled = !currentConnected;
      btnRefresh.disabled = false;
      btnToggleConnection.disabled = false;
    }
  }

  async function toggleConnection() {
    btnRun.disabled = true;
    btnRefresh.disabled = true;
    btnToggleConnection.disabled = true;
    setError("");

    try {
      const res = await callBackground("POPUP_SET_CONNECTION", { connected: !currentConnected });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || "Không đổi được trạng thái kết nối.");
      }
      renderStatus(res);
    } catch (err) {
      setDot("err");
      setError(humanizeError((err && err.message) || "Toggle kết nối thất bại."));
    } finally {
      btnRun.disabled = !currentConnected;
      btnRefresh.disabled = false;
      btnToggleConnection.disabled = false;
    }
  }

  btnRefresh.addEventListener("click", refreshStatus);
  btnRun.addEventListener("click", runNow);
  btnToggleConnection.addEventListener("click", toggleConnection);

  refreshStatus();
})();
