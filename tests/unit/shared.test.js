const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadShared(overrides = {}) {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    console,
    ...overrides,
  });
  const source = readFileSync(
    join(__dirname, "..", "..", "src", "shared", "core.js"),
    "utf8",
  );
  vm.runInContext(source, context, { filename: "shared/core.js" });
  return context.FrontFilter;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const FrontFilter = loadShared();

test("exposes the immutable Reddit listing-sort vocabulary", () => {
  assert.deepEqual(
    Array.from(FrontFilter.LISTING_SORTS),
    ["best", "hot", "new", "top", "rising", "controversial"],
  );
  assert.equal(Object.isFrozen(FrontFilter.LISTING_SORTS), true);
});

test("normalizes subreddit names and Reddit URLs", () => {
  assert.equal(FrontFilter.normalizeSubredditName(" r/JavaScript/ "), "javascript");
  assert.equal(
    FrontFilter.normalizeSubredditName("https://old.reddit.com/r/Firefox/?sort=top"),
    "firefox",
  );
  assert.equal(FrontFilter.normalizeSubredditName("*News**"), "*news*");
  assert.equal(FrontFilter.normalizeSubredditName("https://example.com/r/firefox"), "");
});

test("rejects invalid subreddit values and normalizes bare Reddit hosts", () => {
  assert.equal(FrontFilter.normalizeSubredditName("reddit.com/r/Firefox/comments/123"), "firefox");
  assert.equal(FrontFilter.normalizeSubredditName("https://reddit.com/"), "");
  assert.equal(FrontFilter.normalizeSubredditName("***"), "");
  assert.equal(FrontFilter.normalizeSubredditName(42), "");
});

test("matches exact names and wildcard patterns", () => {
  assert.equal(FrontFilter.matchesSubredditPattern("firefox", "Firefox"), true);
  assert.equal(FrontFilter.matchesSubredditPattern("*news*", "worldnews"), true);
  assert.equal(FrontFilter.matchesSubredditPattern("news*", "worldnews"), false);
  assert.equal(FrontFilter.matchesSubredditPattern("*", "worldnews"), false);
  assert.equal(FrontFilter.matchesSubredditPattern("", "worldnews"), false);
});

test("normalizes, migrates and deduplicates blocked entries", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeBlockedSubreddits([
      "Firefox",
      { name: "firefox", mode: "home" },
      { name: "javascript", mode: "all" },
      { name: "javascript", mode: "invalid" },
    ]))),
    [
      { name: "firefox", mode: "home" },
      { name: "javascript", mode: "all" },
      { name: "javascript", mode: "home" },
    ],
  );
});

test("normalizes exact subreddit exceptions and rejects wildcard entries", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeAllowedSubreddits([
      "ItalyPersonalFinance",
      "r/italypersonalfinance",
      "https://www.reddit.com/r/AllowedSub/comments/abc/post",
      "*italy*",
      "",
      null,
    ]))),
    ["italypersonalfinance", "allowedsub"],
  );
  assert.equal(
    FrontFilter.isSubredditAllowed("ITALYPERSONALFINANCE", ["italypersonalfinance"]),
    true,
  );
  assert.equal(FrontFilter.isSubredditAllowed("italy", ["italypersonalfinance"]), false);
});

test("normalizes post keywords and matches literal text case-insensitively", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeTitleKeywords([
      "  Trump  ",
      "TRUMP",
      "climate   change",
      "",
      null,
    ]))),
    ["Trump", "climate change"],
  );
  assert.equal(
    FrontFilter.textMatchesKeywords("Latest\n  TRUMP headline", ["Trump headline"]),
    true,
  );
  assert.equal(
    FrontFilter.textMatchesKeywords("Save [50%] today", ["[50%]"]),
    true,
  );
  assert.equal(FrontFilter.textMatchesKeywords("Other news", ["Trump"]), false);
});

test("coerces settings without retaining unknown keys", () => {
  const settings = FrontFilter.coerceSettings({
    blockHomepage: true,
    blockAll: true,
    blockNew: true,
    blockTop: true,
    blockNsfw: true,
    unknown: true,
  });

  assert.equal(settings.blockHomepage, true);
  assert.equal("blockAll" in settings, false);
  assert.equal("blockNew" in settings, false);
  assert.equal("blockTop" in settings, false);
  assert.equal("blockNsfw" in settings, false);
  assert.equal("unknown" in settings, false);
});

test("does not read settings inherited through an object's prototype", () => {
  const values = Object.create({ blockHomepage: true });
  assert.equal(FrontFilter.coerceSettings(values).blockHomepage, false);
});

test("reports malformed recognized settings for strict import validation", () => {
  assert.deepEqual(
    Array.from(FrontFilter.getInvalidSettingKeys({
      blockHomepage: "true",
      blockedSubreddits: [{ name: "firefox", mode: "invalid" }],
      allowedSubreddits: ["*news*"],
      blockedTitleKeywords: [""],
      scrollLimit: 0,
      theme: "auto",
      unknown: true,
    })),
    [
      "blockedSubreddits",
      "allowedSubreddits",
      "blockedTitleKeywords",
      "blockHomepage",
      "scrollLimit",
      "theme",
    ],
  );
});

test("returns independent filter collections for each config", () => {
  const first = FrontFilter.coerceSettings();
  first.blockedSubreddits.push({ name: "firefox", mode: "all" });
  first.allowedSubreddits.push("javascript");
  first.blockedTitleKeywords.push("Trump");

  const second = FrontFilter.coerceSettings();

  assert.deepEqual(JSON.parse(JSON.stringify(second.blockedSubreddits)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(second.allowedSubreddits)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(second.blockedTitleKeywords)), []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.DEFAULT_SETTINGS.blockedSubreddits)),
    [],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.DEFAULT_SETTINGS.allowedSubreddits)),
    [],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.DEFAULT_SETTINGS.blockedTitleKeywords)),
    [],
  );
});

test("rejects malformed stored values instead of throwing or enabling flags", () => {
  assert.doesNotThrow(() => FrontFilter.coerceSettings(null));
  assert.doesNotThrow(() => FrontFilter.coerceSettings({ blockedSubreddits: {} }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.coerceSettings({
      blockedSubreddits: "firefox",
      blockHomepage: "false",
    }))),
    {
      blockedSubreddits: [],
      allowedSubreddits: [],
      blockedTitleKeywords: [],
      blockHomepage: false,
      blockPopular: false,
      blockExplore: false,
      blockNews: false,
      blockSubHome: false,
      hideComments: false,
      hideCommentReplies: false,
      disableAutoplay: false,
      hideSuggestedCommunities: false,
      hideNavbar: false,
      hideNavbarMenu: false,
      hideNavbarSearch: false,
      hideNavbarChat: false,
      hideNavbarNotifications: false,
      hideNavbarProfile: false,
      hideNavbarOthers: false,
      hideLeftSidebar: false,
      hideLeftSidebarGames: false,
      hideLeftSidebarCustomFeeds: false,
      hideLeftSidebarRecent: false,
      hideLeftSidebarCommunities: false,
      hideLeftSidebarResources: false,
      hideRelatedPosts: false,
      limitInfiniteScroll: false,
      scrollLimit: 25,
      scrollMode: "fixed",
      theme: "system",
    },
  );
});

test("applies only known local-storage changes", () => {
  const settings = FrontFilter.applyStorageChanges(
    { blockHomepage: true, blockPopular: true },
    {
      blockHomepage: { oldValue: true, newValue: false },
      unknown: { newValue: true },
    },
  );

  assert.equal(settings.blockHomepage, false);
  assert.equal(settings.blockPopular, true);
  assert.equal("unknown" in settings, false);
});

test("resets a setting to its default when it is removed from storage", () => {
  const settings = FrontFilter.applyStorageChanges(
    { blockHomepage: true, blockedSubreddits: [{ name: "firefox", mode: "all" }] },
    {
      blockHomepage: { oldValue: true },
      blockedSubreddits: { oldValue: [{ name: "firefox", mode: "all" }] },
    },
  );

  assert.equal(settings.blockHomepage, false);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.blockedSubreddits)), []);
});

test("settings store preserves changes received during its initial load", async () => {
  const initialSettings = deferred();
  let readCount = 0;
  const store = FrontFilter.createSettingsStore({
    get() {
      readCount += 1;
      return initialSettings.promise;
    },
  });

  const firstLoad = store.load();
  const concurrentLoad = store.load();
  store.applyChanges({
    blockHomepage: { oldValue: true, newValue: false },
  });
  initialSettings.resolve({ blockHomepage: true, blockPopular: true });

  assert.equal(firstLoad, concurrentLoad);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await firstLoad)),
    {
      blockedSubreddits: [],
      allowedSubreddits: [],
      blockedTitleKeywords: [],
      blockHomepage: false,
      blockPopular: true,
      blockExplore: false,
      blockNews: false,
      blockSubHome: false,
      hideComments: false,
      hideCommentReplies: false,
      disableAutoplay: false,
      hideSuggestedCommunities: false,
      hideNavbar: false,
      hideNavbarMenu: false,
      hideNavbarSearch: false,
      hideNavbarChat: false,
      hideNavbarNotifications: false,
      hideNavbarProfile: false,
      hideNavbarOthers: false,
      hideLeftSidebar: false,
      hideLeftSidebarGames: false,
      hideLeftSidebarCustomFeeds: false,
      hideLeftSidebarRecent: false,
      hideLeftSidebarCommunities: false,
      hideLeftSidebarResources: false,
      hideRelatedPosts: false,
      limitInfiniteScroll: false,
      scrollLimit: 25,
      scrollMode: "fixed",
      theme: "system",
    },
  );
  await store.load();
  assert.equal(readCount, 1);
});

test("settings store keeps valid updates when its initial load fails", async () => {
  const errors = [];
  const store = FrontFilter.createSettingsStore(
    { get: async () => { throw new Error("storage unavailable"); } },
    { onLoadError: (error) => errors.push(error.message) },
  );
  store.applyChanges({ blockNews: { newValue: true } });

  const settings = await store.load();

  assert.equal(settings.blockNews, true);
  assert.deepEqual(errors, ["storage unavailable"]);
});

test("hiding all comments implies hiding replies, but replies can be hidden alone", () => {
  const allComments = FrontFilter.coerceSettings({
    hideComments: true,
    hideCommentReplies: false,
  });
  assert.equal(allComments.hideComments, true);
  assert.equal(allComments.hideCommentReplies, true);

  const repliesOnly = FrontFilter.coerceSettings({
    hideComments: false,
    hideCommentReplies: true,
  });
  assert.equal(repliesOnly.hideComments, false);
  assert.equal(repliesOnly.hideCommentReplies, true);
});

test("hiding the navbar implies every section, but sections remain independent", () => {
  const sectionKeys = [
    "hideNavbarMenu",
    "hideNavbarSearch",
    "hideNavbarChat",
    "hideNavbarNotifications",
    "hideNavbarProfile",
    "hideNavbarOthers",
  ];
  const allNavbar = FrontFilter.coerceSettings({
    hideNavbar: true,
    ...Object.fromEntries(sectionKeys.map((key) => [key, false])),
  });
  assert.equal(allNavbar.hideNavbar, true);
  for (const key of sectionKeys) assert.equal(allNavbar[key], true);

  const searchOnly = FrontFilter.coerceSettings({
    hideNavbar: false,
    hideNavbarSearch: true,
  });
  assert.equal(searchOnly.hideNavbar, false);
  assert.equal(searchOnly.hideNavbarSearch, true);
  for (const key of sectionKeys.filter((key) => key !== "hideNavbarSearch")) {
    assert.equal(searchOnly[key], false);
  }
});

test("hiding the left sidebar implies every section, but sections remain independent", () => {
  const sectionKeys = [
    "hideLeftSidebarGames",
    "hideLeftSidebarCustomFeeds",
    "hideLeftSidebarRecent",
    "hideLeftSidebarCommunities",
    "hideLeftSidebarResources",
  ];
  const allSidebar = FrontFilter.coerceSettings({
    hideLeftSidebar: true,
    ...Object.fromEntries(sectionKeys.map((key) => [key, false])),
  });
  assert.equal(allSidebar.hideLeftSidebar, true);
  for (const key of sectionKeys) assert.equal(allSidebar[key], true);

  const gamesOnly = FrontFilter.coerceSettings({
    hideLeftSidebar: false,
    hideLeftSidebarGames: true,
  });
  assert.equal(gamesOnly.hideLeftSidebar, false);
  assert.equal(gamesOnly.hideLeftSidebarGames, true);
  for (const key of sectionKeys.slice(1)) assert.equal(gamesOnly[key], false);
});

test("accepts only HTTP(S) Reddit URLs", () => {
  assert.equal(
    FrontFilter.getRedditUrl("/r/firefox", "https://old.reddit.com").href,
    "https://old.reddit.com/r/firefox",
  );
  assert.equal(FrontFilter.getRedditUrl("https://example.com/r/firefox"), null);
  assert.equal(FrontFilter.getRedditUrl("ftp://reddit.com/r/firefox"), null);
  assert.equal(FrontFilter.getRedditUrl("https://reddit.com.evil.example/r/firefox"), null);
  assert.equal(FrontFilter.getRedditUrl("not a URL"), null);
});

test("parses subreddit paths and their remaining segments", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.getSubredditPath("/r/Firefox/TOP/week/"))),
    { name: "firefox", rest: "top/week" },
  );
  assert.equal(FrontFilter.getSubredditPath("/user/firefox"), null);
  assert.equal(FrontFilter.getSubredditPath("/r/***"), null);
  assert.equal(FrontFilter.getSubredditPath(null), null);
});

test("recognizes page and subreddit blocking routes", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.getBlockedRoute("/r/popular/new", {
      blockPopular: true,
    }))),
    { type: "page", page: "popular", filter: "r/popular" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", {
      blockedSubreddits: [{ name: "fire*", mode: "all" }],
    }))),
    { type: "subreddit", subreddit: "firefox", filter: "fire*" },
  );
  assert.equal(
    FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", {
      blockedSubreddits: [{ name: "firefox", mode: "home" }],
    }),
    null,
  );
});

test("subreddit exceptions override global fronts and wildcard block rules", () => {
  const settings = {
    blockSubHome: true,
    blockedSubreddits: [{ name: "*italy*", mode: "all" }],
    allowedSubreddits: ["ItalyPersonalFinance"],
  };

  for (const pathname of [
    "/r/italypersonalfinance",
    "/r/ItalyPersonalFinance/top/?t=week",
    "/r/italypersonalfinance/comments/abc/post",
  ]) {
    assert.equal(FrontFilter.getBlockedRoute(pathname, settings), null, pathname);
  }
  assert.equal(
    FrontFilter.getBlockedRoute("/r/italytravel", settings)?.filter,
    "All Sub Fronts",
  );
  assert.equal(
    FrontFilter.getBlockedRoute("/r/italytravel/comments/abc/post", settings)?.filter,
    "*italy*",
  );
});

test("global page blocks take precedence over subreddit exceptions", () => {
  const route = FrontFilter.getBlockedRoute("/r/popular", {
    blockPopular: true,
    blockSubHome: true,
    blockedSubreddits: [{ name: "popular", mode: "all" }],
    allowedSubreddits: ["popular"],
  });

  assert.equal(route?.page, "popular");
});

test("covers every main-page route without matching similar paths", () => {
  const cases = [
    ["/", { blockHomepage: true }, "homepage"],
    ["/new", { blockHomepage: true }, "homepage"],
    ["/top/", { blockHomepage: true }, "homepage"],
    ["/r/popular/new", { blockPopular: true }, "popular"],
    ["/explore/topics", { blockExplore: true }, "explore"],
    ["/news/world", { blockNews: true }, "news"],
  ];

  for (const [pathname, settings, page] of cases) {
    assert.equal(FrontFilter.getBlockedRoute(pathname, settings).page, page);
  }

  assert.equal(FrontFilter.getBlockedRoute("/explorer", { blockExplore: true }), null);
  assert.equal(FrontFilter.getBlockedRoute("/newsletter", { blockNews: true }), null);
  assert.equal(FrontFilter.getBlockedRoute("/newest", { blockHomepage: true }), null);
});

test("distinguishes subreddit fronts from posts for HOME and ALL modes", () => {
  const homeSettings = {
    blockedSubreddits: [{ name: "firefox", mode: "home" }],
  };

  for (const pathname of ["/r/firefox", "/r/firefox/hot", "/r/firefox/top/week"]) {
    assert.equal(FrontFilter.getBlockedRoute(pathname, homeSettings)?.subreddit, "firefox");
  }
  assert.equal(
    FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", homeSettings),
    null,
  );
  assert.equal(
    FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", {
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    })?.subreddit,
    "firefox",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.getBlockedRoute("/r/firefox/rising", {
      blockSubHome: true,
    }))),
    {
      type: "page",
      page: "subhome",
      subreddit: "firefox",
      filter: "All Sub Fronts",
    },
  );
});

test("serializes block details into a query string", () => {
  const query = FrontFilter.blockedRouteToQuery(
    { type: "subreddit", subreddit: "firefox", filter: "fire*" },
    "https://www.reddit.com/r/firefox",
  );
  const params = new URLSearchParams(query);

  assert.equal(params.get("subreddit"), "firefox");
  assert.equal(params.get("filter"), "fire*");
  assert.equal(params.get("returnUrl"), "https://www.reddit.com/r/firefox");
  assert.equal(FrontFilter.blockedRouteToQuery(null), "");
});

test("normalizes typed scroll settings and resets removed values", () => {
  assert.equal(FrontFilter.coerceSettings({ scrollLimit: 1 }).scrollLimit, 1);
  for (const value of [0, -1, 2.5, "10", null, true, Infinity, NaN, 2 ** 53]) {
    assert.equal(FrontFilter.coerceSettings({ scrollLimit: value }).scrollLimit, 25);
  }
  assert.equal(FrontFilter.coerceSettings({ scrollMode: "button" }).scrollMode, "button");
  assert.equal(FrontFilter.coerceSettings({ scrollMode: "other" }).scrollMode, "fixed");
  const settings = FrontFilter.applyStorageChanges({ scrollLimit: 10, scrollMode: "button" }, {
    scrollLimit: { oldValue: 10 }, scrollMode: { oldValue: "button" },
  });
  assert.equal(settings.scrollLimit, 25);
  assert.equal(settings.scrollMode, "fixed");
});

test("normalizes color themes and resets removed themes to system", () => {
  for (const theme of ["system", "dark", "light"]) {
    assert.equal(FrontFilter.normalizeTheme(theme), theme);
    assert.equal(FrontFilter.coerceSettings({ theme }).theme, theme);
  }
  for (const theme of ["white", "auto", "", null, true]) {
    assert.equal(FrontFilter.normalizeTheme(theme), "system");
    assert.equal(FrontFilter.coerceSettings({ theme }).theme, "system");
  }

  const settings = FrontFilter.applyStorageChanges(
    { theme: "dark" },
    { theme: { oldValue: "dark" } },
  );
  assert.equal(settings.theme, "system");
});

test("limits listing routes without treating comments, wiki or settings as feeds", () => {
  for (const path of [
    "/", "/best", "/hot", "/new", "/top", "/rising", "/controversial",
    "/r/popular/", "/r/firefox", "/r/firefox/new/",
  ]) {
    assert.equal(FrontFilter.isFeedPath(path), true, path);
  }
  for (const path of [
    "/r/firefox/comments/abc/post", "/r/firefox/wiki", "/settings",
    "/message/inbox", "/r/firefox/top/extra",
  ]) {
    assert.equal(FrontFilter.isFeedPath(path), false, path);
  }
});
