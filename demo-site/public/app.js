/**
 * Agate Co. — اسکریپت سبک صفحهٔ اصلی.
 * فقط خواندن وضعیت از /health (بدون نوشتن، بدون وابستگی).
 */
(function () {
  "use strict";

  var pill = document.getElementById("live-pill");
  var pillText = pill ? pill.querySelector("[data-health]") : null;

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + " ساعت و " + m + " دقیقه";
    if (m > 0) return m + " دقیقه و " + s + " ثانیه";
    return s + " ثانیه";
  }

  function paint(data) {
    if (!data) return;
    if (pillText) {
      pillText.textContent = "سرویس فعال · " + (data.bugMode || "off");
      if (pill) pill.setAttribute("data-state", data.status === "ok" ? "up" : "down");
    }
    var map = {
      status: data.status,
      bugMode: data.bugMode,
      uptime: fmtUptime(data.uptime),
      memMB: (data.memMB || 0) + " MB",
    };
    Object.keys(map).forEach(function (key) {
      var el = document.querySelector('[data-s="' + key + '"]');
      if (el) el.textContent = map[key];
    });
    var raw = document.querySelector('[data-s="raw"]');
    if (raw) raw.textContent = JSON.stringify(data, null, 2);
  }

  function tick() {
    fetch("/health", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(paint)
      .catch(function () {
        if (pill) pill.setAttribute("data-state", "down");
        if (pillText) pillText.textContent = "ارتباط برقرار نشد";
      });
  }

  tick();
  setInterval(tick, 5000);
})();
