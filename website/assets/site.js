/* SimGadget site — three small behaviours, no dependencies. */

(function () {
  "use strict";

  /* --- theme: system by default, sticky once chosen ---------------------- */

  var root = document.documentElement;
  try {
    var saved = localStorage.getItem("sg-theme");
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (e) { /* private mode: system theme it is */ }

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var isDark = root.getAttribute("data-theme")
      ? root.getAttribute("data-theme") === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = isDark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("sg-theme", next); } catch (e) {}
  });

  /* --- copy buttons on command blocks ------------------------------------ */

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".cmd .copy");
    if (!btn) return;
    var text = btn.parentElement.querySelector(".txt").textContent.trim();
    var done = function () {
      var was = btn.textContent;
      btn.textContent = "copied";
      btn.classList.add("done");
      setTimeout(function () { btn.textContent = was; btn.classList.remove("done"); }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      var ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  });

  /* --- demo: real video wins, CSS mock plays until then ------------------
     The hero ships an animated stand-in so the page is never dead. The
     moment assets/demo.mp4 actually renders a frame, the stand-in steps
     aside. If the file is missing, `error` fires and we simply keep the
     mock — no broken-poster box, no console noise the user has to read. */

  var demo = document.querySelector("[data-demo]");
  if (demo) {
    var video = demo.querySelector("video");
    var mock = demo.querySelector(".fakeapp");
    var caption = demo.querySelector("[data-demo-cap]");
    var log = demo.querySelector(".wirelog");

    var useMock = function () {
      demo.classList.add("playing");
      if (video) video.style.display = "none";
    };
    var useVideo = function () {
      demo.classList.remove("playing");
      if (mock) mock.classList.add("hidden");
      if (log) log.classList.add("hidden");
      if (caption) caption.textContent = "simgadget-mcp · unedited screen capture";
    };

    if (!video) {
      useMock();
    } else {
      video.addEventListener("error", useMock, true);
      video.addEventListener("playing", useVideo);
      // Give the file a moment to exist; fall back if it never loads.
      setTimeout(function () { if (video.readyState < 2) useMock(); }, 1200);
      if (video.readyState >= 2) useVideo(); else useMock();
    }
  }
})();
