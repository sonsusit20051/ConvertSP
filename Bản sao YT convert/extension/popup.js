function $(id) {
  return document.getElementById(id);
}

const state = {
  timerId: null,
  latest: null,
};

function formatAgo(ts) {
  if (!ts) {
    return "-";
  }

  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 2) {
    return "vừa xong";
  }
  if (diff < 60) {
    return `${diff}s trước`;
  }
  const min = Math.floor(diff / 60);
  if (min < 60) {
    return `${min}m trước`;
  }
  const hour = Math.floor(min / 60);
  return `${hour}h trước`;
}

function setDot(mode) {
  const dot = $("statusDot");
  dot.className = "dot";
  if (mode) {
    dot.classList.add(mode);
  }
}

function setStatusText(text) {
  $("statusText").textContent = text;
}

function render(status) {
  state.latest = status;
  const enabled = Boolean(status.enabled);
  const serverOnline = status.serverOnline === true;
  const hasError = Boolean(status.lastError);

  let mode = "warn";
  let text = "Đang chờ trạng thái...";

  if (!enabled) {
    mode = "warn";
    text = "Worker đang tắt.";
  } else if (hasError) {
    mode = "err";
    text = `Lỗi: ${status.lastError}`;
  } else if (status.polling) {
    mode = "warn";
    text = "Worker đang poll...";
  } else if (serverOnline) {
    mode = "ok";
    text = "Worker đang hoạt động.";
  } else if (status.serverOnline === false) {
    mode = "err";
    text = "Không kết nối được queue server.";
  }

  setDot(mode);
  setStatusText(text);

  $("lineWorker").textContent = `Worker: ${status.worker.name} (${status.worker.id})`;
  $("lineServer").textContent = `Server: ${status.serverBaseUrl || "-"} | ${
    serverOnline ? "online" : status.serverOnline === false ? "offline" : "unknown"
  }`;
  $("lineQueue").textContent = `Queue: ${status.queueSize ?? "-"} | Workers online: ${
    status.workers?.online ?? "-"
  }/${status.workers?.total ?? "-"}`;
  $("linePoll").textContent = `Poll: ${formatAgo(status.lastPollAt)} | Success: ${formatAgo(
    status.lastSuccessAt
  )}`;
  $("lineJob").textContent = `Job: ${status.lastJobStatus || "-"}${
    status.lastJobId ? ` (${status.lastJobId})` : ""
  }`;

  $("toggleBtn").textContent = enabled ? "Tắt worker" : "Bật worker";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function refreshStatus(force = false) {
  try {
    const response = await sendMessage({ type: "GET_STATUS", forceHealth: force });
    if (!response?.ok || !response?.status) {
      throw new Error(response?.message || "Không lấy được trạng thái.");
    }
    render(response.status);
  } catch (error) {
    setDot("err");
    setStatusText(error?.message || "Không đọc được trạng thái extension.");
  }
}

async function forcePollNow() {
  const btn = $("refreshBtn");
  btn.disabled = true;

  try {
    const response = await sendMessage({ type: "FORCE_POLL" });
    if (!response?.ok || !response?.status) {
      throw new Error(response?.message || "Force poll thất bại.");
    }
    render(response.status);
  } catch (error) {
    setDot("err");
    setStatusText(error?.message || "Force poll thất bại.");
  } finally {
    btn.disabled = false;
  }
}

async function toggleWorker() {
  const enabled = !Boolean(state.latest?.enabled);
  const response = await sendMessage({ type: "SET_ENABLED", enabled });
  if (!response?.ok || !response?.status) {
    throw new Error(response?.message || "Không đổi được trạng thái worker.");
  }
  render(response.status);
}

window.addEventListener("DOMContentLoaded", async () => {
  $("refreshBtn").addEventListener("click", forcePollNow);
  $("toggleBtn").addEventListener("click", async () => {
    try {
      await toggleWorker();
    } catch (error) {
      setDot("err");
      setStatusText(error?.message || "Không đổi được trạng thái worker.");
    }
  });

  await refreshStatus(true);
  state.timerId = window.setInterval(() => {
    refreshStatus(false);
  }, 1500);
});

window.addEventListener("unload", () => {
  if (state.timerId) {
    clearInterval(state.timerId);
  }
});
