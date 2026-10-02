const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { loadPage, readSource, runScripts, settle } = require("./helpers");

async function loadBlockPage({
  historyLength = 1,
  hash = "",
  search = "",
  sendMessage = async () => ({ success: true }),
  storedSettings = {},
} = {}) {
  const page = loadPage("blocked/index.html");
  const writes = [];
  const removals = [];
  const replacedUrls = [];
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
  const chrome = {
    runtime: {
      getURL: (path) => `moz-extension://frontfilter/${path}`,
      sendMessage,
    },
    storage: {
      local: {
        get: async () => storedSettings,
        async set(values) {
          writes.push(JSON.parse(JSON.stringify(values)));
          Object.assign(storedSettings, values);
        },
        async remove(key) {
          removals.push(key);
          delete storedSettings[key];
        },
      },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
  };
  const window = {
    history: {
      back() { historyBackCount += 1; },
      length: historyLength,
      replaceState: (_state, _title, url) => replacedUrls.push(url),
    },
    location,
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    chrome,
    console,
    document: page.document,
    localStorage: {
      getItem: (key) => themeCache.get(key) ?? null,
      setItem: (key, value) => themeCache.set(key, String(value)),
    },
    window,
  });

  runScripts(context, ["shared/theme-bootstrap.js", "shared/core.js", "blocked/blocked.js"]);
  page.ready();
  await settle();

  return {
    context,
    documentElement: page.document.documentElement,
    elements: page.elements,
    get historyBackCount() { return historyBackCount; },
    location,
    redirects,
    replacedUrls,
    storageListener,
    themeCache,
    writes,
    removals,
    storedSettings,
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

test("renders the blocked subreddit and the pattern rule that blocks it", async () => {
  const { elements } = await loadBlockPage({
    hash: "#https://www.reddit.com/r/other/",
    search: "?target=subreddit&subreddit=firefox&filter=fire*",
  });

  assert.equal(elements["block-message"].textContent, "r/firefox is blocked");
  assert.equal(elements["block-reason"].hidden, false);
  assert.equal(elements["block-reason"].textContent, "Blocked by the rule fire*");
  assert.equal(elements["block-reason"].querySelector("strong").textContent, "fire*");
});

test("names the rule only when it is not the subreddit's own name", async () => {
  const exact = await loadBlockPage({ search: "?target=subreddit&subreddit=firefox&filter=firefox" });
  assert.equal(exact.elements["block-message"].textContent, "r/firefox is blocked");
  assert.equal(exact.elements["block-reason"].hidden, true);

  const page = await loadBlockPage({ search: "?page=subhome" });
  assert.equal(page.elements["block-message"].textContent, "Subreddit front pages are blocked");
  assert.equal(page.elements["block-reason"].hidden, true);
});

test("reads the subreddit from the blocked URL when navigation rules redirect", async () => {
  const { elements } = await loadBlockPage({
    hash: "#https://www.reddit.com/r/firefox/comments/abc/title?tl=it",
    search: "?target=subreddit&filter=fire*",
  });

  assert.equal(elements["block-message"].textContent, "r/firefox is blocked");
  assert.equal(elements["block-reason"].querySelector("strong").textContent, "fire*");
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
    hash: `#${returnUrl}`,
    search: "?page=news",
    storedSettings: {},
  });

  page.storageListener({}, "sync");
  await settle();
  assert.deepEqual(page.redirects, []);

  page.storageListener({}, "local");
  await settle();
  assert.deepEqual(page.redirects, [returnUrl]);
});

test("does not restore a URL that remains blocked by route settings", async () => {
  const returnUrl = "https://www.reddit.com/r/firefox";
  const routeBlocked = await loadBlockPage({
    hash: `#${returnUrl}`,
    search: "?target=subreddit",
    storedSettings: {
      blockedSubreddits: [{ name: "firefox", mode: "home" }],
    },
  });
  routeBlocked.storageListener({}, "local");
  await settle();
  assert.deepEqual(routeBlocked.redirects, []);
});

const returnUrl = "https://www.reddit.com/r/news/";
const undoPage = (token) => ({
  hash: `#${returnUrl}`,
  search: `?target=subreddit&filter=news&undo=${token}`,
});
const undoMarker = (overrides = {}) => ({
  quickBlockUndo: { subreddit: "news", token: "abc123", expires: Date.now() + 10000, ...overrides },
});

test("offers to undo a one-click block once and returns to the subreddit", async () => {
  const page = await loadBlockPage({
    ...undoPage("abc123"),
    storedSettings: {
      blockedSubreddits: [{ name: "news", mode: "all" }, { name: "pics", mode: "all" }],
      ...undoMarker(),
    },
  });
  const undo = page.elements["undo-block"];

  assert.equal(undo.hidden, false);
  // The marker is spent at once and the token leaves the address, so a
  // reload or a later visit cannot offer the undo again.
  assert.deepEqual(page.removals, ["quickBlockUndo"]);
  assert.equal("quickBlockUndo" in page.storedSettings, false);
  assert.deepEqual(page.replacedUrls, [`?target=subreddit&filter=news#${returnUrl}`]);

  await undo.click();
  assert.deepEqual(page.writes, [{ blockedSubreddits: [{ name: "pics", mode: "all" }] }]);
  page.storageListener({ blockedSubreddits: {} }, "local");
  await settle();
  assert.deepEqual(page.redirects, [returnUrl]);
});

test("undoing a one-click block that upgraded a HOME rule restores that rule", async () => {
  const page = await loadBlockPage({
    ...undoPage("abc123"),
    storedSettings: {
      blockedSubreddits: [{ name: "news", mode: "all" }, { name: "pics", mode: "all" }],
      ...undoMarker({ previousMode: "home" }),
    },
  });

  await page.elements["undo-block"].click();
  assert.deepEqual(page.writes, [{
    blockedSubreddits: [{ name: "news", mode: "home" }, { name: "pics", mode: "all" }],
  }]);
});

test("does not offer an undo when the token is wrong, spent, expired or for another subreddit", async () => {
  for (const [label, token, storedSettings] of [
    ["wrong token", "forged", undoMarker()],
    ["spent marker", "abc123", {}],
    ["expired marker", "abc123", undoMarker({ expires: Date.now() - 1 })],
    ["other subreddit", "abc123", undoMarker({ subreddit: "pics" })],
  ]) {
    const page = await loadBlockPage({ ...undoPage(token), storedSettings });
    assert.equal(page.elements["undo-block"].hidden, true, label);
    assert.equal("quickBlockUndo" in page.storedSettings, false, label);
  }
});

test("does not offer an undo when visiting an already blocked subreddit", async () => {
  const page = await loadBlockPage({
    hash: `#${returnUrl}`,
    search: "?target=subreddit&filter=news",
    storedSettings: undoMarker(),
  });
  assert.equal(page.elements["undo-block"].hidden, true);
  assert.deepEqual(page.replacedUrls, []);
  assert.deepEqual(page.removals, []);
});

test("keeps hidden action buttons out of the layout", () => {
  // .btn sets display, which would otherwise override the hidden attribute
  // and show the undo button on every block page.
  assert.match(readSource("blocked/blocked.css"), /\.btn\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  assert.equal(loadPage("blocked/index.html").elements["undo-block"].hidden, true);
});
