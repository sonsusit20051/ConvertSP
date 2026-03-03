import { convertViaSyncApi, hasBackendEndpoint } from "./api.js";
import { copyText, readClipboardText } from "./clipboard.js";
import { dom } from "./dom.js";
import {
  clearInputError,
  hideStatus,
  renderCooldown,
  setBusy,
  setBuyEnabled,
  showInputError,
  showStatus,
} from "./ui.js";
import { parseAndValidateInput } from "./validators.js";

const CREATE_COOLDOWN_SEC = 5;

const state = {
  busy: false,
  currentAffiliateLink: "",
  cooldownUntilMs: 0,
  cooldownTimer: 0,
};

function requiredDomReady() {
  return Boolean(
    dom.sourceInput &&
      dom.outputInput &&
      dom.copyOutputBtn &&
      dom.pasteBtn &&
      dom.createBtn &&
      dom.buyBtn &&
      dom.inputError &&
      dom.statusToast
  );
}

function syncOutputUi() {
  if (dom.outputInput) {
    dom.outputInput.value = state.currentAffiliateLink || "";
  }
  if (dom.copyOutputBtn) {
    dom.copyOutputBtn.disabled = state.busy || !state.currentAffiliateLink;
  }
}

function resetOutput() {
  state.currentAffiliateLink = "";
  setBuyEnabled(false);
  syncOutputUi();
}

function clearCooldownTimer() {
  if (state.cooldownTimer) {
    window.clearInterval(state.cooldownTimer);
    state.cooldownTimer = 0;
  }
}

function getCooldownRemainSec() {
  const remainMs = Math.max(0, state.cooldownUntilMs - Date.now());
  return Math.ceil(remainMs / 1000);
}

function syncCooldownUi() {
  if (state.busy) {
    return;
  }
  renderCooldown(getCooldownRemainSec());
}

function startCooldown(seconds = CREATE_COOLDOWN_SEC) {
  clearCooldownTimer();
  state.cooldownUntilMs = Date.now() + Math.max(0, Number(seconds) || 0) * 1000;
  syncCooldownUi();
  state.cooldownTimer = window.setInterval(() => {
    const remain = getCooldownRemainSec();
    if (remain <= 0) {
      state.cooldownUntilMs = 0;
      clearCooldownTimer();
      syncCooldownUi();
      return;
    }
    syncCooldownUi();
  }, 200);
}

function setProcessing(nextBusy) {
  state.busy = nextBusy;
  setBusy(nextBusy);
  syncOutputUi();
  if (!nextBusy) {
    syncCooldownUi();
  }
}

async function handlePasteClick(event) {
  event?.preventDefault?.();
  if (state.busy) {
    return;
  }

  clearInputError();
  hideStatus();

  try {
    const text = await readClipboardText();
    if (!text || !text.trim()) {
      showStatus("error", "Clipboard đang trống.");
      return;
    }
    dom.sourceInput.value = text.trim();
    dom.sourceInput.focus();
  } catch {
    dom.sourceInput.focus();
    showStatus("error", "Không đọc được clipboard. Hãy dán thủ công bằng Ctrl/Cmd+V.");
  }
}

async function handleCreateClick(event) {
  event?.preventDefault?.();
  if (state.busy) {
    return;
  }
  if (getCooldownRemainSec() > 0) {
    showStatus("error", `Vui lòng chờ ${getCooldownRemainSec()}s rồi tạo lại.`);
    syncCooldownUi();
    return;
  }

  clearInputError();
  hideStatus();
  resetOutput();

  const validation = parseAndValidateInput(dom.sourceInput.value);
  if (!validation.ok) {
    showInputError(validation.error);
    return;
  }

  if (!hasBackendEndpoint()) {
    showStatus(
      "error",
      "Chưa cấu hình backend public. Mở web với ?api=https://your-backend-domain rồi thử lại."
    );
    return;
  }

  setProcessing(true);
  let requestSent = false;
  try {
    requestSent = true;
    const payload = await convertViaSyncApi(validation.url.toString(), "yt");
    const link = String(payload?.affiliateLink || payload?.longAffiliateLink || "").trim();
    if (!link) {
      throw new Error("Không nhận được affiliate link.");
    }

    state.currentAffiliateLink = link;
    syncOutputUi();
    setBuyEnabled(true);
    showStatus("success", "Link đã chuyển đổi xong.");
  } catch (error) {
    console.error(error);
    const msg = String(error?.message || "").trim();
    showStatus("error", msg ? `Tạo link thất bại: ${msg}` : "Tạo link thất bại");
  } finally {
    setProcessing(false);
    if (requestSent) {
      startCooldown(CREATE_COOLDOWN_SEC);
    }
  }
}

async function handleCopyOutputClick(event) {
  event?.preventDefault?.();
  if (state.busy || !state.currentAffiliateLink) {
    return;
  }

  try {
    await copyText(state.currentAffiliateLink);
    showStatus("success", "Đã sao chép link đầu ra.");
  } catch (error) {
    const msg = String(error?.message || "").trim();
    showStatus("error", msg || "Không sao chép được link.");
  }
}

function handleOpenClick(event) {
  event?.preventDefault?.();
  if (state.busy || !state.currentAffiliateLink) {
    return;
  }

  const popup = window.open(state.currentAffiliateLink, "_blank", "noopener,noreferrer");
  if (!popup) {
    showStatus("error", "Trình duyệt chặn mở tab mới. Hãy cho phép pop-up.");
  }
}

function bindEvents() {
  dom.pasteBtn.addEventListener("click", handlePasteClick);
  dom.createBtn.addEventListener("click", handleCreateClick);
  dom.copyOutputBtn.addEventListener("click", handleCopyOutputClick);
  dom.buyBtn.addEventListener("click", handleOpenClick);
  dom.sourceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      handleCreateClick(event);
    }
  });
  dom.sourceInput.addEventListener("input", () => {
    clearInputError();
    if (state.currentAffiliateLink) {
      resetOutput();
    }
  });
}

function init() {
  if (!requiredDomReady()) {
    // Keep UI unchanged if DOM is incomplete; avoid white screen replacement.
    console.error("DOM chưa sẵn sàng, kiểm tra index.html IDs.");
    return;
  }
  hideStatus();
  clearInputError();
  setBusy(false);
  resetOutput();
  syncOutputUi();
  renderCooldown(0);
  bindEvents();
}

init();
