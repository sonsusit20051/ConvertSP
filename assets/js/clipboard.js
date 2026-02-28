(function (window) {
  async function readClipboardText() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      throw new Error("ClipboardReadBlocked");
    }
    return navigator.clipboard.readText();
  }

  async function copyText(text) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error("ClipboardWriteBlocked");
      }
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  window.ShopeeClipboard = {
    readClipboardText,
    copyText
  };
})(window);
