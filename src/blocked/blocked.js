/**
 * FrontFilter blocked-page controller.
 */

document.addEventListener("DOMContentLoaded", () => {
  void loadTheme();

  const params = new URLSearchParams(window.location.search);
  const returnUrl = getSafeReturnUrl(
    params.get("returnUrl") || window.location.hash.slice(1),
  );
  const returnSubreddit = returnUrl
    ? FrontFilter.getSubredditPath(new URL(returnUrl).pathname)?.name
    : "";
  const sub = params.get("subreddit")
    || (params.get("target") === "subreddit" ? returnSubreddit : "");
  const page = params.get("page");
  const filter = params.get("filter");

  const PAGE_MESSAGES = {
    homepage: "Reddit Homepage is blocked",
    popular: "Popular page is blocked",
    explore: "Explore page is blocked",
    news: "News page is blocked",
    subhome: "Subreddit front pages are blocked",
  };

  document.getElementById("block-message").textContent = sub
    ? `r/${sub} is blocked`
    : PAGE_MESSAGES[page] ?? "This content is blocked";

  const reason = document.getElementById("block-reason");
  if (filter) {
    reason.textContent = "";
    reason.appendChild(document.createTextNode("Applied filter: "));

    const value = document.createElement("strong");
    value.textContent = filter;
    reason.appendChild(value);
    reason.hidden = false;
  }

  document.getElementById("go-back").addEventListener("click", async () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    try {
      const settings = FrontFilter.coerceSettings(
        await chrome.storage.local.get(FrontFilter.NAVIGATION_STORAGE_KEYS),
      );
      if (!FrontFilter.getBlockedRoute("/", settings)) {
        window.location.href = "https://www.reddit.com";
        return;
      }
    } catch (error) {
      console.error("Could not determine a safe fallback page:", error);
    }

    window.location.href = getStandaloneSettingsUrl(returnSubreddit);
  });

  document.getElementById("go-to-settings").addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "openSettings",
        currentSubreddit: returnSubreddit,
      });
      if (response?.success) return;
    } catch {
      // Fall through to opening the standalone settings page in this tab.
    }

    window.location.href = getStandaloneSettingsUrl(returnSubreddit);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.prototype.hasOwnProperty.call(changes, "theme")) {
      applyTheme(changes.theme?.newValue);
    }
    void restoreIfUnblocked(returnUrl);
  });
});

function getStandaloneSettingsUrl(currentSubreddit = "") {
  const settingsUrl = new URL(chrome.runtime.getURL("popup/index.html"));
  settingsUrl.searchParams.set("standalone", "true");
  if (currentSubreddit) {
    settingsUrl.searchParams.set("currentSubreddit", currentSubreddit);
  }
  return settingsUrl.href;
}

function applyTheme(theme) {
  const normalizedTheme = FrontFilter.normalizeTheme(theme);
  document.documentElement.setAttribute("data-theme", normalizedTheme);
  try {
    globalThis.localStorage?.setItem("frontfilter-theme", normalizedTheme);
  } catch {
    // The theme still works for this page if local storage is unavailable.
  }
}

async function loadTheme() {
  try {
    const { theme } = await chrome.storage.local.get(["theme"]);
    applyTheme(theme);
  } catch (error) {
    applyTheme(FrontFilter.DEFAULT_SETTINGS.theme);
    console.error("Could not load FrontFilter theme:", error);
  }
}

function getSafeReturnUrl(value) {
  return FrontFilter.getRedditUrl(value)?.href || "";
}

let restoreCheckId = 0;

async function restoreIfUnblocked(returnUrl) {
  if (!returnUrl) return;
  const checkId = ++restoreCheckId;

  try {
    const settings = FrontFilter.coerceSettings(
      await chrome.storage.local.get(FrontFilter.NAVIGATION_STORAGE_KEYS)
    );
    const url = new URL(returnUrl);
    const route = FrontFilter.getBlockedRoute(url.pathname, settings);
    if (route || checkId !== restoreCheckId) return;

    const response = await chrome.runtime.sendMessage({ action: "syncNavigationRules" });
    if (!response?.success) {
      throw new Error(response?.error || "Navigation rule synchronization failed");
    }
    if (checkId !== restoreCheckId) return;

    window.location.replace(returnUrl);
  } catch (error) {
    console.error("Could not restore blocked page:", error);
  }
}
