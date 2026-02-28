(function (window) {
  const dom = window.ShopeeDom;
  const actions = window.ShopeeActions;
  const cfg = window.ShopeeConfig;

  function validateDom() {
    if (!dom.inp || !dom.btnPaste || !dom.btnConvert || !dom.btnCopy || !dom.btnOpen || !dom.resultPreview || !dom.status) {
      throw new Error("Thiếu phần tử DOM bắt buộc. Kiểm tra lại index.html.");
    }
  }

  function bindEvents() {
    dom.btnPaste.addEventListener("click", actions.handlePasteFromClipboard);
    dom.btnConvert.addEventListener("click", actions.handleConvert);
    dom.btnCopy.addEventListener("click", actions.handleCopy);
    dom.btnOpen.addEventListener("click", actions.handleOpen);
    dom.inp.addEventListener("paste", actions.handleInputPaste);
    dom.inp.addEventListener("input", actions.handleInputChange);
  }

  function restoreCachedInput() {
    if (!cfg || !cfg.ENABLE_INPUT_CACHE) {
      try {
        const disabledKey = (cfg && cfg.INPUT_CACHE_KEY) || "shopee_converter_input_cache";
        window.localStorage.removeItem(disabledKey);
      } catch (_) {}
      if (dom.inp) {
        dom.inp.value = "";
      }
      return;
    }

    const key = (cfg && cfg.INPUT_CACHE_KEY) || "shopee_converter_input_cache";
    if (!dom.inp) return;
    if (dom.inp.value && dom.inp.value.trim()) return;
    try {
      const cached = window.localStorage.getItem(key);
      if (cached && cached.trim()) {
        dom.inp.value = cached;
      }
    } catch (_) {}
  }

  function init() {
    validateDom();
    if (!actions || typeof actions.handleConvert !== "function") {
      throw new Error("Không tải được module actions.js.");
    }
    restoreCachedInput();
    bindEvents();
    if (dom.status) {
      dom.status.textContent = `Sẵn sàng (v${(cfg && cfg.APP_VERSION) || "dev"})`;
    }
  }

  try {
    init();
  } catch (err) {
    if (dom && dom.status) {
      dom.status.textContent = `Lỗi khởi tạo UI: ${(err && err.message) || String(err)}`;
    }
    throw err;
  }

  window.addEventListener("error", (evt) => {
    if (!dom || !dom.status) return;
    const message = (evt && evt.message) || "Lỗi JavaScript không xác định.";
    dom.status.textContent = `Lỗi JS: ${message}`;
  });

  window.addEventListener("unhandledrejection", (evt) => {
    if (!dom || !dom.status) return;
    const reason = evt && evt.reason;
    const message = (reason && reason.message) || String(reason || "Promise reject không rõ nguyên nhân.");
    dom.status.textContent = `Lỗi Promise: ${message}`;
  });
})(window);
