(function (self) {
  const cfg = self.ExtConfig;
  const internalApi = self.ExtInternalApi;
  const backendApi = self.ExtBackendApi;

  let running = false;
  const runtimeStatus = {
    running: false,
    initializedAt: new Date().toISOString(),
    lastTrigger: null,
    lastCycleStartedAt: null,
    lastCycleFinishedAt: null,
    lastProcessedCount: 0,
    lastFailureCount: 0,
    lastFailureMessage: null,
    lastError: null
  };

  async function processOneJob() {
    const job = await backendApi.fetchNextJob();
    if (!job) {
      return { processed: false, failed: false };
    }

    try {
      const affLink = await internalApi.convertByInternalApi(job.url);
      await backendApi.reportJobComplete(job.jobId, affLink);
      return { processed: true, failed: false };
    } catch (err) {
      const message = internalApi.normalizeError(err, "Không convert được link.");
      try {
        await backendApi.reportJobFail(job.jobId, message);
      } catch (reportErr) {
        console.error("Không report được lỗi job:", reportErr);
      }
      return { processed: true, failed: true, error: message };
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function processOneJobWithIdleRetry() {
    const first = await processOneJob();
    if (first.processed) return first;

    const retryCount = Math.max(0, Number(cfg.WORKER_IDLE_RETRY_COUNT) || 0);
    const retryDelayMs = Math.max(50, Number(cfg.WORKER_IDLE_RETRY_DELAY_MS) || 250);

    for (let i = 0; i < retryCount; i += 1) {
      await sleep(retryDelayMs);
      const retried = await processOneJob();
      if (retried.processed) return retried;
    }

    return first;
  }

  // Run a bounded batch to avoid monopolizing worker execution time.
  async function runWorkerCycle(trigger) {
    if (running) {
      return {
        skipped: true,
        reason: "running",
        status: getStatus()
      };
    }

    running = true;
    runtimeStatus.running = true;
    runtimeStatus.lastTrigger = trigger || "unknown";
    runtimeStatus.lastCycleStartedAt = new Date().toISOString();

    let processedCount = 0;
    let failureCount = 0;
    let lastFailureMessage = null;
    const maxBatch = Math.max(1, Number(cfg.WORKER_MAX_BATCH) || 5);

    try {
      for (let i = 0; i < maxBatch; i += 1) {
        // On first fetch, do quick retries when queue is just becoming non-empty.
        const result = i === 0
          ? await processOneJobWithIdleRetry()
          : await processOneJob();
        if (!result.processed) break;
        processedCount += 1;
        if (result.failed) {
          failureCount += 1;
          lastFailureMessage = result.error || "Job convert thất bại.";
        }
      }
      runtimeStatus.lastProcessedCount = processedCount;
      runtimeStatus.lastFailureCount = failureCount;
      runtimeStatus.lastFailureMessage = lastFailureMessage;
      runtimeStatus.lastError = lastFailureMessage;
      return {
        skipped: false,
        processedCount,
        failureCount,
        lastFailureMessage
      };
    } catch (err) {
      runtimeStatus.lastError = (err && err.message) || "Worker cycle failed.";
      throw err;
    } finally {
      runtimeStatus.lastCycleFinishedAt = new Date().toISOString();
      runtimeStatus.running = false;
      running = false;
    }
  }

  function getStatus() {
    return { ...runtimeStatus };
  }

  self.ExtWorkerRunner = {
    runWorkerCycle,
    getStatus
  };
})(self);
