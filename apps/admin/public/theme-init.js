// Paints the stored theme before first render so the console never flashes.
// Served from the admin origin because the deployment's Content-Security-Policy
// is `script-src 'self'` — an inline script would be blocked and silently skipped.
(function () {
  try {
    var stored = window.localStorage.getItem("second-brain-admin.theme");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : stored === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = "dark";
  }
})();
