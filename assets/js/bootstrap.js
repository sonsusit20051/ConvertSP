(function (window) {
  const dom = window.ShopeeDom;
  const actions = window.ShopeeActions;
  const cfg = window.ShopeeConfig;
  const state = window.ShopeeState;
  const COMING_SOON_TEXT = "Đang làm sếp ơi, sắp xong rồii";
  const DEFAULT_INPUT_PLACEHOLDER = "Dán link tại đây";

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

  function setFacebookModeUI() {
    if (dom.btnModeFacebook) {
      dom.btnModeFacebook.classList.add("is-active");
      dom.btnModeFacebook.setAttribute("aria-pressed", "true");
    }
    if (dom.btnModeYoutube) {
      dom.btnModeYoutube.classList.remove("is-active");
      dom.btnModeYoutube.setAttribute("aria-pressed", "false");
    }
  }

  function setYoutubeModeUI() {
    if (dom.btnModeFacebook) {
      dom.btnModeFacebook.classList.remove("is-active");
      dom.btnModeFacebook.setAttribute("aria-pressed", "false");
    }
    if (dom.btnModeYoutube) {
      dom.btnModeYoutube.classList.add("is-active");
      dom.btnModeYoutube.setAttribute("aria-pressed", "true");
    }
  }

  function setFacebookPanelState() {
    if (state && typeof state.setSource === "function") {
      state.setSource("fb");
    }
    if (dom.panel) {
      dom.panel.classList.remove("yt-layout");
    }
    if (dom.ytOnlyMessage) {
      dom.ytOnlyMessage.textContent = COMING_SOON_TEXT;
    }
    if (dom.inp) {
      if (dom.inp.value === COMING_SOON_TEXT) {
        dom.inp.value = "";
      }
      dom.inp.readOnly = false;
      dom.inp.placeholder = DEFAULT_INPUT_PLACEHOLDER;
    }
    if (dom.btnPaste) {
      dom.btnPaste.disabled = false;
    }
    if (dom.btnConvert) {
      dom.btnConvert.disabled = false;
    }
    if (dom.status) {
      dom.status.classList.remove("err");
      dom.status.textContent = "Đang ở chế độ đổi mã Facebook.";
    }
  }

  function setYoutubePanelState() {
    if (state && typeof state.setSource === "function") {
      state.setSource("yt");
    }
    if (dom.panel) {
      dom.panel.classList.add("yt-layout");
    }
    if (dom.ytOnlyMessage) {
      dom.ytOnlyMessage.textContent = COMING_SOON_TEXT;
    }
    if (dom.btnPaste) {
      dom.btnPaste.disabled = true;
    }
    if (dom.btnConvert) {
      dom.btnConvert.disabled = true;
    }
    if (dom.btnCopy) {
      dom.btnCopy.disabled = true;
      dom.btnCopy.classList.remove("is-ready");
    }
    if (dom.btnOpen) {
      dom.btnOpen.disabled = true;
      dom.btnOpen.classList.remove("is-ready");
    }
    if (dom.status) {
      dom.status.classList.remove("err");
      dom.status.textContent = "";
    }
  }

  function bindModeEvents() {
    setFacebookModeUI();
    setFacebookPanelState();
    if (dom.btnModeFacebook) {
      dom.btnModeFacebook.addEventListener("click", () => {
        setFacebookModeUI();
        setFacebookPanelState();
      });
    }

    if (dom.btnModeYoutube) {
      dom.btnModeYoutube.addEventListener("click", () => {
        setYoutubeModeUI();
        setYoutubePanelState();
      });
    }
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
    bindModeEvents();
    bindEvents();
    setFacebookPanelState();
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
