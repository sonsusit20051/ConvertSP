const defaults = {
  enabled: true,
  serverBaseUrl: "http://localhost:8787",
  workerToken: "dev-worker-token",
  workerId: "",
  workerName: "chrome-worker",
  affiliateId: "17391540096",
  subId: "YT3",
  baseRedirect: "https://s.shopee.vn/an_redir",
};

const ids = [
  "serverBaseUrl",
  "workerToken",
  "workerId",
  "workerName",
  "affiliateId",
  "subId",
  "baseRedirect",
  "enabled",
];

function $(id) {
  return document.getElementById(id);
}

async function load() {
  const data = await chrome.storage.local.get(defaults);

  for (const id of ids) {
    const el = $(id);
    if (!el) {
      continue;
    }

    if (el.type === "checkbox") {
      el.checked = Boolean(data[id]);
    } else {
      el.value = data[id] || "";
    }
  }
}

async function save() {
  const patch = {};
  for (const id of ids) {
    const el = $(id);
    if (!el) {
      continue;
    }

    patch[id] = el.type === "checkbox" ? el.checked : el.value.trim();
  }

  await chrome.storage.local.set(patch);
  $("status").textContent = "Đã lưu.";
  setTimeout(() => {
    $("status").textContent = "";
  }, 1500);
}

window.addEventListener("DOMContentLoaded", async () => {
  await load();
  $("saveBtn").addEventListener("click", save);
});
