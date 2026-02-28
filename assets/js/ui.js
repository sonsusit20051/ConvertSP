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
    dom.status.textContent = msg || "";
  }

  function setBusy(busy) {
    state.setConverting(busy);
    dom.btnConvert.disabled = busy;
    dom.btnPaste.disabled = busy;
    if (busy) {
      dom.btnCopy.disabled = true;
      dom.btnOpen.disabled = true;
      return;
    }
    const hasOutput = Boolean(state.getLastFull());
    dom.btnCopy.disabled = !hasOutput;
    dom.btnOpen.disabled = !hasOutput;
  }

  function resetGenerated() {
    state.setLastFull("");
    dom.btnCopy.disabled = true;
    dom.btnOpen.disabled = true;
    dom.btnCopy.textContent = "Sao chép";
    dom.resultPreview.removeAttribute("title");
    setPreviewReady(false);
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
    dom.btnCopy.disabled = false;
    dom.btnOpen.disabled = false;
    setResultPreview(fullUrl);
    dom.resultPreview.setAttribute("title", fullUrl);
    setPreviewReady(true);
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
