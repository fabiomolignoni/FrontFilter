/** Apply the cached color mode before the first stylesheet calculation. */
(() => {
  const cacheKey = "frontfilter-theme";
  const themes = ["system", "dark", "light"];

  function apply(theme) {
    const normalizedTheme = themes.includes(theme) ? theme : "system";
    document.documentElement.setAttribute("data-theme", normalizedTheme);
    try {
      globalThis.localStorage?.setItem(cacheKey, normalizedTheme);
    } catch {
      // Applying the attribute is sufficient for the current page.
    }
    document.documentElement.removeAttribute("data-theme-pending");
  }

  try {
    const theme = globalThis.localStorage?.getItem(cacheKey);
    if (themes.includes(theme)) {
      apply(theme);
      return;
    } else if (theme !== null) {
      globalThis.localStorage?.removeItem(cacheKey);
    }
  } catch {
    // CSS still follows the browser color scheme when local storage is unavailable.
  }

  // On the first page load after upgrading, populate the cache as early as the
  // asynchronous extension API permits. Subsequent loads take the synchronous
  // path above and apply the mode before CSS is evaluated.
  try {
    const storedTheme = globalThis.chrome?.storage?.local?.get(["theme"]);
    if (storedTheme?.then) {
      document.documentElement.setAttribute("data-theme-pending", "");
      void storedTheme
        .then(({ theme }) => apply(theme))
        .catch(() => document.documentElement.removeAttribute("data-theme-pending"));
    }
  } catch {
    // With no cache or extension storage, the stylesheet follows the system.
  }
})();
