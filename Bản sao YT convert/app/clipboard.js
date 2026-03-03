function fallbackCopy(text) {
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "");
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  temp.style.pointerEvents = "none";
  document.body.appendChild(temp);
  temp.focus();
  temp.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(temp);
  }

  return copied;
}

export async function copyText(text) {
  if (!text) {
    throw new Error("Không có nội dung để copy.");
  }

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback bên dưới
    }
  }

  if (fallbackCopy(text)) {
    return true;
  }

  throw new Error("Trình duyệt đang chặn thao tác copy.");
}

export async function readClipboardText() {
  if (navigator.clipboard?.readText && window.isSecureContext) {
    return navigator.clipboard.readText();
  }

  const err = new Error("Clipboard API không khả dụng.");
  err.code = "CLIPBOARD_UNAVAILABLE";
  throw err;
}
