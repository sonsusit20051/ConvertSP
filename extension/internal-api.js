(function (self) {
  const cfg = self.ExtConfig;

  function normalizeError(err, fallback) {
    if (err && err.message) return err.message;
    return fallback;
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function normalizePath(path) {
    return String(path || "").replace(/\[(\d+)\]/g, ".$1");
  }

  function getByPath(obj, path) {
    if (!obj || !path) return undefined;
    const normalized = normalizePath(path);
    const parts = normalized.split(".").filter(Boolean);

    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object" || !(p in cur)) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function deepCloneJsonLike(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getOrigin(input) {
    try {
      return new URL(String(input || "")).origin;
    } catch (_) {
      return "";
    }
  }

  function isCustomLinkPath(urlText) {
    try {
      const parsed = new URL(String(urlText || ""));
      const path = String(parsed.pathname || "").replace(/\/+$/, "").toLowerCase();
      return path === "/offer/custom_link";
    } catch (_) {
      return false;
    }
  }

  function shouldRetryAfterConvertError(errorMessage) {
    const text = String(errorMessage || "").toLowerCase();
    if (!text) return false;
    return (
      text.includes("failcode=")
      || text.includes("graphql trả lỗi")
      || text.includes("api không trả về afflink")
      || text.includes("http 401")
      || text.includes("http 403")
      || text.includes("http 429")
      || text.includes("http 500")
      || text.includes("http 502")
      || text.includes("http 503")
      || text.includes("http 504")
      || text.includes("network")
      || text.includes("failed to fetch")
    );
  }

  function unwrapApiPayload(rawData) {
    if (!Array.isArray(rawData)) return rawData;

    // Some Shopee responses come back as array-wrapped GraphQL payload.
    const preferred = rawData.find((item) => (
      item
      && typeof item === "object"
      && (
        Object.prototype.hasOwnProperty.call(item, "data")
        || Object.prototype.hasOwnProperty.call(item, "errors")
        || Object.prototype.hasOwnProperty.call(item, "error")
        || Object.prototype.hasOwnProperty.call(item, "batchCustomLink")
      )
    ));
    if (preferred) return preferred;
    if (rawData.length === 1 && rawData[0] && typeof rawData[0] === "object") {
      return rawData[0];
    }
    return rawData;
  }

  function extractFailCode(data) {
    const candidates = [
      getByPath(data, cfg.INTERNAL_API_FAIL_CODE_FIELD || ""),
      getByPath(data, "data.batchCustomLink[0].failCode"),
      getByPath(data, "batchCustomLink[0].failCode"),
      data && data.failCode,
      data && data.fail_code,
      data && data.code,
      data && data.errorCode,
      data && data.error_code,
      data && data.error
    ];

    for (const value of candidates) {
      if (value == null) continue;
      if (typeof value === "number") return String(value);
      if (typeof value === "string" && value.trim()) {
        const m = value.trim().match(/\b\d{6,10}\b/);
        if (m) return m[0];
      }
    }
    return "";
  }

  function withFailCodeHint(message, failCode) {
    const code = String(failCode || "").trim();
    if (!code) return message;
    if (code === "90309999") {
      return `${message} (failCode=90309999: Shopee anti-abuse/captcha, cần mở tab custom_link và xác minh rồi thử lại).`;
    }
    return `${message} (failCode=${code}).`;
  }

  function toAbsoluteUrl(raw, base) {
    const text = String(raw || "").trim();
    if (!text) return "";
    try {
      return new URL(text, base || undefined).toString();
    } catch (_) {
      return "";
    }
  }

  function normalizeAffiliateId(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    const prefixed = text.match(/^an_(\d{6,})$/i);
    if (prefixed) return prefixed[1];
    const digits = text.match(/^(\d{6,})$/);
    if (digits) return digits[1];
    return "";
  }

  function parseAffiliateParts(linkText) {
    try {
      const parsed = new URL(String(linkText || "").trim());
      return {
        affiliateId: String(parsed.searchParams.get("affiliate_id") || "").trim(),
        subId: String(parsed.searchParams.get("sub_id") || "").trim(),
        originLink: String(parsed.searchParams.get("origin_link") || "").trim(),
        baseRedirect: `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      };
    } catch (_) {
      return { affiliateId: "", subId: "", originLink: "", baseRedirect: "" };
    }
  }

  function buildAffiliateLink(baseRedirect, affiliateId, subId, originLink) {
    const base = String(baseRedirect || "").trim();
    const aid = normalizeAffiliateId(affiliateId);
    const sid = String(subId || "").trim();
    const origin = String(originLink || "").trim();
    if (!base || !aid || !sid || !origin) return "";
    return (
      `${base}?affiliate_id=${encodeURIComponent(aid)}`
      + `&sub_id=${encodeURIComponent(sid)}`
      + `&origin_link=${encodeURIComponent(origin)}`
    );
  }

  function replaceUrlPlaceholder(input, url) {
    if (typeof input === "string") return input.replaceAll("__URL__", url);
    if (Array.isArray(input)) return input.map((item) => replaceUrlPlaceholder(item, url));
    if (input && typeof input === "object") {
      const out = {};
      for (const [k, v] of Object.entries(input)) out[k] = replaceUrlPlaceholder(v, url);
      return out;
    }
    return input;
  }

  function buildRequestBody(url) {
    if (cfg.INTERNAL_API_BODY_TEMPLATE && typeof cfg.INTERNAL_API_BODY_TEMPLATE === "object") {
      const cloned = deepCloneJsonLike(cfg.INTERNAL_API_BODY_TEMPLATE);
      return replaceUrlPlaceholder(cloned, url);
    }

    const extraBody = (cfg.INTERNAL_API_EXTRA_BODY && typeof cfg.INTERNAL_API_EXTRA_BODY === "object")
      ? cfg.INTERNAL_API_EXTRA_BODY
      : {};

    return {
      ...extraBody,
      [cfg.INTERNAL_API_URL_FIELD || "url"]: url
    };
  }

  function pickAffLink(data) {
    const fields = Array.isArray(cfg.INTERNAL_API_RESULT_FIELDS) ? cfg.INTERNAL_API_RESULT_FIELDS : [];
    for (const field of fields) {
      const value = getByPath(data, field);
      if (isNonEmptyString(value)) return value.trim();
    }

    // Fallback for GraphQL batch shape with variant key names.
    const firstBatchItem = getByPath(data, "data.batchCustomLink[0]");
    if (firstBatchItem && typeof firstBatchItem === "object") {
      const priorityKeys = [
        "shortLink",
        "short_link",
        "longLink",
        "long_link",
        "trackingLink",
        "tracking_link",
        "deepLink",
        "deeplink"
      ];
      for (const key of priorityKeys) {
        const value = firstBatchItem[key];
        if (isNonEmptyString(value)) return value.trim();
      }

      // Last resort: pick any non-empty "*link*" field except originalLink.
      for (const [k, v] of Object.entries(firstBatchItem)) {
        if (!/link/i.test(k) || /^originalLink$/i.test(k)) continue;
        if (isNonEmptyString(v)) return v.trim();
      }
    }

    return null;
  }

  function pickGraphQlError(data) {
    if (!data || !Array.isArray(data.errors) || data.errors.length === 0) return "";
    const first = data.errors[0] || {};
    return first.message || "GraphQL trả lỗi.";
  }

  function validateFailCode(data) {
    const field = cfg.INTERNAL_API_FAIL_CODE_FIELD || "";
    const value = field ? getByPath(data, field) : null;
    const fallback = extractFailCode(data);
    const effective = value == null ? fallback : value;
    if (effective == null || String(effective).trim() === "") return;
    const expected = cfg.INTERNAL_API_SUCCESS_FAIL_CODE;
    if (String(effective) !== String(expected)) {
      throw new Error(withFailCodeHint(`Shopee trả failCode=${String(effective)} (kỳ vọng ${String(expected)})`, String(effective)));
    }
  }

  function parseConvertResponse(res, data) {
    const normalizedData = unwrapApiPayload(data);

    if (!res.ok) {
      const gqlError = pickGraphQlError(normalizedData);
      const rawMessage = (
        normalizedData
        && normalizedData.error != null
        && String(normalizedData.error).trim()
      )
        ? String(normalizedData.error).trim()
        : "";
      const baseMessage = rawMessage || gqlError || `API lỗi HTTP ${res.status}`;
      const failCode = extractFailCode(normalizedData);
      const debug = [];
      if (normalizedData && normalizedData.pageOrigin) debug.push(`pageOrigin=${normalizedData.pageOrigin}`);
      if (normalizedData && normalizedData.requestOrigin) debug.push(`requestOrigin=${normalizedData.requestOrigin}`);
      if (normalizedData && normalizedData.pageUrl) {
        const safeUrl = String(normalizedData.pageUrl);
        debug.push(`pageUrl=${safeUrl.slice(0, 240)}${safeUrl.length > 240 ? "..." : ""}`);
      }
      const baseWithHint = withFailCodeHint(baseMessage, failCode);
      const message = debug.length > 0 ? `${baseWithHint} (${debug.join(", ")})` : baseWithHint;
      throw new Error(message);
    }

    const gqlError = pickGraphQlError(normalizedData);
    if (gqlError) throw new Error(gqlError);

    validateFailCode(normalizedData);

    const affLink = pickAffLink(normalizedData);
    if (!affLink) {
      const debugParts = [];
      const firstBatchItem = getByPath(normalizedData, "data.batchCustomLink[0]");

      if (firstBatchItem && typeof firstBatchItem === "object") {
        try {
          const sample = JSON.stringify(firstBatchItem);
          debugParts.push(`batchItem=${sample.slice(0, 220)}${sample.length > 220 ? "..." : ""}`);
        } catch (_) {
          debugParts.push("batchItem=<unserializable>");
        }
      }

      if (normalizedData && typeof normalizedData.raw === "string") {
        const raw = normalizedData.raw.replace(/\s+/g, " ").trim();
        debugParts.push(`raw=${raw.slice(0, 220)}${raw.length > 220 ? "..." : ""}`);
      }

      if (normalizedData && typeof normalizedData === "object") {
        debugParts.push(`keys=${Object.keys(normalizedData).join(",") || "<none>"}`);
        if (normalizedData.data && typeof normalizedData.data === "object") {
          debugParts.push(`dataKeys=${Object.keys(normalizedData.data).join(",") || "<none>"}`);
        }
      }

      const failCode = extractFailCode(normalizedData);
      if (failCode) {
        debugParts.push(`failCode=${failCode}`);
      }
      const suffix = debugParts.length > 0 ? ` ${debugParts.join(" | ")}` : "";
      throw new Error(`API không trả về affLink hợp lệ.${suffix}`);
    }
    return affLink;
  }

  async function fetchJsonWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const ms = Math.max(1500, Number(timeoutMs) || 12000);
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, {
        ...(init || {}),
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  }

  async function expandAffiliateLinkContext(affiliateLink) {
    const direct = parseAffiliateParts(affiliateLink);
    if (direct.originLink || direct.subId || direct.affiliateId) {
      return { ...direct, expandedAffiliateLink: affiliateLink };
    }

    const link = toAbsoluteUrl(affiliateLink);
    if (!link) {
      return { affiliateId: "", subId: "", originLink: "", baseRedirect: "", expandedAffiliateLink: "" };
    }

    try {
      const response = await fetch(link, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        credentials: "include"
      });
      const location = toAbsoluteUrl(response.headers.get("location") || "", link);
      if (location) {
        const firstHop = parseAffiliateParts(location);
        if (firstHop.originLink || firstHop.subId || firstHop.affiliateId) {
          return { ...firstHop, expandedAffiliateLink: location };
        }
      }
    } catch (_) {}

    try {
      const response = await fetch(link, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        credentials: "include"
      });
      const finalUrl = String(response && response.url ? response.url : "").trim();
      const finalParts = parseAffiliateParts(finalUrl);
      return { ...finalParts, expandedAffiliateLink: finalUrl };
    } catch (_) {
      return { affiliateId: "", subId: "", originLink: "", baseRedirect: "", expandedAffiliateLink: "" };
    }
  }

  async function requestYtCampaignMeta(inputUrl) {
    const enabled = cfg.YT_CAMPAIGN_MAPPING_ENABLED !== false;
    const baseApi = String(cfg.YT_MAPPING_API || "").trim();
    if (!enabled || !baseApi) {
      return { affiliateId: "", subId: "", originLink: "", baseRedirect: "" };
    }

    const endpoint = (() => {
      const u = new URL(baseApi);
      u.searchParams.set("url", String(inputUrl || "").trim());
      u.searchParams.set("yt", "1");
      return u.toString();
    })();

    const { res, data } = await fetchJsonWithTimeout(
      endpoint,
      {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest"
        }
      },
      cfg.YT_MAPPING_TIMEOUT_MS
    );

    if (!res.ok || !data || data.success === false) {
      const message = (data && (data.message || data.error)) || `YT mapping API lỗi HTTP ${res.status}`;
      throw new Error(message);
    }

    const affiliateLink = String(data.affiliateLink || "").trim();
    const expanded = await expandAffiliateLinkContext(affiliateLink);

    const affiliateId = (
      normalizeAffiliateId(data.affiliate_id)
      || normalizeAffiliateId(expanded.affiliateId)
    );
    const subId = String(data.sub_id || expanded.subId || "").trim();
    const originLink = String(expanded.originLink || "").trim();
    const baseRedirect = String(expanded.baseRedirect || "https://s.shopee.vn/an_redir").trim();

    return {
      affiliateId,
      subId,
      originLink,
      baseRedirect,
      affiliateLink
    };
  }

  async function applyYtCampaignMeta(rawAffLink, inputUrl) {
    const original = String(rawAffLink || "").trim();
    if (!original) return original;

    let meta;
    try {
      meta = await requestYtCampaignMeta(inputUrl);
    } catch (err) {
      console.warn("YT mapping meta warning:", normalizeError(err, "Không đọc được campaignSubId."));
      return original;
    }

    const rawParts = parseAffiliateParts(original);
    const affiliateId = normalizeAffiliateId(meta.affiliateId || rawParts.affiliateId);
    const subId = String(meta.subId || rawParts.subId || "").trim();
    const originLink = String(rawParts.originLink || meta.originLink || "").trim();
    const baseRedirect = String(rawParts.baseRedirect || meta.baseRedirect || "https://s.shopee.vn/an_redir").trim();

    const rewritten = buildAffiliateLink(baseRedirect, affiliateId, subId, originLink);
    return rewritten || original;
  }

  async function readCookieValue(url, name) {
    if (!name) return "";
    try {
      const cookie = await chrome.cookies.get({ url, name });
      return (cookie && cookie.value) || "";
    } catch (_) {
      return "";
    }
  }

  async function buildRequestHeaders() {
    const headers = {
      "Content-Type": "application/json; charset=UTF-8"
    };

    const mode = String(cfg.INTERNAL_API_AUTH_MODE || "bearer").toLowerCase();
    if (mode === "bearer" && isNonEmptyString(cfg.INTERNAL_API_TOKEN)) {
      headers.Authorization = `Bearer ${cfg.INTERNAL_API_TOKEN}`;
    }

    if (
      mode === "cookie" &&
      isNonEmptyString(cfg.INTERNAL_API_CSRF_COOKIE_NAME) &&
      isNonEmptyString(cfg.INTERNAL_API_CSRF_HEADER_NAME)
    ) {
      const csrfValue = await readCookieValue(cfg.INTERNAL_API_URL, cfg.INTERNAL_API_CSRF_COOKIE_NAME);
      if (isNonEmptyString(csrfValue)) {
        headers[cfg.INTERNAL_API_CSRF_HEADER_NAME] = csrfValue;
      }
    }

    if (cfg.INTERNAL_API_EXTRA_HEADERS && typeof cfg.INTERNAL_API_EXTRA_HEADERS === "object") {
      Object.assign(headers, cfg.INTERNAL_API_EXTRA_HEADERS);
    }

    if (cfg.INTERNAL_API_USE_CAPTURED_HEADERS && self.ExtHeaderCache) {
      const captured = self.ExtHeaderCache.getCapturedHeaders();
      Object.assign(headers, captured);
    }

    return headers;
  }

  async function runAffiliateFetchInMainWorld(tabId, payload) {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [payload],
      func: async (input) => {
        function getOrigin(value) {
          try {
            return new URL(String(value || ""), location.href).origin;
          } catch (_) {
            return "";
          }
        }

        function readCookie(name) {
          if (!name) return "";
          const key = `${name}=`;
          const parts = document.cookie.split(";");
          for (const p of parts) {
            const x = p.trim();
            if (x.startsWith(key)) return decodeURIComponent(x.slice(key.length));
          }
          return "";
        }

        function withUrlPlaceholder(value, url) {
          if (typeof value === "string") return value.replaceAll("__URL__", url);
          if (Array.isArray(value)) return value.map((item) => withUrlPlaceholder(item, url));
          if (value && typeof value === "object") {
            const out = {};
            for (const [k, v] of Object.entries(value)) out[k] = withUrlPlaceholder(v, url);
            return out;
          }
          return value;
        }

        function buildBody(url, payload) {
          const tpl = payload && payload.bodyTemplate;
          if (tpl && typeof tpl === "object") {
            return withUrlPlaceholder(JSON.parse(JSON.stringify(tpl)), url);
          }

          const field = (payload && payload.urlField) || "url";
          const extra = (payload && payload.extraBody && typeof payload.extraBody === "object")
            ? payload.extraBody
            : {};
          return {
            ...extra,
            [field]: url
          };
        }

        let pageOrigin = location.origin;
        let requestOrigin = "";

        try {
          const url = String((input && input.url) || "").trim();
          if (!url) return { ok: false, error: "Thiếu URL convert." };
          requestOrigin = getOrigin(input && input.requestUrl);
          pageOrigin = location.origin;
          const isCaptchaPage = /\/verify\/(captcha|traffic)/i.test(location.pathname);

          if (!requestOrigin) {
            return {
              ok: false,
              status: 0,
              error: "INTERNAL_API_URL không hợp lệ.",
              data: {
                pageOrigin,
                requestOrigin,
                pageUrl: location.href
              }
            };
          }

          if (pageOrigin !== requestOrigin) {
            return {
              ok: false,
              status: 0,
              error: isCaptchaPage
                ? "Shopee yêu cầu xác minh captcha. Hãy mở tab worker, hoàn thành xác minh rồi thử lại."
                : "Tab worker không ở đúng domain affiliate. Hãy mở lại trang custom link rồi thử lại.",
              data: {
                pageOrigin,
                requestOrigin,
                pageUrl: location.href
              }
            };
          }

          const headers = {
            "content-type": "application/json; charset=UTF-8"
          };
          if (input && input.extraHeaders && typeof input.extraHeaders === "object") {
            Object.assign(headers, input.extraHeaders);
          }

          if (input && input.csrfCookieName && input.csrfHeaderName) {
            const csrf = readCookie(input.csrfCookieName);
            if (csrf) headers[input.csrfHeaderName] = csrf;
          }

          const requestInit = {
            method: String((input && input.method) || "POST").toUpperCase(),
            credentials: "include",
            headers,
            body: JSON.stringify(buildBody(url, input)),
            cache: "no-store",
            referrer: (input && input.referrer) || location.href,
            referrerPolicy: (input && input.referrerPolicy) || "strict-origin-when-cross-origin"
          };

          const res = await fetch(input.requestUrl, requestInit);
          const text = await res.text();

          let data = null;
          if (text) {
            try {
              data = JSON.parse(text);
            } catch (_) {
              data = { raw: text };
            }
          }

          if (!res.ok) {
            return {
              ok: false,
              status: res.status,
              error: (data && (data.error || data.message)) || `HTTP ${res.status}`,
              data: data || {}
            };
          }

          return {
            ok: true,
            status: res.status,
            data: data || {}
          };
        } catch (err) {
          return {
            ok: false,
            status: 0,
            error: (err && err.message) || "Main-world fetch failed.",
            data: {
              pageOrigin,
              requestOrigin,
              pageUrl: location.href
            }
          };
        }
      }
    });

    if (!Array.isArray(injected) || injected.length === 0) {
      throw new Error("Không chạy được script trong tab affiliate.");
    }

    return injected[0].result || { ok: false, error: "Không nhận được kết quả từ tab affiliate." };
  }

  async function waitTabComplete(tabId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.status === "complete") return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function ensureAffiliateTab(options) {
    const opts = (options && typeof options === "object") ? options : {};
    const forceNavigate = Boolean(opts.forceNavigate);
    const urls = Array.isArray(cfg.INTERNAL_API_TAB_MATCH_URLS)
      ? cfg.INTERNAL_API_TAB_MATCH_URLS
      : ["https://affiliate.shopee.vn/*"];
    const targetOrigin = getOrigin(cfg.INTERNAL_API_URL);
    const openUrl = cfg.INTERNAL_API_TAB_OPEN_URL || "https://affiliate.shopee.vn/offer/custom_link";

    const tabs = await chrome.tabs.query({ url: urls });
    if (tabs && tabs.length > 0) {
      let tab = tabs.find((t) => getOrigin(t && t.url) === targetOrigin) || tabs[0];
      if (tab && tab.id) {
        const currentOrigin = getOrigin(tab.url);
        const needNavigateToWorkerPage = !isCustomLinkPath(tab.url) || forceNavigate;
        if (
          (targetOrigin && currentOrigin && currentOrigin !== targetOrigin)
          || needNavigateToWorkerPage
        ) {
          tab = await chrome.tabs.update(tab.id, { url: openUrl });
        }
        await waitTabComplete(tab.id, 12000).catch(() => {});
      }
      return tab;
    }

    if (!cfg.INTERNAL_API_AUTO_OPEN_AFFILIATE_TAB) {
      throw new Error("Chưa có tab Shopee Affiliate. Hãy mở https://affiliate.shopee.vn/offer/custom_link trước.");
    }

    const tab = await chrome.tabs.create({
      url: openUrl,
      active: false
    });

    await waitTabComplete(tab.id, 12000).catch(() => {});
    return tab;
  }

  async function convertViaAffiliateTab(url, options) {
    const opts = (options && typeof options === "object") ? options : {};
    const includeCapturedHeaders = opts.includeCapturedHeaders !== false;
    const tab = await ensureAffiliateTab({ forceNavigate: Boolean(opts.forceNavigate) });
    if (!tab || !tab.id) {
      throw new Error("Không tìm thấy tab Shopee Affiliate hợp lệ.");
    }

    const capturedHeaders = (
      includeCapturedHeaders
      && cfg.INTERNAL_API_USE_CAPTURED_HEADERS
      && self.ExtHeaderCache
    )
      ? self.ExtHeaderCache.getCapturedHeaders()
      : {};

    const payload = {
      url,
      requestUrl: cfg.INTERNAL_API_URL,
      method: cfg.INTERNAL_API_METHOD,
      bodyTemplate: cfg.INTERNAL_API_BODY_TEMPLATE,
      urlField: cfg.INTERNAL_API_URL_FIELD,
      extraBody: cfg.INTERNAL_API_EXTRA_BODY,
      extraHeaders: {
        ...(cfg.INTERNAL_API_EXTRA_HEADERS || {}),
        ...capturedHeaders
      },
      csrfCookieName: cfg.INTERNAL_API_CSRF_COOKIE_NAME,
      csrfHeaderName: cfg.INTERNAL_API_CSRF_HEADER_NAME,
      referrer: cfg.INTERNAL_API_REFERRER,
      referrerPolicy: cfg.INTERNAL_API_REFERRER_POLICY
    };

    const res = await runAffiliateFetchInMainWorld(tab.id, payload);
    const data = (res && res.data && typeof res.data === "object") ? { ...res.data } : {};
    if (res && res.error && !data.error) data.error = res.error;

    return parseConvertResponse(
      { ok: Boolean(res && res.ok), status: (res && res.status) || 0 },
      data
    );
  }

  async function convertViaServiceWorkerFetch(url) {
    const headers = await buildRequestHeaders();
    const requestBody = buildRequestBody(url);

    const mode = String(cfg.INTERNAL_API_AUTH_MODE || "bearer").toLowerCase();
    const fetchOpts = {
      method: (cfg.INTERNAL_API_METHOD || "POST").toUpperCase(),
      headers,
      credentials: (mode === "cookie" && cfg.INTERNAL_API_WITH_CREDENTIALS) ? "include" : "omit",
      body: JSON.stringify(requestBody),
      cache: "no-store"
    };

    if (isNonEmptyString(cfg.INTERNAL_API_REFERRER)) fetchOpts.referrer = cfg.INTERNAL_API_REFERRER;
    if (isNonEmptyString(cfg.INTERNAL_API_REFERRER_POLICY)) fetchOpts.referrerPolicy = cfg.INTERNAL_API_REFERRER_POLICY;

    const res = await fetch(cfg.INTERNAL_API_URL, fetchOpts);
    const data = await res.json().catch(() => null);
    return parseConvertResponse(res, data || {});
  }

  async function convertByInternalApi(url, options) {
    if (!url || typeof url !== "string") {
      throw new Error("Thiếu URL cần convert.");
    }
    const opts = (options && typeof options === "object") ? options : {};
    const source = String(opts.source || "fb").toLowerCase() === "yt" ? "yt" : "fb";

    const mode = String(cfg.INTERNAL_API_AUTH_MODE || "bearer").toLowerCase();
    const cookieSource = String(cfg.INTERNAL_API_COOKIE_SOURCE || "service_worker").toLowerCase();
    const route = (mode === "cookie" && cookieSource === "affiliate_tab")
      ? "cookie/affiliate_tab"
      : `${mode}/service_worker`;

    if (mode === "cookie" && cookieSource === "affiliate_tab") {
      try {
        const affiliateLink = await convertViaAffiliateTab(url, {
          forceNavigate: false,
          includeCapturedHeaders: true
        });
        if (source === "yt") {
          return await applyYtCampaignMeta(affiliateLink, url);
        }
        return affiliateLink;
      } catch (firstErr) {
        const firstMessage = normalizeError(firstErr, "Không convert được link.");
        if (!shouldRetryAfterConvertError(firstMessage)) {
          throw new Error(`[${route}] ${firstMessage}`);
        }

        // Retry 1 lần: ép về trang worker chuẩn + bỏ captured headers cũ (có thể đã stale).
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const retriedAffiliateLink = await convertViaAffiliateTab(url, {
            forceNavigate: true,
            includeCapturedHeaders: false
          });
          if (source === "yt") {
            return await applyYtCampaignMeta(retriedAffiliateLink, url);
          }
          return retriedAffiliateLink;
        } catch (secondErr) {
          const secondMessage = normalizeError(secondErr, "Không convert được link.");
          throw new Error(`[${route}] ${firstMessage} | retry: ${secondMessage}`);
        }
      }
    }

    try {
      const affiliateLink = await convertViaServiceWorkerFetch(url);
      if (source === "yt") {
        return await applyYtCampaignMeta(affiliateLink, url);
      }
      return affiliateLink;
    } catch (err) {
      const msg = normalizeError(err, "Không convert được link.");
      throw new Error(`[${route}] ${msg}`);
    }
  }

  self.ExtInternalApi = {
    normalizeError,
    convertByInternalApi
  };
})(self);
