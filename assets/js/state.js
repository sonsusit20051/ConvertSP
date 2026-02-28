(function (window) {
  const state = {
    lastFull: "",
    isConverting: false,
    lastConvertAt: 0,
    convertCooldownUntil: 0
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

  window.ShopeeState = {
    setLastFull,
    getLastFull,
    setConverting,
    isConverting,
    setLastConvertAt,
    getLastConvertAt,
    setConvertCooldownUntil,
    getConvertCooldownUntil
  };
})(window);
