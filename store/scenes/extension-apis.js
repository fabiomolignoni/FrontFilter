/**
 * Fake extension APIs for FrontFilter's real pages in the store scenes.
 * scripts/store_images.py loads this script first in every extension page
 * it serves. The scene's frame gives the settings, as JSON in data-settings,
 * and the color theme in data-theme.
 */
(() => {
  const frame = window.frameElement;
  const theme = frame?.dataset.theme || "dark";
  const settings = { ...JSON.parse(frame?.dataset.settings || "{}"), theme };
  // Read synchronously, as getManifest returns the manifest.
  const request = new XMLHttpRequest();
  request.open("GET", "/src/manifest.json", false);
  request.send();
  const manifest = JSON.parse(request.responseText);

  // theme-bootstrap.js reads the mode from this cache before the page shows.
  localStorage.setItem("frontfilter-theme", theme);

  function pick(keys) {
    if (keys == null) return { ...settings };
    const names = typeof keys === "string" ? [keys] : keys;
    return Object.fromEntries(names.filter((key) => key in settings).map((key) => [key, settings[key]]));
  }

  window.chrome = {
    runtime: {
      getManifest: () => manifest,
      getURL: (path) => `/src/${path}`,
      sendMessage: async () => ({ success: true }),
    },
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (values) => { Object.assign(settings, values); },
        remove: async () => {},
      },
      onChanged: { addListener() {} },
    },
    tabs: { query: async () => [] },
  };

  // The pages ask for the system UI font, which Linux lacks: Inter is the
  // closest match to the fonts Chrome shows on macOS and Windows.
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = ':is(body, button, input, select) '
      + '{ font-family: Inter, -apple-system, "Segoe UI", sans-serif; }';
    document.head.append(style);
  });
})();
