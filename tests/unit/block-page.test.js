const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeElement {
  constructor() {
    this.attributes = {};
    this.children = [];
    this.hidden = true;
    this.listeners = {};
    this.textContent = "";
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  click() {
    return this.listeners.click?.();
  }
}

async function loadBlockPage({
  historyLength = 1,
  hash = "",
  search = "",
  sendMessage = async () => ({ success: true }),
  storedSettings = {},
} = {}) {
  const elements = {
    "block-message": new FakeElement(),
    "block-reason": new FakeElement(),
    "go-back": new FakeElement(),
    "go-to-settings": new FakeElement(),
  };
  let readyListener;
  const redirects = [];
  const location = {
    href: "moz-extension://frontfilter/blocked/index.html",
    hash,
    search,
    replace: (url) => redirects.push(url),
  };
  let historyBackCount = 0;
  let storageListener;
  const themeCache = new Map();
  const documentElement = new FakeElement();
  const document = {
    addEventListener(type, listener) {
      if (type === "DOMContentLoaded") readyListener = listener;
    },
    createElement: () => new FakeElement(),
    createTextNode: (textContent) => ({ textContent }),
    documentElement,
    getElementById: (id) => elements[id],
  };
  const chrome = {
    runtime: {
      getURL: (path) => `moz-extension://frontfilter/${path}`,
      sendMessage,
    },
    storage: {
      local: { get: async () => storedSettings },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
  };
  const window = {
    history: {
      back() { historyBackCount += 1; },
      length: historyLength,
    },
    location,
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    chrome,
    console,
    document,
    localStorage: {
      getItem: (key) => themeCache.get(key) ?? null,
      setItem: (key, value) => themeCache.set(key, String(value)),
    },
    window,
  });

  for (const file of ["shared/core.js", "blocked/blocked.js"]) {
    const source = readFileSync(join(__dirname, "..", "..", "src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  readyListener();
  await new Promise((resolve) => setImmediate(resolve));

  return {
    context,
    documentElement,
    elements,
    get historyBackCount() { return historyBackCount; },
    location,
    redirects,
    storageListener,
    themeCache,
  };
}

test("loads the saved theme and reacts to color-mode changes", async () => {
  const page = await loadBlockPage({ storedSettings: { theme: "light" } });
  assert.equal(page.documentElement.getAttribute("data-theme"), "light");
  assert.equal(page.themeCache.get("frontfilter-theme"), "light");

  page.storageListener({ theme: { oldValue: "light", newValue: "dark" } }, "local");
  assert.equal(page.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(page.themeCache.get("frontfilter-theme"), "dark");

  page.storageListener({ theme: { oldValue: "dark" } }, "local");
  assert.equal(page.documentElement.getAttribute("data-theme"), "system");
  assert.equal(page.themeCache.get("frontfilter-theme"), "system");
});

test("renders the blocked target and applied filter from the query string", async () => {
  const { elements } = await loadBlockPage({
    search: "?subreddit=firefox&filter=fire*",
  });

  assert.equal(elements["block-message"].textContent, "r/firefox is blocked");
  assert.equal(elements["block-reason"].hidden, false);
  assert.equal(elements["block-reason"].children[0].textContent, "Applied filter: ");
  assert.equal(elements["block-reason"].children[1].textContent, "fire*");
});

test("renders a DNR-blocked subreddit using the original URL fragment", async () => {
  const { elements } = await loadBlockPage({
    hash: "#https://www.reddit.com/r/firefox/comments/abc/title?tl=it",
    search: "?target=subreddit&filter=fire*",
  });

  assert.equal(elements["block-message"].textContent, "r/firefox is blocked");
  assert.equal(elements["block-reason"].children[1].textContent, "fire*");
});

test("renders known page messages and a safe fallback for unknown pages", async () => {
  const popular = await loadBlockPage({ search: "?page=popular" });
  const explore = await loadBlockPage({ search: "?page=explore" });
  const news = await loadBlockPage({ search: "?page=news" });
  const unknown = await loadBlockPage({ search: "?page=unexpected" });

  assert.equal(popular.elements["block-message"].textContent, "Popular page is blocked");
  assert.equal(explore.elements["block-message"].textContent, "Explore page is blocked");
  assert.equal(news.elements["block-message"].textContent, "News page is blocked");
  assert.equal(unknown.elements["block-message"].textContent, "This content is blocked");
});

test("rejects non-web return URLs even when the hostname is Reddit", async () => {
  const { context } = await loadBlockPage();
  assert.equal(context.getSafeReturnUrl("ftp://reddit.com/r/firefox"), "");
  assert.equal(
    context.getSafeReturnUrl("https://old.reddit.com/r/firefox"),
    "https://old.reddit.com/r/firefox",
  );
});

test("falls back to standalone settings when the background reports failure", async () => {
  const { elements, location } = await loadBlockPage({
    hash: "#https://www.reddit.com/r/firefox/comments/abc/title",
    search: "?target=subreddit",
    sendMessage: async () => ({ success: false, error: "tabs unavailable" }),
  });

  await elements["go-to-settings"].click();
  assert.equal(
    location.href,
    "moz-extension://frontfilter/popup/index.html?standalone=true&currentSubreddit=firefox",
  );
});

test("keeps the block page open when settings open successfully", async () => {
  const messages = [];
  const { elements, location } = await loadBlockPage({
    hash: "#https://www.reddit.com/r/firefox/comments/abc/title",
    search: "?target=subreddit",
    sendMessage: async (message) => {
      messages.push(message);
      return { success: true };
    },
  });

  await elements["go-to-settings"].click();

  assert.equal(location.href, "moz-extension://frontfilter/blocked/index.html");
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    action: "openSettings",
    currentSubreddit: "firefox",
  }]);
});

test("goes back when history exists and otherwise returns to Reddit", async () => {
  const withHistory = await loadBlockPage({ historyLength: 2 });
  await withHistory.elements["go-back"].click();
  assert.equal(withHistory.historyBackCount, 1);

  const withoutHistory = await loadBlockPage({ historyLength: 1 });
  await withoutHistory.elements["go-back"].click();
  assert.equal(withoutHistory.location.href, "https://www.reddit.com");
});

test("uses standalone settings when the no-history fallback homepage is blocked", async () => {
  const page = await loadBlockPage({
    historyLength: 1,
    storedSettings: { blockHomepage: true },
  });

  await page.elements["go-back"].click();

  assert.equal(
    page.location.href,
    "moz-extension://frontfilter/popup/index.html?standalone=true",
  );
});

test("restores the original Reddit URL after a local setting unblocks it", async () => {
  const returnUrl = "https://www.reddit.com/news";
  const page = await loadBlockPage({
    search: `?page=news&returnUrl=${encodeURIComponent(returnUrl)}`,
    storedSettings: {},
  });

  page.storageListener({}, "sync");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(page.redirects, []);

  page.storageListener({}, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(page.redirects, [returnUrl]);
});

test("does not restore a URL that remains blocked by route settings", async () => {
  const returnUrl = "https://www.reddit.com/r/firefox";
  const routeBlocked = await loadBlockPage({
    search: `?subreddit=firefox&returnUrl=${encodeURIComponent(returnUrl)}`,
    storedSettings: {
      blockedSubreddits: [{ name: "firefox", mode: "home" }],
    },
  });
  routeBlocked.storageListener({}, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(routeBlocked.redirects, []);
});
