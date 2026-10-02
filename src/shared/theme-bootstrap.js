/**
 * Color mode for the extension pages, loaded before their stylesheets. The
 * mode is cached in local storage, which unlike extension storage can be
 * read synchronously, so it applies before the first style calculation.
 * The pages call applyTheme when the setting loads or changes.
 */
var applyTheme = (() => {
  const CACHE_KEY = "frontfilter-theme";
  const THEMES = ["system", "dark", "light"];
  const root = document.documentElement;

  function applyTheme(theme) {
    const normalizedTheme = THEMES.includes(theme) ? theme : "system";
    root.setAttribute("data-theme", normalizedTheme);
    root.removeAttribute("data-theme-pending");
    try {
      globalThis.localStorage?.setItem(CACHE_KEY, normalizedTheme);
    } catch {
      // The mode still applies to this page without the cache.
    }
    return normalizedTheme;
  }

  try {
    const cachedTheme = globalThis.localStorage?.getItem(CACHE_KEY);
    if (THEMES.includes(cachedTheme)) {
      applyTheme(cachedTheme);
      return applyTheme;
    }
    if (cachedTheme != null) globalThis.localStorage.removeItem(CACHE_KEY);
  } catch {
    // Without local storage, the cache is filled from extension storage.
  }

  // Without a cache, as on the first page load after an update, the page
  // stays hidden until extension storage gives the mode.
  try {
    const storedTheme = globalThis.chrome?.storage?.local?.get("theme");
    if (storedTheme?.then) {
      root.setAttribute("data-theme-pending", "");
      storedTheme.then(
        ({ theme }) => applyTheme(theme),
        () => root.removeAttribute("data-theme-pending"),
      );
    }
  } catch {
    // Without extension storage, the stylesheet follows the system.
  }
  return applyTheme;
})();
