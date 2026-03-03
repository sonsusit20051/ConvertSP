import {
  BACKEND_BASE_URL,
  JOB_POLL_INTERVAL_MS,
  JOB_POLL_TIMEOUT_MS,
  RESOLVE_TIMEOUT_MS,
} from "./config.js";

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLoopbackUrl(urlText) {
  try {
    const parsed = new URL(String(urlText || ""));
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function getBackendBaseUrl() {
  let queryBase = "";
  try {
    const params = new URLSearchParams(window.location.search);
    queryBase = String(params.get("api") || "").trim();
    if (queryBase) {
      window.localStorage.setItem("BACKEND_BASE_URL", queryBase);
    }
  } catch {
    // Ignore query parsing/storage errors.
  }

  let storedBase = "";
  try {
    storedBase = String(window.localStorage.getItem("BACKEND_BASE_URL") || "").trim();
  } catch {
    // Ignore storage errors.
  }

  const fallbackBase = String(BACKEND_BASE_URL || "").trim();
  const runningOnLocalPage = isLoopbackHost(window.location.hostname);

  // Prevent publish pages from silently using localhost backend.
  if (!runningOnLocalPage && !queryBase && isLoopbackUrl(storedBase)) {
    storedBase = "";
    try {
      window.localStorage.removeItem("BACKEND_BASE_URL");
    } catch {
      // Ignore storage errors.
    }
  }

  let base = queryBase || storedBase || fallbackBase;
  if (!runningOnLocalPage && isLoopbackUrl(base)) {
    base = "";
  }

  return base.replace(/\/$/, "");
}

function toAbsoluteEndpoint(path) {
  const base = getBackendBaseUrl();
  return `${base}${path}`;
}

function jobEndpoint(jobId) {
  return toAbsoluteEndpoint(`/api/jobs/${encodeURIComponent(jobId)}`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = RESOLVE_TIMEOUT_MS + 3000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(payload?.message || `HTTP ${response.status}`);
    }

    return payload || {};
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Backend xử lý quá lâu hoặc không phản hồi.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export function hasBackendEndpoint() {
  return Boolean(getBackendBaseUrl());
}

export async function submitConvertJob(inputText) {
  if (!hasBackendEndpoint()) {
    throw new Error("Backend endpoint chưa được cấu hình.");
  }

  const payload = await fetchJsonWithTimeout(
    toAbsoluteEndpoint("/api/convert"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: inputText }),
    },
    RESOLVE_TIMEOUT_MS + 4000
  );

  if (!payload?.ok || !payload?.jobId) {
    throw new Error(payload?.message || "Backend không trả về job hợp lệ.");
  }

  return payload;
}

export async function convertViaSyncApi(inputText, mode = "yt") {
  if (!hasBackendEndpoint()) {
    throw new Error("Backend endpoint chưa được cấu hình.");
  }

  const query = new URLSearchParams({
    url: String(inputText || ""),
    yt: mode === "yt" ? "1" : "0",
  });

  const payload = await fetchJsonWithTimeout(
    `${toAbsoluteEndpoint("/")}?${query.toString()}`,
    { method: "GET", cache: "no-store" },
    RESOLVE_TIMEOUT_MS + 80000
  );

  if (!payload?.success || !payload?.affiliateLink) {
    throw new Error(payload?.message || "Backend sync API trả về dữ liệu không hợp lệ.");
  }

  return payload;
}

export async function getJob(jobId) {
  const payload = await fetchJsonWithTimeout(jobEndpoint(jobId), {
    method: "GET",
  });

  if (!payload?.ok || !payload?.job?.id) {
    throw new Error(payload?.message || "Không đọc được trạng thái job.");
  }

  return payload.job;
}

export async function waitForJobResult(jobId, options = {}) {
  const timeoutMs = options.timeoutMs || JOB_POLL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs || JOB_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const job = await getJob(jobId);
    if (typeof options.onProgress === "function") {
      options.onProgress(job);
    }

    if (job.status === "success") {
      return job;
    }

    if (job.status === "error" || job.status === "expired") {
      throw new Error(job.message || "Worker không thể tạo link.");
    }

    await sleep(pollIntervalMs);
  }

  throw new Error("Hết thời gian chờ worker xử lý. Vui lòng thử lại.");
}
