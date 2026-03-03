const ALLOWED_QUERY_KEYS = new Set(["gads_t_sig"]);
const AFFILIATE_TAB_URL = "https://affiliate.shopee.vn/*";
const YT_MAPPING_API = "https://yt.shpee.cc/";
const TAB_RPC_TIMEOUT_MS = 15000;
const POLL_FAST_SEC = 0.18;
const POLL_NORMAL_SEC = 0.35;
const POLL_SLOW_SEC = 0.8;

const defaults = {
  enabled: true,
  serverBaseUrl: "http://localhost:8787",
  workerToken: "dev-worker-token",
  workerId: `ext-${crypto.randomUUID().slice(0, 8)}`,
  workerName: "chrome-worker",
  affiliateId: "17391540096",
  subId: "YT3",
  baseRedirect: "https://s.shopee.vn/an_redir",
};

const runtimeState = {
  polling: false,
  lastPollAt: 0,
  lastSuccessAt: 0,
  lastError: "",
  lastJobId: "",
  lastJobStatus: "idle",
  lastHealthAt: 0,
  serverOnline: null,
  queueSize: null,
  workersOnline: null,
  workersTotal: null,
  nextPollSec: POLL_NORMAL_SEC,
};

async function getSettings() {
  const stored = await chrome.storage.local.get(defaults);
  return { ...defaults, ...stored };
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

function normalizeBaseUrl(base) {
  return String(base || "").replace(/\/$/, "");
}

function parseAffiliateParts(linkText) {
  try {
    const parsed = new URL(String(linkText || ""));
    return {
      affiliateId: String(parsed.searchParams.get("affiliate_id") || "").trim(),
      subId: String(parsed.searchParams.get("sub_id") || "").trim(),
      originLink: String(parsed.searchParams.get("origin_link") || "").trim(),
    };
  } catch {
    return { affiliateId: "", subId: "", originLink: "" };
  }
}

function toAbsoluteUrl(raw, base = "") {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }
  try {
    return new URL(text, base || undefined).toString();
  } catch {
    return "";
  }
}

function isShortlinkHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "shope.ee" || host === "shp.ee" || host.endsWith(".shp.ee") || host.startsWith("s.shopee.");
}

function isShopeeHost(hostname) {
  return /^([a-z0-9-]+\.)*shopee\.[a-z.]{2,}$/i.test(String(hostname || "").toLowerCase());
}

function hasGadsSig(urlObj) {
  return Boolean(urlObj.searchParams.get("gads_t_sig"));
}

function extractProductIds(pathname) {
  const path = String(pathname || "");
  const slugMatch = path.match(/-i\.(\d+)\.(\d+)(?:\/)?$/i);
  if (slugMatch?.[1] && slugMatch?.[2]) {
    return { shopId: slugMatch[1], itemId: slugMatch[2] };
  }

  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const itemId = parts[parts.length - 1];
    const shopId = parts[parts.length - 2];
    if (/^\d+$/.test(shopId) && /^\d+$/.test(itemId)) {
      return { shopId, itemId };
    }
  }

  return null;
}

function cleanLandingUrl(urlObj) {
  const ids = extractProductIds(urlObj.pathname);
  if (!ids) {
    throw new Error("Không trích xuất được shop_id/item_id để chuẩn hóa path /product.");
  }

  const cleaned = new URL(urlObj.toString());
  cleaned.hash = "";
  cleaned.protocol = "https:";
  cleaned.pathname = `/product/${ids.shopId}/${ids.itemId}`;

  const next = new URLSearchParams();
  cleaned.searchParams.forEach((value, key) => {
    if (ALLOWED_QUERY_KEYS.has(key.toLowerCase())) {
      next.append(key, value);
    }
  });

  const q = next.toString();
  cleaned.search = q ? `?${q}` : "";
  return cleaned.toString();
}

function buildAffiliateLink(cleanUrl, settings, affiliateId) {
  const origin = encodeURIComponent(cleanUrl);
  const aid = encodeURIComponent(String(affiliateId || ""));
  const sid = encodeURIComponent(String(settings.subId || "YT3"));
  return `${settings.baseRedirect}?affiliate_id=${aid}&sub_id=${sid}&origin_link=${origin}`;
}

async function findAffiliateTab() {
  const tabs = await chrome.tabs.query({ url: AFFILIATE_TAB_URL });
  if (!tabs.length) {
    return null;
  }
  return tabs.find((tab) => tab.active) || tabs[0] || null;
}

function sendMessageToTab(tabId, message, timeoutMs = TAB_RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Tab affiliate phản hồi quá chậm."));
    }, Math.max(timeoutMs, 1500));

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response || {});
    });
  });
}

async function requestCampaignMetaDirect(inputUrl) {
  const endpoint = `${YT_MAPPING_API}?url=${encodeURIComponent(String(inputUrl || ""))}&yt=1`;
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

  const affiliateLink = String(payload.affiliateLink || "").trim();
  const parsed = parseAffiliateParts(affiliateLink);
  return {
    source: "yt-api-direct",
    affiliateLink,
    affiliateId: String(payload.affiliate_id || parsed.affiliateId || "").trim(),
    subId: String(payload.sub_id || parsed.subId || "").trim(),
  };
}

async function requestCampaignMetaViaAffiliateTab(inputUrl) {
  const tab = await findAffiliateTab();
  if (!tab?.id) {
    throw new Error("Không tìm thấy tab affiliate.shopee.vn. Hãy mở tab và đăng nhập.");
  }

  const response = await sendMessageToTab(tab.id, { type: "CREATE_YT_MAPPING", url: inputUrl });
  if (!response?.ok) {
    throw new Error(response?.message || "Tab affiliate không tạo được mapping YT.");
  }

  const meta = response.meta || {};
  const affiliateLink = String(meta.affiliateLink || "").trim();
  const parsed = parseAffiliateParts(affiliateLink);
  return {
    source: String(meta.source || "affiliate-tab"),
    affiliateLink,
    affiliateId: String(meta.affiliateId || parsed.affiliateId || "").trim(),
    subId: String(meta.subId || parsed.subId || "").trim(),
  };
}

async function expandAffiliateLinkContext(affiliateLink) {
  const directParts = parseAffiliateParts(affiliateLink);
  if (directParts.originLink) {
    return {
      expandedAffiliateLink: affiliateLink,
      ...directParts,
    };
  }

  const link = toAbsoluteUrl(affiliateLink);
  if (!link) {
    return { expandedAffiliateLink: "", affiliateId: "", subId: "", originLink: "" };
  }

  // Try to read first redirect hop (often shp.today -> s.shopee.vn/an_redir?...).
  try {
    const response = await fetch(link, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "include",
    });

    const location = toAbsoluteUrl(response.headers.get("location") || "", link);
    if (location) {
      const parts = parseAffiliateParts(location);
      if (parts.originLink || parts.subId || parts.affiliateId) {
        return {
          expandedAffiliateLink: location,
          ...parts,
        };
      }
    }
  } catch {
    // Fallback below.
  }

  // Fallback: follow redirects and parse the final URL if possible.
  try {
    const response = await fetch(link, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      credentials: "include",
    });
    const finalUrl = String(response?.url || "").trim();
    const parts = parseAffiliateParts(finalUrl);
    return {
      expandedAffiliateLink: finalUrl,
      ...parts,
    };
  } catch {
    return { expandedAffiliateLink: "", affiliateId: "", subId: "", originLink: "" };
  }
}

async function requestCampaignMeta(inputUrl) {
  try {
    const base = await requestCampaignMetaViaAffiliateTab(inputUrl);
    const expanded = await expandAffiliateLinkContext(base.affiliateLink);
    return {
      ...base,
      affiliateId: base.affiliateId || expanded.affiliateId || "",
      subId: base.subId || expanded.subId || "",
      originLink: expanded.originLink || "",
      expandedAffiliateLink: expanded.expandedAffiliateLink || "",
    };
  } catch (tabError) {
    const fallback = await requestCampaignMetaDirect(inputUrl);
    const expanded = await expandAffiliateLinkContext(fallback.affiliateLink);
    return {
      ...fallback,
      affiliateId: fallback.affiliateId || expanded.affiliateId || "",
      subId: fallback.subId || expanded.subId || "",
      originLink: expanded.originLink || "",
      expandedAffiliateLink: expanded.expandedAffiliateLink || "",
      fallbackFrom: tabError?.message || "",
    };
  }
}

async function detectAffiliateIdFromTabs() {
  const tabs = await chrome.tabs.query({ url: "https://affiliate.shopee.vn/*" });

  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }

    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "DETECT_AFFILIATE_ID" });
      if (result?.affiliateId) {
        return String(result.affiliateId);
      }
    } catch {
      // Tab may not have content script ready.
    }
  }

  return "";
}

async function getAffiliateId(settings) {
  const detected = await detectAffiliateIdFromTabs();
  if (detected) {
    await saveSettings({ affiliateId: detected });
    return detected;
  }

  if (String(settings.affiliateId || "").trim()) {
    return String(settings.affiliateId);
  }

  const fallback = String(defaults.affiliateId || "").trim();
  if (fallback) {
    await saveSettings({ affiliateId: fallback });
    return fallback;
  }

  throw new Error(
    "Không tìm thấy affiliate id. Hãy mở tab affiliate.shopee.vn và đăng nhập, hoặc nhập tay trong Options."
  );
}

async function resolveLanding(inputUrl) {
  const parsed = new URL(inputUrl);
  if (!isShortlinkHost(parsed.hostname)) {
    return parsed;
  }

  const response = await fetch(parsed.toString(), {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    credentials: "include",
  });

  if (!response?.url) {
    throw new Error("Không resolve được shortlink.");
  }

  return new URL(response.url);
}

async function convertJob(job, settings) {
  const sourceUrl = String(job.url || "").trim();
  const campaignMeta = await requestCampaignMeta(sourceUrl);
  const mappedOrigin = String(campaignMeta.originLink || "").trim();
  const landingInput = mappedOrigin || sourceUrl;
  const landingUrl = await resolveLanding(landingInput);
  if (!isShopeeHost(landingUrl.hostname)) {
    throw new Error("URL đích không thuộc domain Shopee.");
  }

  let cleanUrl = "";
  if (hasGadsSig(landingUrl)) {
    try {
      cleanUrl = cleanLandingUrl(landingUrl);
    } catch {
      cleanUrl = "";
    }
  }

  const workerAffiliateId = await getAffiliateId(settings);
  const affiliateId =
    String(workerAffiliateId || "").trim() ||
    String(campaignMeta.affiliateId || "").trim() ||
    String(settings.affiliateId || "").trim();
  const campaignSubId = String(campaignMeta.subId || "").trim();
  const subId = campaignSubId || String(settings.subId || "YT3").trim() || "YT3";
  let affiliateLink = "";
  if (cleanUrl) {
    affiliateLink = buildAffiliateLink(cleanUrl, { ...settings, subId }, affiliateId);
  } else {
    affiliateLink =
      String(campaignMeta.expandedAffiliateLink || "").trim() ||
      String(campaignMeta.affiliateLink || "").trim();
  }
  if (!affiliateLink) {
    throw new Error("Không tạo được affiliate link từ campaign context.");
  }

  return {
    affiliateLink,
    landingUrl: landingUrl.toString(),
    cleanLandingUrl: cleanUrl,
    campaignAffiliateId: String(campaignMeta.affiliateId || "").trim(),
    campaignSubId: subId,
    campaignSource: String(campaignMeta.source || ""),
    campaignRawAffiliateLink: String(campaignMeta.affiliateLink || ""),
  };
}

async function postWorker(path, payload, settings) {
  const base = normalizeBaseUrl(settings.serverBaseUrl);
  if (!base) {
    throw new Error("Thiếu serverBaseUrl trong options.");
  }

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Worker-Token": settings.workerToken,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.message || `HTTP ${response.status}`);
  }

  return data;
}

async function fetchHealth(settings, timeoutMs = 2500) {
  const base = normalizeBaseUrl(settings.serverBaseUrl);
  if (!base) {
    throw new Error("Thiếu serverBaseUrl trong options.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/api/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || `HTTP ${response.status}`);
    }

    runtimeState.serverOnline = true;
    runtimeState.queueSize = Number.isFinite(payload.queueSize) ? payload.queueSize : null;
    runtimeState.workersOnline = Number.isFinite(payload?.workers?.online)
      ? payload.workers.online
      : null;
    runtimeState.workersTotal = Number.isFinite(payload?.workers?.total)
      ? payload.workers.total
      : null;
    runtimeState.lastHealthAt = Date.now();
  } catch (error) {
    runtimeState.serverOnline = false;
    runtimeState.lastHealthAt = Date.now();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function scheduleNextPoll(seconds = POLL_NORMAL_SEC) {
  const delayMs = Math.max(seconds * 1000, 180);
  chrome.alarms.create("queuePollOnce", { when: Date.now() + delayMs });
}

async function pollOnce({ forceHealth = false } = {}) {
  if (runtimeState.polling) {
    return;
  }

  runtimeState.polling = true;
  runtimeState.lastPollAt = Date.now();

  try {
    const settings = await getSettings();
    let runtimeAffiliateId = String(settings.affiliateId || "").trim();
    try {
      const detected = await getAffiliateId(settings);
      if (detected) {
        runtimeAffiliateId = detected;
      }
    } catch {
      // Keep configured affiliate id if detect failed.
    }

    if (!settings.enabled) {
      runtimeState.lastJobStatus = "disabled";
      runtimeState.lastError = "";
      runtimeState.nextPollSec = POLL_SLOW_SEC;
      if (forceHealth || Date.now() - runtimeState.lastHealthAt > 8000) {
        try {
          await fetchHealth(settings);
        } catch {
          // ignore health error while disabled
        }
      }
      return;
    }

    if (forceHealth || Date.now() - runtimeState.lastHealthAt > 8000) {
      try {
        await fetchHealth(settings);
      } catch {
        // continue to poll endpoint for better signal
      }
    }

    const polled = await postWorker(
      "/worker/poll",
      {
        workerId: settings.workerId,
        workerName: settings.workerName,
        affiliateId: runtimeAffiliateId,
        subId: settings.subId,
      },
      settings
    );

    runtimeState.serverOnline = true;
    runtimeState.lastError = "";
    runtimeState.lastPollAt = Date.now();

    if (polled.workerId && polled.workerId !== settings.workerId) {
      await saveSettings({ workerId: polled.workerId });
    }

    if (!polled.job) {
      runtimeState.lastJobStatus = "idle";
      runtimeState.nextPollSec = POLL_NORMAL_SEC;
      return;
    }

    runtimeState.lastJobId = polled.job.id || "";
    runtimeState.lastJobStatus = "processing";

    try {
      const result = await convertJob(polled.job, settings);
      await postWorker(
        "/worker/submit",
        {
          workerId: polled.workerId || settings.workerId,
          jobId: polled.job.id,
          success: true,
          ...result,
        },
        settings
      );
      runtimeState.lastJobStatus = "success";
      runtimeState.lastSuccessAt = Date.now();
      runtimeState.lastError = "";
      runtimeState.nextPollSec = POLL_FAST_SEC;
    } catch (err) {
      await postWorker(
        "/worker/submit",
        {
          workerId: polled.workerId || settings.workerId,
          jobId: polled.job.id,
          success: false,
          message: err?.message || "Extension convert failed.",
        },
        settings
      );
      runtimeState.lastJobStatus = "error";
      runtimeState.lastError = err?.message || "Extension convert failed.";
      runtimeState.nextPollSec = POLL_NORMAL_SEC;
    }
  } catch (error) {
    runtimeState.serverOnline = false;
    runtimeState.lastError = error?.message || "Worker poll failed.";
    runtimeState.nextPollSec = POLL_SLOW_SEC;
  } finally {
    runtimeState.polling = false;
  }
}

async function getStatusPayload({ forceHealth = false } = {}) {
  const settings = await getSettings();

  if (forceHealth || Date.now() - runtimeState.lastHealthAt > 5000) {
    try {
      await fetchHealth(settings);
    } catch {
      // keep runtimeState error markers
    }
  }

  return {
    enabled: Boolean(settings.enabled),
    polling: Boolean(runtimeState.polling),
    lastPollAt: runtimeState.lastPollAt,
    lastSuccessAt: runtimeState.lastSuccessAt,
    lastError: runtimeState.lastError,
    lastJobId: runtimeState.lastJobId,
    lastJobStatus: runtimeState.lastJobStatus,
    serverOnline: runtimeState.serverOnline,
    queueSize: runtimeState.queueSize,
    workers: {
      online: runtimeState.workersOnline,
      total: runtimeState.workersTotal,
    },
    worker: {
      id: settings.workerId,
      name: settings.workerName,
      affiliateId: settings.affiliateId || "(auto)",
      subId: settings.subId,
    },
    serverBaseUrl: settings.serverBaseUrl,
    now: Date.now(),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATUS") {
    (async () => {
      const status = await getStatusPayload({ forceHealth: Boolean(message.forceHealth) });
      sendResponse({ ok: true, status });
    })().catch((error) => {
      sendResponse({ ok: false, message: error?.message || "Không lấy được trạng thái worker." });
    });
    return true;
  }

  if (message?.type === "FORCE_POLL") {
    (async () => {
      await pollOnce({ forceHealth: true });
      scheduleNextPoll(POLL_FAST_SEC);
      const status = await getStatusPayload({ forceHealth: true });
      sendResponse({ ok: true, status });
    })().catch((error) => {
      sendResponse({ ok: false, message: error?.message || "Không thể force poll." });
    });
    return true;
  }

  if (message?.type === "SET_ENABLED") {
    (async () => {
      const enabled = Boolean(message.enabled);
      await saveSettings({ enabled });
      if (enabled) {
        runtimeState.lastError = "";
        runtimeState.nextPollSec = POLL_FAST_SEC;
        scheduleNextPoll(POLL_FAST_SEC);
      } else {
        runtimeState.lastJobStatus = "disabled";
        runtimeState.nextPollSec = POLL_SLOW_SEC;
      }
      const status = await getStatusPayload({ forceHealth: true });
      sendResponse({ ok: true, status });
    })().catch((error) => {
      sendResponse({ ok: false, message: error?.message || "Không cập nhật được trạng thái enabled." });
    });
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(defaults);
  await chrome.storage.local.set({ ...defaults, ...current });
  chrome.alarms.create("queuePoll", { periodInMinutes: 1 });
  scheduleNextPoll(POLL_FAST_SEC);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("queuePoll", { periodInMinutes: 1 });
  scheduleNextPoll(POLL_FAST_SEC);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "queuePoll" || alarm.name === "queuePollOnce") {
    await pollOnce();
    scheduleNextPoll(runtimeState.nextPollSec || POLL_NORMAL_SEC);
  }
});
