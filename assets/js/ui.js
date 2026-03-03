(function (window) {
  const dom = window.ShopeeDom;
  const state = window.ShopeeState;

  function setPreviewReady(ready) {
    if (ready) {
      dom.resultPreview.classList.add("ready");
      return;
    }
    dom.resultPreview.classList.remove("ready");
  }

  function setStatus(msg) {
    const source = state.getSource ? state.getSource() : "fb";
    const isYt = String(source || "fb").toLowerCase() === "yt";
    const defaultMsg = String(source || "fb").toLowerCase() === "yt"
      ? "Đang ở chế độ đổi mã Youtube."
      : "Đang ở chế độ đổi mã Facebook.";
    dom.status.classList.remove("source-fb", "source-yt");
    dom.status.classList.add(isYt ? "source-yt" : "source-fb");
    dom.status.textContent = msg || defaultMsg;
  }

  function setReadyButtonsBySource(ready) {
    const hasOutput = Boolean(ready);
    const source = state.getSource ? state.getSource() : "fb";
    const isYt = String(source || "fb").toLowerCase() === "yt";

    dom.btnCopy.classList.remove("is-ready");
    dom.btnOpen.classList.remove("is-ready");

    if (!hasOutput) {
      dom.btnCopy.disabled = true;
      dom.btnOpen.disabled = true;
      return;
    }

    if (isYt) {
      // Luồng YT: chỉ cho phép Mua ngay (đỏ + rung), chặn Sao chép.
      dom.btnCopy.disabled = true;
      dom.btnOpen.disabled = false;
      dom.btnOpen.classList.add("is-ready");
      return;
    }

    // Luồng FB: cho phép copy (đỏ + rung), Mua ngay vẫn dùng được nhưng không đỏ.
    dom.btnCopy.disabled = false;
    dom.btnOpen.disabled = false;
    dom.btnCopy.classList.add("is-ready");
  }

  function setBusy(busy) {
    state.setConverting(busy);
    dom.btnConvert.disabled = busy;
    dom.btnPaste.disabled = busy;
    if (busy) {
      dom.btnCopy.disabled = true;
      dom.btnOpen.disabled = true;
      dom.btnCopy.classList.remove("is-ready");
      dom.btnOpen.classList.remove("is-ready");
      return;
    }
    setReadyButtonsBySource(Boolean(state.getLastFull()));
  }

  function resetGenerated() {
    state.setLastFull("");
    dom.btnCopy.disabled = true;
    dom.btnOpen.disabled = true;
    dom.btnCopy.textContent = "Sao chép";
    dom.resultPreview.removeAttribute("title");
    setPreviewReady(false);
    setReadyButtonsBySource(false);
  }

  function setInput(value) {
    dom.inp.value = value || "";
  }

  function getInput() {
    return dom.inp.value.trim();
  }

  function setResultPreview(text) {
    dom.resultPreview.textContent = text || "";
  }

  function showDefaultResult() {
    setResultPreview("Kết quả sẽ hiển thị ở đây...");
    setPreviewReady(false);
  }

  function setGenerated(fullUrl) {
    state.setLastFull(fullUrl);
    setResultPreview(fullUrl);
    dom.resultPreview.setAttribute("title", fullUrl);
    setPreviewReady(true);
    setReadyButtonsBySource(true);
  }

  function showCopySuccess() {
    dom.btnCopy.textContent = "Đã sao chép ✓";
    setTimeout(() => {
      dom.btnCopy.textContent = "Sao chép";
    }, 1200);
  }

  function focusInput() {
    dom.inp.focus();
  }

  window.ShopeeUI = {
    setStatus,
    setBusy,
    resetGenerated,
    setInput,
    getInput,
    setResultPreview,
    showDefaultResult,
    setGenerated,
    showCopySuccess,
    focusInput
  };
})(window);
