import { RESOLVE_TIMEOUT_MS } from "./config.js";
import { isShopeeLandingHost, isShortLinkHost } from "./validators.js";

function getResolveErrorMessage(error) {
  if (error?.name === "AbortError") {
    return "Hết thời gian resolve shortlink. Vui lòng thử lại hoặc mở link thủ công.";
  }

  return "Không thể tự resolve shortlink do giới hạn CORS hoặc mạng. Hãy mở shortlink ở tab mới, copy URL cuối rồi dán lại.";
}

export async function resolveLandingUrl(urlObj, timeoutMs = RESOLVE_TIMEOUT_MS) {
  if (!isShortLinkHost(urlObj.hostname)) {
    return {
      ok: true,
      landingUrl: new URL(urlObj.toString()),
      resolvedFromShort: false,
    };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(urlObj.toString(), {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response?.url) {
      throw new Error("Missing final URL");
    }

    const finalUrl = new URL(response.url);

    if (isShortLinkHost(finalUrl.hostname)) {
      throw new Error("Still short link after fetch");
    }

    if (!isShopeeLandingHost(finalUrl.hostname)) {
      return {
        ok: false,
        needsManualStep: false,
        errorMessage: "Shortlink không trỏ về domain Shopee hợp lệ.",
      };
    }

    finalUrl.hash = "";

    return {
      ok: true,
      landingUrl: finalUrl,
      resolvedFromShort: true,
    };
  } catch (error) {
    return {
      ok: false,
      needsManualStep: true,
      manualUrl: urlObj.toString(),
      errorMessage: getResolveErrorMessage(error),
    };
  } finally {
    window.clearTimeout(timer);
  }
}
