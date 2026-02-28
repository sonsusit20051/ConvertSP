(() => {
  const $ = (id) => document.getElementById(id);

  const dot = $("dot");
  const authMode = $("authMode");
  const backendHealth = $("backendHealth");
  const keepAlive = $("keepAlive");
  const capturedHeaders = $("capturedHeaders");
  const lastRun = $("lastRun");
  const errorBox = $("errorBox");
  const btnRefresh = $("btnRefresh");
  const btnRun = $("btnRun");

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
    const hc = status.headerCache || {};
    authMode.textContent = String(status.authMode || "unknown").toUpperCase();

    backendHealth.textContent = backend.ok ? "Online" : "Offline";
    keepAlive.textContent = ka.offscreenActive ? "On" : "Fallback";
    capturedHeaders.textContent = String(hc.headerCount || 0);
    lastRun.textContent = fmtIso(worker.lastCycleFinishedAt);

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

  async function callBackground(type) {
    return chrome.runtime.sendMessage({ type });
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
      btnRun.disabled = false;
      btnRefresh.disabled = false;
    }
  }

  btnRefresh.addEventListener("click", refreshStatus);
  btnRun.addEventListener("click", runNow);

  refreshStatus();
})();
