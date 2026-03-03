const URL_CANDIDATE_PATTERN =
  "((?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(?:shopee\\.[a-z.]{2,}|shope\\.ee|shp\\.ee)(?:\\/[^\\s<>\"']*)?)";
const URL_CANDIDATE_REGEX = new RegExp(URL_CANDIDATE_PATTERN, "i");
const URL_CANDIDATE_REGEX_GLOBAL = new RegExp(URL_CANDIDATE_PATTERN, "gi");

function trimTrailingPunctuation(text) {
  return text.replace(/[),.;!?\]\s]+$/g, "");
}

function ensureProtocol(text) {
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  return `https://${text}`;
}

export function extractFirstLink(rawText) {
  if (!rawText) {
    return "";
  }

  const match = rawText.match(URL_CANDIDATE_REGEX);
  if (!match) {
    return "";
  }

  return trimTrailingPunctuation(match[0]);
}

export function extractLinkCandidates(rawText) {
  if (!rawText) {
    return [];
  }

  const matches = rawText.match(URL_CANDIDATE_REGEX_GLOBAL) || [];
  return matches.map(trimTrailingPunctuation).filter(Boolean);
}

export function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();

  if (host === "shope.ee") {
    return true;
  }

  if (/^([a-z0-9-]+\.)*shp\.ee$/i.test(host)) {
    return true;
  }

  if (/^([a-z0-9-]+\.)*shopee\.[a-z.]{2,}$/i.test(host)) {
    return true;
  }

  return false;
}

export function isShortLinkHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "shope.ee" || host === "shp.ee" || host.endsWith(".shp.ee") || host.startsWith("s.shopee.");
}

export function isShopeeLandingHost(hostname) {
  return /^([a-z0-9-]+\.)*shopee\.[a-z.]{2,}$/i.test(hostname.toLowerCase());
}

export function isSupportedShopeePath(urlObj) {
  const host = String(urlObj?.hostname || "").toLowerCase();
  const path = String(urlObj?.pathname || "/");

  if (isShortLinkHost(host)) {
    return path && path !== "/" && path.length > 1;
  }

  if (!isShopeeLandingHost(host)) {
    return false;
  }

  const patterns = [
    /^\/product\/\d+\/\d+\/?$/i,
    /^\/.+-i\.\d+\.\d+\/?$/i,
    /^\/shop\/\d+\/?$/i,
    /^\/[^/?#]+\/?$/i,
    /^\/.+-cat\.\d+\/?$/i,
    /^\/search\/?$/i,
    /^\/m\/voucher(?:-shop)?(?:\/[^/?#]+)?\/?$/i,
    /^\/m\/[^/?#]+\/?$/i,
    /^\/flash_sale\/?$/i,
    /^\/cart\/?$/i,
  ];

  return patterns.some((pattern) => pattern.test(path));
}

export function parseAndValidateInput(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Vui lòng dán link Shopee trước khi tạo link.",
    };
  }

  const candidates = extractLinkCandidates(trimmed);
  if (candidates.length > 1) {
    return {
      ok: false,
      error: "Vui lòng chỉ dán 1 link Shopee mỗi lần.",
    };
  }

  const extracted = candidates[0] || "";
  if (!extracted) {
    return {
      ok: false,
      error: "Không tìm thấy link Shopee hợp lệ trong nội dung bạn dán.",
    };
  }

  let parsed;
  try {
    parsed = new URL(ensureProtocol(extracted));
  } catch {
    return {
      ok: false,
      error: "Link không đúng định dạng URL.",
    };
  }

  if (!isAllowedHost(parsed.hostname)) {
    return {
      ok: false,
      error:
        "Domain không được hỗ trợ. Chỉ chấp nhận *.shopee.*, s.shopee.*, shope.ee và *.shp.ee.",
    };
  }

  if (!isSupportedShopeePath(parsed)) {
    return {
      ok: false,
      error:
        "Định dạng link chưa hỗ trợ. Hãy dùng link sản phẩm, shop, category, search, voucher, flash sale, cart hoặc shortlink Shopee.",
    };
  }

  parsed.hash = "";

  return {
    ok: true,
    url: parsed,
    extracted,
  };
}
