(function (window) {
  function byId(id) {
    return document.getElementById(id);
  }

  window.ShopeeDom = {
    byId,
    inp: byId("inp"),
    btnPaste: byId("btnPaste"),
    btnConvert: byId("btnConvert"),
    btnCopy: byId("btnCopy"),
    btnOpen: byId("btnOpen"),
    resultPreview: byId("resultPreview"),
    status: byId("status")
  };
})(window);
