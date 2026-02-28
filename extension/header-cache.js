(function (self) {
  const cfg = self.ExtConfig;

  const state = {
    initializedAt: null,
    lastCapturedAt: null,
    captured: {}
  };

  function normalizeName(name) {
    return String(name || "").toLowerCase();
  }

  function wantedHeaderSet() {
    const arr = Array.isArray(cfg.INTERNAL_API_CAPTURE_HEADER_NAMES)
      ? cfg.INTERNAL_API_CAPTURE_HEADER_NAMES
      : [];
    return new Set(arr.map(normalizeName));
  }

  function captureHeadersFromRequest(details) {
    const wanted = wantedHeaderSet();
    if (!wanted.size) return;

    const headers = details.requestHeaders || [];
    const out = {};
    for (const h of headers) {
      const name = normalizeName(h.name);
      if (!wanted.has(name)) continue;
      if (h.value) out[name] = h.value;
    }

    if (Object.keys(out).length > 0) {
      state.captured = { ...state.captured, ...out };
      state.lastCapturedAt = new Date().toISOString();
    }
  }

  function initHeaderCapture() {
    if (!chrome.webRequest || !chrome.webRequest.onBeforeSendHeaders) {
      console.warn("webRequest API unavailable; header capture disabled.");
      return;
    }

    chrome.webRequest.onBeforeSendHeaders.addListener(
      captureHeadersFromRequest,
      {
        urls: ["https://affiliate.shopee.vn/api/v3/gql*", "https://*.affiliate.shopee.vn/*"]
      },
      ["requestHeaders", "extraHeaders"]
    );

    state.initializedAt = new Date().toISOString();
  }

  function getCapturedHeaders() {
    return { ...state.captured };
  }

  function getStatus() {
    return {
      initializedAt: state.initializedAt,
      lastCapturedAt: state.lastCapturedAt,
      headerCount: Object.keys(state.captured).length,
      names: Object.keys(state.captured)
    };
  }

  self.ExtHeaderCache = {
    initHeaderCapture,
    getCapturedHeaders,
    getStatus
  };
})(self);
