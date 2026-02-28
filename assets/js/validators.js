(function (window) {
  const cfg = window.ShopeeConfig;
  const MAX_REDIRECT_DEPTH = 2;

  function normalizeHost(host) {
    return String(host || "").trim().toLowerCase().replace(/\.+$/, "");
  }

  function isShopeeMarketHost(host) {
    return /(^|\.)shopee\.[a-z.]+$/i.test(host);
  }

  function isShortShopeeHost(host) {
    if (host === "shope.ee" || host === "shp.ee") return true;
    if (/^[a-z0-9-]+\.shp\.ee$/i.test(host)) return true;
    if (/^s\.shopee\.[a-z.]+$/i.test(host)) return true;
    return false;
  }

  function isAffiliateRedirectPath(pathname) {
    const path = String(pathname || "/");
    return path.replace(/\/+$/, "").toLowerCase() === "/an_redir";
  }

  function isDirectProductPath(pathname) {
    const path = String(pathname || "/");
    if (/-i\.(\d+)\.(\d+)\/?$/i.test(path)) return true;
    if (/^\/product\/(\d+)\/(\d+)\/?$/i.test(path)) return true;
    if (/^\/universal-link\/product\/(\d+)\/(\d+)\/?$/i.test(path)) return true;
    return false;
  }

  function parsePossiblyEncodedHttpUrl(raw) {
    let candidate = String(raw || "").trim();
    if (!candidate) return null;

    for (let i = 0; i <= MAX_REDIRECT_DEPTH; i += 1) {
      try {
        const parsed = new URL(candidate);
        if (/^https?:$/i.test(parsed.protocol)) {
          return parsed;
        }
      } catch (_) {}

      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) break;
        candidate = decoded;
      } catch (_) {
        break;
      }
    }

    return null;
  }

  function getOriginLinkParam(parsed) {
    if (!parsed || !parsed.searchParams) return "";
    for (const [key, value] of parsed.searchParams.entries()) {
      if (String(key).toLowerCase() === "origin_link") {
        return String(value || "").trim();
      }
    }
    return "";
  }

  function validateShopeeProductUrl(parsed, depth) {
    if (!parsed || depth > MAX_REDIRECT_DEPTH) return null;

    const host = normalizeHost(parsed.hostname);
    const path = parsed.pathname || "/";

    if (isShortShopeeHost(host)) {
      if (isAffiliateRedirectPath(path)) {
        const originLinkRaw = getOriginLinkParam(parsed);
        const originParsed = parsePossiblyEncodedHttpUrl(originLinkRaw);
        if (!originParsed) return null;
        return validateShopeeProductUrl(originParsed, depth + 1);
      }

      const token = path.replace(/^\/+/, "").split("/")[0];
      if (token) return parsed;
      return null;
    }

    if (isShopeeMarketHost(host)) {
      if (isDirectProductPath(path)) return parsed;

      if (isAffiliateRedirectPath(path)) {
        const originLinkRaw = getOriginLinkParam(parsed);
        const originParsed = parsePossiblyEncodedHttpUrl(originLinkRaw);
        if (!originParsed) return null;
        return validateShopeeProductUrl(originParsed, depth + 1);
      }
      return null;
    }

    return null;
  }

  function extractUrls(text) {
    const rx = new RegExp(cfg.URL_REGEX.source, "gi");
    return (text || "").match(rx) || [];
  }

  function normalizeSingleShopeeLink(raw) {
    const value = String(raw || "").trim();
    if (!value) throw new Error("Bạn chưa nhập link.");

    const urls = extractUrls(value);
    if (urls.length === 0) throw new Error("Vui lòng dán link đầy đủ bắt đầu bằng http/https.");
    if (urls.length > 1) throw new Error("Chỉ cho phép 1 link mỗi lần convert.");

    const urlText = urls[0].trim();
    if (value !== urlText) {
      throw new Error("Chỉ dán đúng 1 link, không kèm nhiều link hoặc nội dung khác.");
    }

    let parsed;
    try {
      parsed = new URL(urlText);
    } catch (_) {
      throw new Error("Link không hợp lệ.");
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error("Vui lòng dùng link http/https.");
    }

    const normalizedProductUrl = validateShopeeProductUrl(parsed, 0);
    if (!normalizedProductUrl) {
      throw new Error("Chỉ hỗ trợ link sản phẩm Shopee hợp lệ.");
    }

    return normalizedProductUrl.toString();
  }

  window.ShopeeValidators = {
    normalizeSingleShopeeLink
  };
})(window);
