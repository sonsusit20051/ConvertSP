(function (window) {
  const cfg = window.ShopeeConfig;

  function pickNonEmptyString(values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  }

  function normalizeJobResponse(raw) {
    const job = raw && typeof raw === "object" && raw.job && typeof raw.job === "object"
      ? raw.job
      : raw;

    const statusRaw = pickNonEmptyString([
      job && job.status,
      job && job.state,
      job && job.jobStatus,
      job && job.job_status
    ]);

    const outputUrl = pickNonEmptyString([
      job && job.outputUrl,
      job && job.output_url,
      job && job.affLink,
      job && job.aff_link,
      raw && raw.outputUrl,
      raw && raw.output_url,
      raw && raw.affLink,
      raw && raw.aff_link
    ]);

    const error = pickNonEmptyString([
      job && job.error,
      raw && raw.error,
      raw && raw.detail,
      raw && raw.message
    ]);

    return {
      status: statusRaw.toLowerCase(),
      outputUrl,
      error
    };
  }

  function isDoneStatus(status) {
    return status === "done" || status === "completed" || status === "complete" || status === "success";
  }

  function isFailedStatus(status) {
    return status === "failed" || status === "error";
  }

  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(cfg.API_REQUEST_TIMEOUT_MS) || 10000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`Backend phản hồi chậm quá ${timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function extractApiError(status, data) {
    if (data && typeof data.error === "string" && data.error.trim()) {
      return data.error.trim();
    }

    if (data && typeof data.detail === "string" && data.detail.trim()) {
      return data.detail.trim();
    }

    if (status === 429) {
      return "Bạn thao tác quá nhanh, vui lòng thử lại sau.";
    }

    if (status === 503) {
      return "Hệ thống đang quá tải, vui lòng thử lại sau ít phút.";
    }

    return "Không thể xử lý yêu cầu.";
  }

  async function parseJsonSafe(res) {
    return res.json().catch(() => ({}));
  }

  async function createJob(rawUrl, source, ytKey) {
    const normalizedSource = String(source || "fb").toLowerCase() === "yt" ? "yt" : "fb";
    const normalizedYtKey = String(ytKey || "").trim().toUpperCase();
    const payload = { url: rawUrl, source: normalizedSource };
    if (normalizedSource === "yt") {
      payload.ytKey = normalizedYtKey;
    }
    const res = await fetchWithTimeout(`${cfg.BACKEND_BASE_URL}/api/jobs`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await parseJsonSafe(res);
    if (!res.ok) {
      const message = extractApiError(res.status, data);
      throw new Error(`${message} (HTTP ${res.status})`);
    }

    const jobId = pickNonEmptyString([
      data && data.jobId,
      data && data.job_id,
      data && data.id,
      data && data.job && data.job.id,
      data && data.job && data.job.jobId
    ]);
    if (!jobId) {
      throw new Error("Backend không trả về jobId.");
    }
    return jobId;
  }

  async function getJob(jobId) {
    const stamp = Date.now();
    const url = `${cfg.BACKEND_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}?_=${stamp}`;
    const res = await fetchWithTimeout(url, {
      cache: "no-store"
    });
    const data = await parseJsonSafe(res);

    if (!res.ok) {
      const message = extractApiError(res.status, data);
      throw new Error(`${message} (HTTP ${res.status})`);
    }

    return data;
  }

  async function waitForJob(jobId) {
    const deadline = Date.now() + cfg.JOB_TIMEOUT_MS;
    const pickupDeadline = Date.now() + Math.max(1000, Number(cfg.JOB_PENDING_PICKUP_TIMEOUT_MS) || 5000);
    const processingTimeoutMs = Math.max(1000, Number(cfg.JOB_PROCESSING_TIMEOUT_MS) || 5000);
    let processingStartedAt = 0;

    while (Date.now() < deadline) {
      const rawJob = await getJob(jobId);
      const job = normalizeJobResponse(rawJob);
      const status = String(job.status || "").toLowerCase();

      if (isDoneStatus(status) && job.outputUrl) return job.outputUrl;
      if (isDoneStatus(status) && !job.outputUrl) {
        throw new Error("Job đã hoàn tất nhưng thiếu outputUrl.");
      }
      if (isFailedStatus(status)) {
        throw new Error(job.error || "Convert thất bại.");
      }
      if ((status === "pending" || !status) && Date.now() >= pickupDeadline) {
        throw new Error("Extension worker không phản hồi, chuyển luồng 2.");
      }
      if (status === "processing") {
        if (!processingStartedAt) processingStartedAt = Date.now();
        if (Date.now() - processingStartedAt >= processingTimeoutMs) {
          throw new Error("Job processing quá 5s, chuyển luồng 2.");
        }
      } else {
        processingStartedAt = 0;
      }

      await new Promise((resolve) => setTimeout(resolve, cfg.JOB_POLL_MS));
    }

    throw new Error("Quá thời gian chờ xử lý. Vui lòng thử lại.");
  }

  async function resolveProductIds(rawUrl) {
    const params = new URLSearchParams({ url: String(rawUrl || "").trim() });
    const endpoint = `${cfg.BACKEND_BASE_URL}/api/resolve-product-ids?${params.toString()}`;
    const res = await fetchWithTimeout(endpoint, {
      cache: "no-store"
    });
    const data = await parseJsonSafe(res);

    if (!res.ok) {
      const message = extractApiError(res.status, data);
      throw new Error(`${message} (HTTP ${res.status})`);
    }

    const shopId = pickNonEmptyString([
      data && data.shopId,
      data && data.shop_id
    ]);
    const itemId = pickNonEmptyString([
      data && data.itemId,
      data && data.item_id
    ]);
    const tld = pickNonEmptyString([
      data && data.tld,
      data && data.marketTld
    ]);
    const marketDomain = pickNonEmptyString([
      data && data.marketDomain,
      data && data.market_domain
    ]);
    const shortDomain = pickNonEmptyString([
      data && data.shortDomain,
      data && data.short_domain
    ]);
    const landingClean = pickNonEmptyString([
      data && data.landingClean,
      data && data.landing_clean
    ]);
    const originLink = pickNonEmptyString([
      data && data.originLink,
      data && data.origin_link
    ]);

    if (!shopId || !itemId) {
      throw new Error("Backend không tách được shop_id/item_id.");
    }

    return {
      shopId,
      itemId,
      tld,
      marketDomain,
      shortDomain,
      landingClean,
      originLink
    };
  }

  async function convertViaBackend(rawUrl, source, ytKey) {
    const jobId = await createJob(rawUrl, source, ytKey);
    return waitForJob(jobId);
  }

  window.ShopeeApi = {
    createJob,
    waitForJob,
    resolveProductIds,
    convertViaBackend
  };
})(window);
