(function (window) {
  const cfg = window.ShopeeConfig;
  const state = window.ShopeeState;
  const ui = window.ShopeeUI;
  const validators = window.ShopeeValidators;
  const clipboard = window.ShopeeClipboard;
  const api = window.ShopeeApi;
  const cacheKey = cfg.INPUT_CACHE_KEY || "shopee_converter_input_cache";
  let waitTicker = null;
  let cooldownTicker = null;

  function pickFallbackAffiliateId() {
    const ids = Array.isArray(cfg.FALLBACK_AFFILIATE_IDS) ? cfg.FALLBACK_AFFILIATE_IDS : [];
    const normalized = ids
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    if (normalized.length === 0) return "";
    const idx = Math.floor(Math.random() * normalized.length);
    return normalized[idx];
  }

  function extractProductIdsFromPath(pathname) {
    const value = String(pathname || "/");
    let match = value.match(/-i\.(\d+)\.(\d+)\/?$/i);
    if (match) return { shopId: match[1], itemId: match[2] };

    match = value.match(/^\/product\/(\d+)\/(\d+)\/?$/i);
    if (match) return { shopId: match[1], itemId: match[2] };

    match = value.match(/^\/universal-link\/product\/(\d+)\/(\d+)\/?$/i);
    if (match) return { shopId: match[1], itemId: match[2] };

    // Hỗ trợ dạng: /shopname/{shopId}/{itemId}
    match = value.match(/^\/[^/]+\/(\d+)\/(\d+)\/?$/i);
    if (match) return { shopId: match[1], itemId: match[2] };

    return null;
  }

  function parseProductIds(urlText, depth) {
    if (depth > 2) return null;
    let parsed;
    try {
      parsed = new URL(String(urlText || "").trim());
    } catch (_) {
      return null;
    }

    const directIds = extractProductIdsFromPath(parsed.pathname || "/");
    if (directIds) return directIds;

    const originLinkRaw = parsed.searchParams ? parsed.searchParams.get("origin_link") : "";
    if (!originLinkRaw) return null;

    const fromRaw = parseProductIds(originLinkRaw, depth + 1);
    if (fromRaw) return fromRaw;

    try {
      const decoded = decodeURIComponent(originLinkRaw);
      return parseProductIds(decoded, depth + 1);
    } catch (_) {
      return null;
    }
  }

  async function resolveFallbackProductIds(inputUrl) {
    const localIds = parseProductIds(inputUrl, 0);
    if (localIds && localIds.shopId && localIds.itemId) {
      return localIds;
    }

    if (!api || typeof api.resolveProductIds !== "function") {
      return null;
    }

    try {
      const remoteIds = await api.resolveProductIds(inputUrl);
      if (!remoteIds || !remoteIds.shopId || !remoteIds.itemId) {
        return null;
      }
      return {
        shopId: String(remoteIds.shopId),
        itemId: String(remoteIds.itemId)
      };
    } catch (_) {
      return null;
    }
  }

  async function buildFallbackLink(inputUrl) {
    const ids = await resolveFallbackProductIds(inputUrl);
    if (!ids || !ids.shopId || !ids.itemId) return "";

    const affiliateId = pickFallbackAffiliateId();
    if (!affiliateId) return "";

    const subId = String(cfg.FALLBACK_SUB_ID || "cvweb").trim() || "cvweb";
    const baseUrl = String(cfg.FALLBACK_REDIRECT_URL || "https://s.shopee.vn/an_redir").trim();
    if (!baseUrl) return "";

    const originLink = `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`;
    const params = new URLSearchParams({
      origin_link: originLink,
      affiliate_id: affiliateId,
      sub_id: subId
    });
    return `${baseUrl}?${params.toString()}`;
  }

  function isLocalValidationError(message) {
    const text = String(message || "").toLowerCase();
    return (
      text.includes("chỉ cho phép 1 link")
      || text.includes("chỉ dán đúng 1 link")
      || text.includes("vui lòng dùng link http/https")
      || text.includes("chỉ hỗ trợ link sản phẩm shopee hợp lệ")
      || text.includes("thiếu url")
      || text.includes("bạn chưa nhập link")
    );
  }

  function shouldUseFallbackForError(message, source) {
    if (String(source || "fb").toLowerCase() !== "fb") return false;
    const text = String(message || "").toLowerCase();
    if (!text || isLocalValidationError(text)) return false;
    return (
      text.includes("quá thời gian chờ xử lý")
      || text.includes("backend phản hồi chậm quá")
      || text.includes("[cookie/affiliate_tab]")
      || text.includes("[cookie/service_worker]")
      || text.includes("[bearer/service_worker]")
      || text.includes("không convert được link")
      || text.includes("api không trả về afflink")
      || text.includes("shopee trả failcode")
      || text.includes("graphql trả lỗi")
      || text.includes("hệ thống đang quá tải")
      || text.includes("backend không trả về jobid")
      || text.includes("http 429")
      || text.includes("http 503")
      || text.includes("http 500")
      || text.includes("không thể xử lý yêu cầu")
      || text.includes("failed to fetch")
      || text.includes("worker đang offline")
      || text.includes("luồng 2")
    );
  }

  function getCooldownRemainingMs() {
    const until = Number(state.getConvertCooldownUntil()) || 0;
    return Math.max(0, until - Date.now());
  }

  function saveInputCache(value) {
    if (!cfg || !cfg.ENABLE_INPUT_CACHE) return;
    try {
      window.localStorage.setItem(cacheKey, String(value || ""));
    } catch (_) {}
  }

  function stopWaitTicker() {
    if (!waitTicker) return;
    clearInterval(waitTicker);
    waitTicker = null;
  }

  function stopCooldownTicker() {
    if (!cooldownTicker) return;
    clearInterval(cooldownTicker);
    cooldownTicker = null;
  }

  function startCooldownTicker() {
    stopCooldownTicker();

    const render = () => {
      const remainingMs = getCooldownRemainingMs();
      if (remainingMs <= 0) {
        stopCooldownTicker();
        state.setConvertCooldownUntil(0);
        if (!state.isConverting()) {
          ui.setStatus("Đã hết thời gian chờ. Bạn có thể convert link tiếp theo.");
        }
        return;
      }

      const waitSeconds = Math.ceil(remainingMs / 1000);
      ui.setStatus(`Đã tạo link. Bạn có thể Sao chép hoặc Mở. Convert tiếp theo sau ${waitSeconds}s.`);
    };

    render();
    cooldownTicker = setInterval(render, 1000);
  }

  function startWaitTicker(shortJobId) {
    stopWaitTicker();
    const startedAt = Date.now();

    const render = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      ui.setStatus(`Đã nhận yêu cầu #${shortJobId}, đang xử lý ${seconds}s...`);
      ui.setResultPreview(`Đang xử lý job #${shortJobId} (${seconds}s)...`);
    };

    render();
    waitTicker = setInterval(render, 1000);
  }

  async function handlePasteFromClipboard() {
    ui.setStatus("");

    try {
      const text = await clipboard.readClipboardText();
      if (!text) {
        ui.setStatus("Clipboard trống. Hãy copy link Shopee trước.");
        return;
      }

      const cleaned = validators.normalizeSingleShopeeLink(text);
      ui.setInput(cleaned);
      saveInputCache(cleaned);
      ui.resetGenerated();
      ui.setStatus("Đã dán link từ clipboard.");
    } catch (err) {
      const msg = String(err && err.message ? err.message : "");
      if (
        msg.includes("Chỉ cho phép 1 link")
        || msg.includes("Chỉ dán đúng 1 link")
        || msg.includes("Vui lòng dùng link http/https")
        || msg.includes("Chỉ hỗ trợ link sản phẩm Shopee hợp lệ")
      ) {
        ui.setStatus(msg);
        return;
      }

      ui.focusInput();
      ui.setStatus("Trình duyệt chặn đọc clipboard. Hãy nhấn Ctrl/Cmd+V để dán 1 link vào ô nhập.");
    }
  }

  async function handleConvert() {
    ui.setStatus("");
    if (state.isConverting()) return;
    const source = state.getSource ? state.getSource() : "fb";

    const now = Date.now();
    const cooldownRemainingMs = getCooldownRemainingMs();
    if (cooldownRemainingMs > 0) {
      startCooldownTicker();
      return;
    }

    if (now - state.getLastConvertAt() < cfg.MIN_CONVERT_INTERVAL_MS) {
      ui.setStatus("Bạn thao tác quá nhanh, vui lòng thử lại sau 1 giây.");
      return;
    }

    const currentRawInput = window.ShopeeDom && window.ShopeeDom.inp ? window.ShopeeDom.inp.value : ui.getInput();
    const raw = String(currentRawInput || "").trim();
    if (!raw) {
      ui.resetGenerated();
      ui.showDefaultResult();
      ui.setStatus("Bạn chưa nhập link.");
      return;
    }

    let cleaned = "";
    try {
      cleaned = validators.normalizeSingleShopeeLink(raw);
      saveInputCache(currentRawInput);

      // Bắt đầu lượt convert mới: xoá output cũ để tránh mở/copy nhầm link trước đó.
      stopCooldownTicker();
      ui.resetGenerated();
      ui.setBusy(true);
      state.setLastConvertAt(now);
      ui.setResultPreview("Đang chuyển đổi...");
      ui.setStatus("Đang gửi yêu cầu convert...");

      const jobId = await api.createJob(cleaned, source);
      const shortJobId = String(jobId || "").slice(0, 8);
      startWaitTicker(shortJobId);

      const full = await api.waitForJob(jobId);
      stopWaitTicker();
      ui.setGenerated(full);

      const cooldownMs = Math.max(0, Number(cfg.SUCCESS_CONVERT_COOLDOWN_MS) || 0);
      state.setConvertCooldownUntil(Date.now() + cooldownMs);
      if (cooldownMs > 0) {
        startCooldownTicker();
      } else {
        ui.setStatus("Đã tạo link. Bạn có thể Sao chép hoặc Mở.");
      }
    } catch (err) {
      stopWaitTicker();
      const message = (err && err.message) || "Không chuyển đổi được";

      const enableFallback = cfg.FALLBACK_ON_EXTENSION_TIMEOUT !== false;
      if (enableFallback && shouldUseFallbackForError(message, source)) {
        const fallbackUrl = await buildFallbackLink(cleaned || raw);
        if (fallbackUrl) {
          ui.setGenerated(fallbackUrl);
          ui.setStatus("Lỗi gọi API từ extension, đã chuyển sang link dự phòng FB.");
          return;
        }
        ui.setStatus("Không tạo được link dự phòng từ input này. Hãy dán link sản phẩm Shopee rõ shop_id/item_id.");
      }

      ui.resetGenerated();
      ui.setResultPreview(`Lỗi: ${message}`);
      ui.setStatus(message);
    } finally {
      stopWaitTicker();
      // Keep original input even if page state is interrupted/reloaded.
      if (window.ShopeeDom && window.ShopeeDom.inp) {
        if (!window.ShopeeDom.inp.value) {
          window.ShopeeDom.inp.value = currentRawInput;
        }
        saveInputCache(window.ShopeeDom.inp.value);
      }
      ui.setBusy(false);
    }
  }

  async function handleCopy() {
    ui.setStatus("");
    const lastFull = state.getLastFull();

    if (!lastFull) {
      ui.setStatus("Chưa có link. Hãy bấm “Nhận voucher” trước.");
      return;
    }

    const ok = await clipboard.copyText(lastFull);
    if (ok) {
      ui.showCopySuccess();
      ui.setStatus("Đã copy link vào clipboard.");
      return;
    }

    ui.setStatus("Không copy được do trình duyệt chặn. Hãy copy thủ công.");
  }

  function handleOpen() {
    ui.setStatus("");
    const lastFull = state.getLastFull();

    if (!lastFull) {
      ui.setStatus("Chưa có link. Hãy bấm “Nhận voucher” trước.");
      return;
    }

    let parsed;
    try {
      parsed = new URL(lastFull);
      if (!/^https?:$/i.test(parsed.protocol)) {
        throw new Error("Link output phải dùng http/https.");
      }
    } catch (_) {
      ui.setStatus("Link output không hợp lệ, không thể mở.");
      return;
    }

    const opened = window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    if (!opened) {
      ui.setStatus("Trình duyệt chặn popup. Hãy cho phép mở tab mới rồi thử lại.");
    }
  }

  function handleInputPaste(event) {
    ui.setStatus("");
    const text = (event.clipboardData && event.clipboardData.getData("text")) || "";
    if (!text) return;

    try {
      validators.normalizeSingleShopeeLink(text);
      ui.resetGenerated();
      ui.setStatus("Đã dán 1 link hợp lệ.");
      setTimeout(() => {
        if (window.ShopeeDom && window.ShopeeDom.inp) {
          saveInputCache(window.ShopeeDom.inp.value);
        }
      }, 0);
    } catch (err) {
      event.preventDefault();
      ui.resetGenerated();
      ui.setStatus((err && err.message) || "Nội dung dán không hợp lệ.");
    }
  }

  function handleInputChange() {
    ui.setStatus("");
    ui.resetGenerated();
    if (window.ShopeeDom && window.ShopeeDom.inp) {
      saveInputCache(window.ShopeeDom.inp.value);
    }
  }

  window.ShopeeActions = {
    handlePasteFromClipboard,
    handleConvert,
    handleCopy,
    handleOpen,
    handleInputPaste,
    handleInputChange
  };
})(window);
