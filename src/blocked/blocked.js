/**
 * The page that replaces a blocked Reddit page. It names what is blocked,
 * leads back or to the settings, and returns to the blocked page as soon as
 * a settings change unblocks it.
 */

const PAGE_MESSAGES = {
  homepage: "Reddit Homepage is blocked",
  popular: "Popular page is blocked",
  explore: "Explore page is blocked",
  news: "News page is blocked",
  subhome: "Subreddit front pages are blocked",
};

document.addEventListener("DOMContentLoaded", () => {
  void loadTheme();

  const params = new URLSearchParams(window.location.search);
  // The blocked URL follows in the fragment (see FrontFilter.blockPageQuery).
  const returnUrl = getSafeReturnUrl(window.location.hash.slice(1));
  const returnSubreddit = returnUrl
    ? FrontFilter.getSubredditPath(new URL(returnUrl).pathname)?.name
    : "";
  const sub = params.get("target") === "subreddit"
    ? FrontFilter.normalizeSubredditName(params.get("subreddit")) || returnSubreddit
    : "";

  document.getElementById("block-message").textContent = sub
    ? `r/${sub} is blocked`
    : PAGE_MESSAGES[params.get("page")] ?? "This content is blocked";

  // The rule is worth naming when it is a pattern rather than the name.
  const filter = params.get("filter");
  if (filter && filter !== sub) {
    const reason = document.getElementById("block-reason");
    const value = document.createElement("strong");
    value.textContent = filter;
    reason.append("Blocked by the rule ", value);
    reason.hidden = false;
  }

  // Offered only on the redirect caused by a one-click block, whose token
  // must match the one-time marker stored with the rule.
  const undoToken = params.get("undo");
  if (undoToken) {
    void offerUndo(sub, undoToken);
    params.delete("undo");
    window.history.replaceState(null, "", `?${params}${window.location.hash}`);
  }

  document.getElementById("go-back").addEventListener("click", async () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    try {
      const settings = await chrome.storage.local.get(FrontFilter.NAVIGATION_STORAGE_KEYS);
      if (!FrontFilter.getBlockedRoute("/", settings)) {
        window.location.href = "https://www.reddit.com";
        return;
      }
    } catch (error) {
      console.error("Could not determine a safe fallback page:", error);
    }

    window.location.href = getSettingsPageUrl(returnSubreddit);
  });

  document.getElementById("go-to-settings").addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "openSettings",
        currentSubreddit: returnSubreddit,
      });
      if (response?.success) return;
    } catch {
      // Fall through to opening the settings page in this tab.
    }

    window.location.href = getSettingsPageUrl(returnSubreddit);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.hasOwn(changes, "theme")) applyTheme(changes.theme.newValue);
    // Only navigation settings can unblock the page.
    if (FrontFilter.NAVIGATION_STORAGE_KEYS.some((key) => Object.hasOwn(changes, key))) {
      void restoreIfUnblocked(returnUrl);
    }
  });
});

async function offerUndo(subreddit, token) {
  const key = FrontFilter.QUICK_BLOCK_UNDO_KEY;
  try {
    const { [key]: pending } = await chrome.storage.local.get(key);
    // One use only: reloading, going back or visiting the blocked page again
    // must not offer it.
    await chrome.storage.local.remove(key);
    if (subreddit && pending?.subreddit === subreddit && pending.token === token
      && Date.now() < pending.expires) {
      setUpUndo(subreddit, pending.previousMode);
    }
  } catch (error) {
    console.error("Could not check the undo offer:", error);
  }
}

function setUpUndo(subreddit, previousMode) {
  const button = document.getElementById("undo-block");
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const { blockedSubreddits } = await chrome.storage.local.get("blockedSubreddits");
      // The storage listener returns to the page once it is unblocked.
      await chrome.storage.local.set({
        blockedSubreddits: FrontFilter.undoBlockedSubreddit(
          blockedSubreddits, subreddit, previousMode,
        ),
      });
    } catch (error) {
      button.disabled = false;
      console.error("Could not undo the block:", error);
    }
  });
}

function getSettingsPageUrl(currentSubreddit) {
  return chrome.runtime.getURL(FrontFilter.settingsPagePath(currentSubreddit));
}

// theme-bootstrap.js applies the cached mode; this catches up with a mode
// changed while no extension page was open to update the cache.
async function loadTheme() {
  try {
    const { theme } = await chrome.storage.local.get("theme");
    applyTheme(theme);
  } catch (error) {
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
    const settings = await chrome.storage.local.get(FrontFilter.NAVIGATION_STORAGE_KEYS);
    const route = FrontFilter.getBlockedRoute(new URL(returnUrl).pathname, settings);
    if (route || checkId !== restoreCheckId) return;

    // Navigation rules must be updated before the page is loaded again.
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
