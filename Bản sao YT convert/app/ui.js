import { dom } from "./dom.js";

let statusTimer = 0;

export function setBusy(isBusy) {
  if (dom.createBtn) {
    dom.createBtn.disabled = isBusy;
    dom.createBtn.textContent = isBusy ? "Đang tạo..." : "Tạo link";
  }
  if (dom.pasteBtn) {
    dom.pasteBtn.disabled = isBusy;
  }
}

export function renderCooldown(secondsLeft) {
  const secs = Math.max(0, Number(secondsLeft) || 0);
  if (dom.createBtn) {
    if (secs > 0) {
      dom.createBtn.disabled = true;
      dom.createBtn.textContent = `Tạo lại (${secs}s)`;
    } else {
      dom.createBtn.disabled = false;
      dom.createBtn.textContent = "Tạo link";
    }
  }

  if (dom.cooldownHint) {
    if (secs > 0) {
      dom.cooldownHint.classList.remove("hidden");
      dom.cooldownHint.textContent = `Vui lòng chờ ${secs}s để tạo link tiếp theo.`;
    } else {
      dom.cooldownHint.classList.add("hidden");
      dom.cooldownHint.textContent = "";
    }
  }
}

export function clearInputError() {
  if (dom.inputError) {
    dom.inputError.textContent = "";
  }
}

export function showInputError(message) {
  if (dom.inputError) {
    dom.inputError.textContent = message || "";
  }
}

export function hideStatus() {
  if (statusTimer) {
    window.clearTimeout(statusTimer);
    statusTimer = 0;
  }

  if (!dom.statusToast) {
    return;
  }

  dom.statusToast.classList.add("hidden");
  dom.statusToast.classList.remove("error", "success");
  dom.statusToast.textContent = "";
}

export function showStatus(type, message) {
  if (statusTimer) {
    window.clearTimeout(statusTimer);
    statusTimer = 0;
  }

  if (!dom.statusToast) {
    return;
  }

  dom.statusToast.classList.remove("hidden", "error", "success");
  if (type === "error") {
    dom.statusToast.classList.add("error");
  } else if (type === "success") {
    dom.statusToast.classList.add("success");
  }
  dom.statusToast.textContent = message || "";

  if (type === "success" || type === "error") {
    statusTimer = window.setTimeout(() => {
      hideStatus();
    }, 2200);
  }
}

export function setBuyEnabled(enabled) {
  if (dom.buyBtn) {
    dom.buyBtn.disabled = !enabled;
  }
}
