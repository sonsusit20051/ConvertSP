(function (self) {
  const cfg = self.ExtConfig;

  async function checkBackendHealth() {
    const startedAt = new Date().toISOString();

    try {
      const res = await fetch(`${cfg.BACKEND_BASE_URL}/api/health`, {
        method: "GET",
        cache: "no-store"
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          startedAt,
          checkedAt: new Date().toISOString(),
          status: res.status,
          error: data.error || `Backend health lỗi HTTP ${res.status}.`
        };
      }

      return {
        ok: Boolean(data.ok),
        startedAt,
        checkedAt: new Date().toISOString(),
        status: res.status,
        serverTime: data.time || null
      };
    } catch (err) {
      return {
        ok: false,
        startedAt,
        checkedAt: new Date().toISOString(),
        status: 0,
        error: (err && err.message) || "Không kết nối được backend."
      };
    }
  }

  async function fetchNextJob() {
    const res = await fetch(`${cfg.BACKEND_BASE_URL}/api/worker/jobs/next`, {
      headers: {
        "X-Worker-Key": cfg.WORKER_KEY
      }
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Không lấy được job (HTTP ${res.status}).`);
    }

    return data.job || null;
  }

  async function reportJobComplete(jobId, affLink) {
    const res = await fetch(`${cfg.BACKEND_BASE_URL}/api/worker/jobs/${encodeURIComponent(jobId)}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Key": cfg.WORKER_KEY
      },
      body: JSON.stringify({ affLink })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Không cập nhật job done (HTTP ${res.status}).`);
    }
  }

  async function reportJobFail(jobId, errorMessage) {
    const res = await fetch(`${cfg.BACKEND_BASE_URL}/api/worker/jobs/${encodeURIComponent(jobId)}/fail`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Key": cfg.WORKER_KEY
      },
      body: JSON.stringify({ error: errorMessage })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Không cập nhật job failed (HTTP ${res.status}).`);
    }
  }

  self.ExtBackendApi = {
    checkBackendHealth,
    fetchNextJob,
    reportJobComplete,
    reportJobFail
  };
})(self);
