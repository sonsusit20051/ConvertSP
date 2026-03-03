(function (window) {
  const state = {
    lastFull: "",
    isConverting: false,
    lastConvertAt: 0,
    convertCooldownUntil: 0,
    source: "fb"
  };

  function setLastFull(value) {
    state.lastFull = value || "";
  }

  function getLastFull() {
    return state.lastFull;
  }

  function setConverting(value) {
    state.isConverting = Boolean(value);
  }

  function isConverting() {
    return state.isConverting;
  }

  function setLastConvertAt(value) {
    state.lastConvertAt = Number(value) || 0;
  }

  function getLastConvertAt() {
    return state.lastConvertAt;
  }

  function setConvertCooldownUntil(value) {
    state.convertCooldownUntil = Number(value) || 0;
  }

  function getConvertCooldownUntil() {
    return state.convertCooldownUntil;
  }

  function setSource(value) {
    state.source = String(value || "fb").toLowerCase() === "yt" ? "yt" : "fb";
  }

  function getSource() {
    return state.source || "fb";
  }

  window.ShopeeState = {
    setLastFull,
    getLastFull,
    setConverting,
    isConverting,
    setLastConvertAt,
    getLastConvertAt,
    setConvertCooldownUntil,
    getConvertCooldownUntil,
    setSource,
    getSource
  };
})(window);
