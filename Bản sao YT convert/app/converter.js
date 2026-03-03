import { AFFILIATE_ID, BASE_REDIRECT, SUB_ID, TRACKING_QUERY_KEYS } from "./config.js";

export function cleanLandingUrl(urlObj) {
  const cleaned = new URL(urlObj.toString());
  cleaned.protocol = "https:";
  cleaned.hash = "";

  const nextParams = new URLSearchParams();
  cleaned.searchParams.forEach((value, key) => {
    if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      return;
    }
    nextParams.append(key, value);
  });

  const query = nextParams.toString();
  cleaned.search = query ? `?${query}` : "";

  return cleaned.toString();
}

export function buildAffiliateLink(cleanLandingUrl) {
  const originLink = encodeURIComponent(cleanLandingUrl);

  return `${BASE_REDIRECT}?affiliate_id=${encodeURIComponent(
    AFFILIATE_ID
  )}&sub_id=${encodeURIComponent(SUB_ID)}&origin_link=${originLink}`;
}
