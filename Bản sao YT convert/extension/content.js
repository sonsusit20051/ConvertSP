function detectAffiliateId() {
  const patterns = [
    /(?:affiliate[_\s-]?id|publisher[_\s-]?id)\D{0,20}(\d{6,})/i,
    /"affiliate_id"\s*:\s*"?(\d{6,})"?/i,
  ];

  const sources = [
    document.body?.innerText || "",
    document.documentElement?.outerHTML || "",
  ];

  for (const source of sources) {
    for (const p of patterns) {
      const m = source.match(p);
      if (m?.[1]) {
        return m[1];
      }
    }
  }

  return "";
}

const YT_MAPPING_API = "https://yt.shpee.cc/";

function normalizeInputUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("Thiếu URL cần tạo mapping.");
  }
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  const parsed = new URL(withProtocol);
  return parsed.toString();
}

async function createYoutubeMapping(rawUrl) {
  const inputUrl = normalizeInputUrl(rawUrl);
  const endpoint = `${YT_MAPPING_API}?url=${encodeURIComponent(inputUrl)}&yt=1`;
  const response = await fetch(endpoint, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.message || `YT mapping API lỗi HTTP ${response.status}`);
  }

  return {
    source: "affiliate-tab",
    affiliateLink: String(payload.affiliateLink || "").trim(),
    affiliateId: String(payload.affiliate_id || "").trim(),
    subId: String(payload.sub_id || "").trim(),
    mode: String(payload.mode || "yt"),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DETECT_AFFILIATE_ID") {
    sendResponse({ affiliateId: detectAffiliateId() });
    return;
  }

  if (message?.type === "CREATE_YT_MAPPING") {
    (async () => {
      const meta = await createYoutubeMapping(message?.url || "");
      sendResponse({ ok: true, meta });
    })().catch((error) => {
      sendResponse({ ok: false, message: error?.message || "Không tạo được YT mapping từ tab affiliate." });
    });
    return true;
  }
});
