(function (window) {
  const cfg = window.ShopeeConfig;
  const dom = window.ShopeeDom;
  const state = window.ShopeeState;
  const ui = window.ShopeeUI;
  const validators = window.ShopeeValidators;
  const clipboard = window.ShopeeClipboard;
  const api = window.ShopeeApi;
  const cacheKey = cfg.INPUT_CACHE_KEY || "shopee_converter_input_cache";
  const affiliateRoundRobinKeyPrefix = "shopee_fallback_affiliate_rr_index";
  const MARKET_DOMAIN_BY_TLD = {
    vn: "shopee.vn",
    th: "shopee.co.th",
    sg: "shopee.sg",
    my: "shopee.com.my",
    ph: "shopee.ph",
    id: "shopee.co.id",
    tw: "shopee.tw",
    br: "shopee.com.br",
    mx: "shopee.com.mx",
    co: "shopee.com.co",
    cl: "shopee.cl"
  };
  let waitTicker = null;
  let cooldownTicker = null;
  let affiliateRoundRobinIndex = 0;

  function normalizeSource(value) {
    return String(value || "fb").toLowerCase() === "yt" ? "yt" : "fb";
  }

  function getFallbackProfile(source) {
    const normalizedSource = normalizeSource(source);
    if (normalizedSource === "yt") {
      return {
        source: normalizedSource,
        affiliateIds: Array.isArray(cfg.FALLBACK_YT_AFFILIATE_IDS) ? cfg.FALLBACK_YT_AFFILIATE_IDS : [],
        affiliatePickMode: String(cfg.FALLBACK_YT_AFFILIATE_PICK_MODE || "fixed"),
        defaultTld: String(cfg.FALLBACK_YT_DEFAULT_TLD || cfg.FALLBACK_DEFAULT_TLD || "vn"),
        subSlots: Array.isArray(cfg.FALLBACK_YT_SUB_SLOTS) ? cfg.FALLBACK_YT_SUB_SLOTS : [],
        subIdLegacy: String(cfg.FALLBACK_YT_SUB_ID || ""),
        subHyphenPolicy: String(cfg.FALLBACK_YT_SUB_HYPHEN_POLICY || cfg.FALLBACK_SUB_HYPHEN_POLICY || "sanitize"),
        subKeepEmptySlots: cfg.FALLBACK_YT_SUB_KEEP_EMPTY_SLOTS !== false,
        includeGadsTSig: cfg.FALLBACK_YT_INCLUDE_GADS_T_SIG !== false
      };
    }
    return {
      source: "fb",
      affiliateIds: Array.isArray(cfg.FALLBACK_AFFILIATE_IDS) ? cfg.FALLBACK_AFFILIATE_IDS : [],
      affiliatePickMode: String(cfg.FALLBACK_AFFILIATE_PICK_MODE || "random"),
      defaultTld: String(cfg.FALLBACK_DEFAULT_TLD || "vn"),
      subSlots: Array.isArray(cfg.FALLBACK_SUB_SLOTS) ? cfg.FALLBACK_SUB_SLOTS : [],
      subIdLegacy: String(cfg.FALLBACK_SUB_ID || ""),
      subHyphenPolicy: String(cfg.FALLBACK_SUB_HYPHEN_POLICY || "sanitize"),
      subKeepEmptySlots: cfg.FALLBACK_SUB_KEEP_EMPTY_SLOTS !== false,
      includeGadsTSig: false
    };
  }

  function readAffiliateRoundRobinIndex(source) {
    const storageKey = `${affiliateRoundRobinKeyPrefix}_${normalizeSource(source)}`;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
    } catch (_) {}
    return affiliateRoundRobinIndex;
  }

  function writeAffiliateRoundRobinIndex(source, value) {
    const storageKey = `${affiliateRoundRobinKeyPrefix}_${normalizeSource(source)}`;
    affiliateRoundRobinIndex = Math.max(0, Math.trunc(Number(value) || 0));
    try {
      window.localStorage.setItem(storageKey, String(affiliateRoundRobinIndex));
    } catch (_) {}
  }

  function pickFallbackAffiliateId(source) {
    const profile = getFallbackProfile(source);
    let ids = profile.affiliateIds;
    if ((!Array.isArray(ids) || ids.length === 0) && profile.source === "yt") {
      // Safe default for YT fallback if config is missing.
      ids = ["17391540096"];
    }

    const normalized = ids
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    if (normalized.length === 0) return "";
    const mode = String(profile.affiliatePickMode || "random").trim().toLowerCase();
    if (mode === "fixed") return normalized[0];
    if (mode === "round_robin" || mode === "round-robin") {
      const cursor = readAffiliateRoundRobinIndex(profile.source);
      const idx = cursor % normalized.length;
      writeAffiliateRoundRobinIndex(profile.source, cursor + 1);
      return normalized[idx];
    }
    const randomIdx = Math.floor(Math.random() * normalized.length);
    return normalized[randomIdx];
  }

  function pickQueryParamCaseInsensitive(parsedUrl, key) {
    if (!parsedUrl || !parsedUrl.searchParams) return "";
    for (const [rawKey, rawValue] of parsedUrl.searchParams.entries()) {
      if (String(rawKey || "").toLowerCase() === String(key || "").toLowerCase()) {
        return String(rawValue || "").trim();
      }
    }
    return "";
  }

  function isAffiliateRedirectPath(pathname) {
    const normalizedPath = String(pathname || "/").trim().replace(/\/+$/, "").toLowerCase();
    return normalizedPath === "/an_redir";
  }

  function extractGadsSigFromUrl(urlText, depth) {
    if (depth > 2) return "";
    let parsed;
    try {
      parsed = new URL(String(urlText || "").trim());
    } catch (_) {
      return "";
    }

    const direct = pickQueryParamCaseInsensitive(parsed, "gads_t_sig");
    if (direct) return direct;

    if (!isAffiliateRedirectPath(parsed.pathname || "/")) return "";
    const originLinkRaw = pickQueryParamCaseInsensitive(parsed, "origin_link");
    if (!originLinkRaw) return "";

    const fromRaw = extractGadsSigFromUrl(originLinkRaw, depth + 1);
    if (fromRaw) return fromRaw;
    try {
      return extractGadsSigFromUrl(decodeURIComponent(originLinkRaw), depth + 1);
    } catch (_) {
      return "";
    }
  }

  function normalizeHost(hostname) {
    return String(hostname || "").trim().toLowerCase().replace(/\.+$/, "");
  }

  function detectTldFromHost(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return "";
    const entries = Object.entries(MARKET_DOMAIN_BY_TLD);
    for (const [tld, domain] of entries) {
      const shortDomain = `s.${domain}`;
      if (
        host === domain
        || host.endsWith(`.${domain}`)
        || host === shortDomain
        || host.endsWith(`.${shortDomain}`)
      ) {
        return tld;
      }
    }
    return "";
  }

  function marketDomainFromTld(tld) {
    const key = String(tld || "").trim().toLowerCase();
    return MARKET_DOMAIN_BY_TLD[key] || "";
  }

  function shortDomainFromTld(tld) {
    const market = marketDomainFromTld(tld);
    if (!market) return "";
    return `s.${market}`;
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

  function parseProductMeta(urlText, depth) {
    if (depth > 2) return null;
    let parsed;
    try {
      parsed = new URL(String(urlText || "").trim());
    } catch (_) {
      return null;
    }

    const tld = detectTldFromHost(parsed.hostname || "");
    const directIds = extractProductIdsFromPath(parsed.pathname || "/");
    if (directIds) {
      return {
        shopId: directIds.shopId,
        itemId: directIds.itemId,
        tld
      };
    }

    const originLinkRaw = parsed.searchParams ? parsed.searchParams.get("origin_link") : "";
    if (!originLinkRaw) return null;

    const fromRaw = parseProductMeta(originLinkRaw, depth + 1);
    if (fromRaw) {
      if (!fromRaw.tld && tld) {
        fromRaw.tld = tld;
      }
      return fromRaw;
    }

    try {
      const decoded = decodeURIComponent(originLinkRaw);
      const decodedMeta = parseProductMeta(decoded, depth + 1);
      if (decodedMeta && !decodedMeta.tld && tld) {
        decodedMeta.tld = tld;
      }
      return decodedMeta;
    } catch (_) {
      return null;
    }
  }

  function buildSubIdFromSlots(source) {
    const profile = getFallbackProfile(source);
    const rawSlots = Array.isArray(profile.subSlots) ? profile.subSlots.slice(0, 5) : [];
    while (rawSlots.length < 5) rawSlots.push("");
    const slots = rawSlots.map((x) => String(x == null ? "" : x).trim());

    // Backward compatibility
    if (slots.every((x) => !x)) {
      slots[0] = String(profile.subIdLegacy || "").trim();
    }

    const policy = String(profile.subHyphenPolicy || "sanitize").trim().toLowerCase();
    for (let i = 0; i < slots.length; i += 1) {
      if (!slots[i].includes("-")) continue;
      if (policy === "strict") {
        return {
          ok: false,
          error: `Sub ${i + 1} không được chứa dấu "-".`
        };
      }
      slots[i] = slots[i].replace(/-/g, "_");
    }

    const keepEmpty = profile.subKeepEmptySlots !== false;
    const subId = keepEmpty
      ? slots.join("-")
      : slots.filter(Boolean).join("-");
    return {
      ok: Boolean(subId || keepEmpty),
      value: subId || ""
    };
  }

  async function resolveFallbackProductMeta(inputUrl) {
    const localMeta = parseProductMeta(inputUrl, 0);
    if (localMeta && localMeta.shopId && localMeta.itemId) {
      return {
        shopId: String(localMeta.shopId),
        itemId: String(localMeta.itemId),
        tld: String(localMeta.tld || "").toLowerCase()
      };
    }

    if (!api || typeof api.resolveProductIds !== "function") {
      return null;
    }

    try {
      const remote = await api.resolveProductIds(inputUrl);
      if (!remote || !remote.shopId || !remote.itemId) {
        return null;
      }
      return {
        shopId: String(remote.shopId),
        itemId: String(remote.itemId),
        tld: String(remote.tld || "").toLowerCase(),
        marketDomain: String(remote.marketDomain || ""),
        shortDomain: String(remote.shortDomain || ""),
        landingClean: String(remote.landingClean || ""),
        resolvedUrl: String(remote.resolvedUrl || "")
      };
    } catch (_) {
      return null;
    }
  }

  async function buildFallbackLink(inputUrl, source) {
    const normalizedSource = normalizeSource(source);
    const profile = getFallbackProfile(normalizedSource);
    const meta = await resolveFallbackProductMeta(inputUrl);
    if (!meta || !meta.shopId || !meta.itemId) return "";

    const affiliateId = pickFallbackAffiliateId(normalizedSource);
    if (!affiliateId) return "";

    const sub = buildSubIdFromSlots(normalizedSource);
    if (!sub.ok) return "";
    const subId = sub.value;
    const tld = String(meta.tld || profile.defaultTld || "vn").toLowerCase();
    const marketDomain = String(meta.marketDomain || marketDomainFromTld(tld)).trim();
    const shortDomain = String(meta.shortDomain || shortDomainFromTld(tld)).trim();
    if (!marketDomain || !shortDomain) return "";

    let landing = String(meta.landingClean || `https://${marketDomain}/product/${meta.shopId}/${meta.itemId}`).trim();
    if (profile.includeGadsTSig) {
      const gadsSig = extractGadsSigFromUrl(inputUrl, 0) || extractGadsSigFromUrl(meta.resolvedUrl || "", 0);
      if (gadsSig) {
        try {
          const landingUrl = new URL(landing);
          landingUrl.searchParams.set("gads_t_sig", gadsSig);
          landing = landingUrl.toString();
        } catch (_) {}
      }
    }

    const baseUrl = `https://${shortDomain}/an_redir`;
    const params = new URLSearchParams({
      origin_link: landing,
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
    const normalizedSource = normalizeSource(source);
    const text = String(message || "").toLowerCase();
    if (!text || isLocalValidationError(text)) return false;
    if (normalizedSource === "yt") {
      return (
        text.includes("quá thời gian chờ xử lý")
        || text.includes("backend phản hồi chậm quá")
        || text.includes("extension worker không phản hồi")
        || text.includes("job processing quá")
        || text.includes("backend không trả về jobid")
        || text.includes("hệ thống đang quá tải")
        || text.includes("http 503")
        || text.includes("http 500")
        || text.includes("failed to fetch")
        || text.includes("worker đang offline")
        || text.includes("luồng 2")
      );
    }
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

  function wait(ms) {
    const safeMs = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => setTimeout(resolve, safeMs));
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

  function sanitizeYtKey(value) {
    return validators.normalizeYtKey(value).replace(/[^A-Z0-9]/g, "").slice(0, 6);
  }

  function requestYtKeyByPopup() {
    if (
      !dom
      || !dom.ytKeyModal
      || !dom.ytKeyModalInput
      || !dom.ytKeyModalError
      || !dom.ytKeyModalCancel
      || !dom.ytKeyModalConfirm
      || !dom.ytKeyModalBackdrop
    ) {
      const entered = window.prompt("Cần key admin cấp để Convert link", "") || "";
      const key = sanitizeYtKey(entered);
      if (!key) {
        throw new Error("Bạn chưa nhập key YT.");
      }
      return Promise.resolve(validators.validateYtKey(key));
    }

    return new Promise((resolve, reject) => {
      const modal = dom.ytKeyModal;
      const input = dom.ytKeyModalInput;
      const errorEl = dom.ytKeyModalError;
      const btnCancel = dom.ytKeyModalCancel;
      const btnConfirm = dom.ytKeyModalConfirm;
      const backdrop = dom.ytKeyModalBackdrop;
      const previousOverflow = document.body.style.overflow;

      let closed = false;

      const cleanup = () => {
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onInputKeyDown);
        btnCancel.removeEventListener("click", onCancel);
        btnConfirm.removeEventListener("click", onConfirm);
        backdrop.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onEsc, true);
      };

      const closeModal = () => {
        if (closed) return;
        closed = true;
        cleanup();
        modal.classList.add("hidden");
        modal.setAttribute("aria-hidden", "true");
        document.body.style.overflow = previousOverflow;
      };

      const onInput = () => {
        const next = sanitizeYtKey(input.value || "");
        if (input.value !== next) input.value = next;
        errorEl.textContent = "";
      };

      const submit = () => {
        const key = sanitizeYtKey(input.value || "");
        try {
          const validKey = validators.validateYtKey(key);
          closeModal();
          resolve(validKey);
        } catch (err) {
          errorEl.textContent = (err && err.message) || "Key không hợp lệ.";
        }
      };

      const onConfirm = (evt) => {
        evt.preventDefault();
        submit();
      };

      const onCancel = (evt) => {
        if (evt) evt.preventDefault();
        closeModal();
        reject(new Error("Bạn chưa nhập key YT."));
      };

      const onInputKeyDown = (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          submit();
        }
      };

      const onEsc = (evt) => {
        if (evt.key === "Escape") {
          evt.preventDefault();
          onCancel(evt);
        }
      };

      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
      input.value = "";
      errorEl.textContent = "";
      document.body.style.overflow = "hidden";

      input.addEventListener("input", onInput);
      input.addEventListener("keydown", onInputKeyDown);
      btnCancel.addEventListener("click", onCancel);
      btnConfirm.addEventListener("click", onConfirm);
      backdrop.addEventListener("click", onCancel);
      document.addEventListener("keydown", onEsc, true);

      setTimeout(() => input.focus(), 0);
    });
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
    const isYoutubeMode = String(source || "fb").toLowerCase() === "yt";

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

    const currentRawInput = dom && dom.inp ? dom.inp.value : ui.getInput();
    const raw = String(currentRawInput || "").trim();
    if (!raw) {
      ui.resetGenerated();
      ui.showDefaultResult();
      ui.setStatus("Bạn chưa nhập link.");
      return;
    }

    let cleaned = "";
    let ytKey = "";
    let flow1StartedAt = 0;
    try {
      if (isYoutubeMode) {
        ytKey = await requestYtKeyByPopup();
      }

      cleaned = validators.normalizeSingleShopeeLink(raw);
      saveInputCache(currentRawInput);

      // Bắt đầu lượt convert mới: xoá output cũ để tránh mở/copy nhầm link trước đó.
      stopCooldownTicker();
      ui.resetGenerated();
      ui.setBusy(true);
      state.setLastConvertAt(now);
      ui.setResultPreview("Đang chuyển đổi...");
      ui.setStatus("Đang gửi yêu cầu convert...");
      flow1StartedAt = Date.now();

      const jobId = await api.createJob(cleaned, source, ytKey);
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
        const minWaitMs = Math.max(1000, Number(cfg.FALLBACK_MIN_WAIT_MS) || 5000);
        const elapsedMs = flow1StartedAt > 0 ? Date.now() - flow1StartedAt : 0;
        const remainingMs = minWaitMs - elapsedMs;
        if (remainingMs > 0) {
          ui.setStatus(`Đang ưu tiên luồng 1... ${Math.ceil(remainingMs / 1000)}s nữa sẽ chuyển luồng 2 nếu chưa có kết quả.`);
          await wait(remainingMs);
        }

        const fallbackUrl = await buildFallbackLink(cleaned || raw, source);
        if (fallbackUrl) {
          ui.setGenerated(fallbackUrl);
          const sourceName = String(source || "fb").toLowerCase() === "yt" ? "YT" : "FB";
          ui.setStatus(`Lỗi gọi API từ extension, đã chuyển sang link dự phòng ${sourceName}.`);
          return;
        }
        const sourceLabel = String(source || "fb").toLowerCase() === "yt" ? "YT" : "FB";
        ui.setStatus(`Không tạo được link dự phòng ${sourceLabel} từ input này. Hãy dán link sản phẩm Shopee rõ shop_id/item_id.`);
      }

      ui.resetGenerated();
      ui.setResultPreview(`Lỗi: ${message}`);
      ui.setStatus(message);
    } finally {
      stopWaitTicker();
      // Keep original input even if page state is interrupted/reloaded.
      if (dom && dom.inp) {
        if (!dom.inp.value) {
          dom.inp.value = currentRawInput;
        }
        saveInputCache(dom.inp.value);
      }
      ui.setBusy(false);
    }
  }

  async function handleCopy() {
    ui.setStatus("");
    const lastFull = state.getLastFull();
    const source = state.getSource ? state.getSource() : "fb";
    const isYoutubeMode = String(source || "fb").toLowerCase() === "yt";

    if (isYoutubeMode) {
      ui.setStatus("Luồng Youtube chỉ hỗ trợ nút Mua ngay.");
      return;
    }

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
        if (dom && dom.inp) {
          saveInputCache(dom.inp.value);
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
    if (dom && dom.inp) {
      saveInputCache(dom.inp.value);
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
