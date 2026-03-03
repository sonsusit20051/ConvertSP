(function (window) {
  function byId(id) {
    return document.getElementById(id);
  }

  window.ShopeeDom = {
    byId,
    btnModeFacebook: byId("modeFb") || byId("btnModeFacebook"),
    btnModeYoutube: byId("modeYt") || byId("btnModeYoutube"),
    panel: byId("mainPanel"),
    ytOnlyMessage: byId("ytOnlyMessage"),
    inp: byId("inp"),
    btnPaste: byId("btnPaste"),
    btnConvert: byId("btnConvert"),
    btnCopy: byId("btnCopy"),
    btnOpen: byId("btnOpen"),
    resultPreview: byId("resultPreview"),
    status: byId("status")
  };
})(window);
