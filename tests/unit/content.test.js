const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function loadContent({ querySelectorAll = () => [], settings, startUrl }) {
  const redirects = [];
  const injectedStyles = [];
  const location = {
    href: startUrl,
    origin: new URL(startUrl).origin,
    pathname: new URL(startUrl).pathname,
    replace(url) {
      redirects.push(url);
    },
  };
  const document = {
    body: {},
    documentElement: { appendChild(style) { injectedStyles.push(style); } },
    createElement: () => ({ id: "", style: {}, textContent: "" }),
    getElementById: (id) => injectedStyles.find((style) => style.id === id) || null,
    querySelectorAll(selector) {
      queriedSelectors.push(selector);
      return querySelectorAll(selector);
    },
  };
  const queriedSelectors = [];
  const observerOptions = [];
  const storageListeners = [];
  const chrome = {
    storage: {
      local: { get: async () => settings },
      onChanged: { addListener: (listener) => storageListeners.push(listener) },
    },
    runtime: {
      getURL: (path) => `moz-extension://frontfilter/${path}`,
    },
  };
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(_target, options) { observerOptions.push({ ...options }); }
  }
  const window = {
    location,
    addEventListener() {},
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    chrome,
    console,
    document,
    MutationObserver,
    requestAnimationFrame: (callback) => callback(),
    setInterval: () => 0,
    window,
  });

  // This harness isolates legacy filtering. The limiter has its own DOM tests.
  vm.runInContext(`
    var FrontFilterFeedStub = {
      updateCount: 0,
      update() { this.updateCount += 1; },
    };
  `, context);

  for (const file of ["shared/core.js", "content/post-elements.js", "content/main.js"]) {
    const source = readFileSync(join(__dirname, "..", "..", "src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
    if (file === "shared/core.js") {
      vm.runInContext('FrontFilter.createFeedLimiter = () => FrontFilterFeedStub;', context);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));

  return {
    checkCurrentPage: context.checkCurrentPage,
    getFeedLimiterUpdateCount: () => context.FrontFilterFeedStub.updateCount,
    processFilteredContent: context.processFilteredContent,
    location,
    redirects,
    storageListeners,
    queriedSelectors,
    observerOptions,
    injectedStyles,
  };
}

function createPost({ subreddit = "", title = "" } = {}) {
  return {
    dataset: {},
    getAttribute(name) {
      if (name === "data-subreddit") return subreddit;
      if (name === "post-title") return title;
      return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function createMediaElement({ attributes = [], localName, paused = true, shadowVideos = [] }) {
  const values = new Map(attributes.map((name) => [name, ""]));
  return {
    autoplay: values.has("autoplay"),
    localName,
    tagName: localName.toUpperCase(),
    paused,
    pauseCount: 0,
    shadowRoot: shadowVideos.length > 0 ? {
      querySelectorAll: (selector) => selector === "video" ? shadowVideos : [],
    } : null,
    getAttribute(name) {
      return values.get(name) ?? null;
    },
    hasAttribute(name) {
      return values.has(name);
    },
    pause() {
      this.paused = true;
      this.pauseCount += 1;
    },
    removeAttribute(name) {
      values.delete(name);
    },
    setAttribute(name, value) {
      values.set(name, String(value));
    },
  };
}

function isPostCollectionSelector(selector) {
  return selector.includes('[data-testid="post-container"]')
    && selector.includes('[data-click-id="body"]');
}

test("does not scan the Reddit DOM when feed filters are inactive", async () => {
  const content = await loadContent({
    fetch: async () => ({ ok: false }),
    settings: {},
    startUrl: "https://www.reddit.com/",
  });

  assert.deepEqual(content.queriedSelectors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(content.observerOptions.at(-1))),
    { childList: true, subtree: true },
  );
  assert.doesNotMatch(content.injectedStyles[0].textContent, /shreddit-comment/);
  assert.doesNotMatch(content.injectedStyles[0].textContent, /reddit-header|#header/);
  assert.doesNotMatch(content.injectedStyles[0].textContent, /LeftNavGamesSection/);
  assert.doesNotMatch(content.injectedStyles[0].textContent, /pdp-right-rail/);
});

test("observes attributes and text only while a matching filter needs them", async () => {
  const content = await loadContent({
    settings: { blockedTitleKeywords: ["news"] },
    startUrl: "https://www.reddit.com/",
  });

  const activeOptions = content.observerOptions.at(-1);
  assert.equal(activeOptions.attributes, true);
  assert.equal(activeOptions.characterData, true);
  assert.ok(activeOptions.attributeFilter.includes("post-title"));
  assert.ok(activeOptions.attributeFilter.includes("data-subreddit-prefixed"));

  content.storageListeners[0]({
    blockedTitleKeywords: { oldValue: ["news"], newValue: [] },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    JSON.parse(JSON.stringify(content.observerOptions.at(-1))),
    { childList: true, subtree: true },
  );
});

test("ignores legacy translation settings on load, storage changes and SPA navigations", async () => {
  const content = await loadContent({
    settings: { disableAutoTranslation: true },
    startUrl: "https://www.reddit.com/r/firefox/?tl=it#comments",
  });
  assert.deepEqual(content.redirects, []);
  content.storageListeners[0]({ disableAutoTranslation: { newValue: true } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(content.redirects, []);

  content.location.href = "https://www.reddit.com/r/javascript/?tl=ja&sort=top";
  content.location.pathname = "/r/javascript/";
  await content.checkCurrentPage();
  assert.deepEqual(content.redirects, []);

  content.storageListeners[0]({ disableAutoTranslation: { newValue: false } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(content.redirects, []);
});

test("updates the feed limiter once when an SPA navigation changes the URL", async () => {
  const content = await loadContent({
    settings: { limitInfiniteScroll: true },
    startUrl: "https://www.reddit.com/r/firefox/",
  });
  const initialUpdateCount = content.getFeedLimiterUpdateCount();

  content.location.href = "https://www.reddit.com/r/javascript/";
  content.location.pathname = "/r/javascript/";
  await content.checkCurrentPage();
  assert.equal(content.getFeedLimiterUpdateCount(), initialUpdateCount + 1);

  await content.checkCurrentPage();
  assert.equal(content.getFeedLimiterUpdateCount(), initialUpdateCount + 1);
});

test("blocking rules apply to translated pages", async () => {
  const blocked = await loadContent({
    settings: { blockPopular: true },
    startUrl: "https://www.reddit.com/r/popular?tl=it",
  });
  assert.equal(new URL(blocked.redirects[0]).searchParams.get("page"), "popular");
});

test("loads right-sidebar filtering without reading page text or blocking navigation", async () => {
  const content = await loadContent({
    settings: { hideRelatedPosts: true },
    startUrl: "https://www.reddit.com/r/firefox/comments/abc/post",
    querySelectorAll() { throw new Error("This filter must not scan page text"); },
  });
  const styleText = content.injectedStyles[0].textContent;

  assert.match(styleText, /pdp-right-rail/);
  assert.match(styleText, /#right-sidebar-container/);
  assert.match(styleText, /\.right-sidebar/);
  assert.match(styleText, /\.side,/);
  assert.doesNotMatch(styleText, /listing-below|shreddit-related-posts|#related-posts|aria-label|:lang\(|:has-text\(|shreddit-comment|reddit-header|#left-sidebar/);
  assert.deepEqual(content.redirects, []);
});

test("restores the right sidebar without changing active comment, navbar or post filters", async () => {
  const post = createPost({ subreddit: "firefox" });
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: {
      hideComments: true,
      hideNavbar: true,
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    },
    startUrl: "https://www.reddit.com/",
  });
  const style = content.injectedStyles[0];
  const originalRules = style.textContent;

  for (const enabled of [true, false, true]) {
    content.storageListeners[0]({ hideRelatedPosts: { newValue: enabled } }, "local");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(style.textContent.includes("#right-sidebar-container"), enabled);
    assert.ok(style.textContent.startsWith(originalRules));
    assert.equal(post.dataset.frontfilterPostHidden, "true");
    assert.equal(content.injectedStyles.length, 1);
    assert.deepEqual(content.redirects, []);
  }

  content.storageListeners[0]({ hideRelatedPosts: { oldValue: true } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(style.textContent, originalRules);
});

test("loads navbar hiding as a persistent CSS rule without scanning or redirecting", async () => {
  const content = await loadContent({
    settings: { hideNavbar: true },
    startUrl: "https://www.reddit.com/r/firefox/comments/abc/post",
  });
  const navbarRule = content.injectedStyles[0].textContent.split("\n")[1];

  for (const selector of [
    "#header", "#shreddit-header", "reddit-header-large", "reddit-header-small",
    "shreddit-app > header", 'header[role="banner"]',
  ]) {
    assert.ok(navbarRule.includes(selector));
  }
  assert.match(navbarRule, /\{ display: none !important; \}/);
  assert.doesNotMatch(content.injectedStyles[0].textContent, /shreddit-comment/);
  assert.deepEqual(content.redirects, []);
  assert.deepEqual(content.queriedSelectors, []);
});

test("hides each navbar section without hiding the Reddit logo", async () => {
  const cases = [
    ["hideNavbarMenu", "#navbar-menu-button"],
    ["hideNavbarSearch", "search-dynamic-id-cache-controller"],
    ["hideNavbarChat", '[data-part="chat"]'],
    ["hideNavbarNotifications", '[data-part="inbox"]'],
    ["hideNavbarProfile", "#expand-user-drawer-button"],
  ];

  for (const [setting, selector] of cases) {
    const content = await loadContent({
      settings: { [setting]: true },
      startUrl: "https://www.reddit.com/",
    });
    const styleText = content.injectedStyles[0].textContent;
    assert.ok(styleText.includes(selector), setting);
    if (setting === "hideNavbarMenu") assert.doesNotMatch(styleText, /expand-user-drawer-button/);
    assert.doesNotMatch(styleText, /#reddit-logo/);
    assert.doesNotMatch(styleText, /#shreddit-header, reddit-header-large/);
    assert.deepEqual(content.queriedSelectors, []);
  }
});

test("hide-navbar Others targets logged-in and logged-out residual actions", async () => {
  const content = await loadContent({
    settings: { hideNavbarOthers: true },
    startUrl: "https://www.reddit.com/",
  });
  const styleText = content.injectedStyles[0].textContent;

  assert.match(styleText, /\[data-part\]:not/);
  assert.match(styleText, /data-part="chat"/);
  assert.match(styleText, /data-part="inbox"/);
  assert.match(styleText, /:not\(:has\(#reddit-logo\)\)/);
  for (const selector of [
    "#reddit-logo",
    "#navbar-menu-button",
    "reddit-search-large",
    "#expand-user-drawer-button",
  ]) {
    assert.equal(styleText.includes(` ${selector},`), false, selector);
  }
  assert.doesNotMatch(styleText, /\[data-part="primary"\](?:,| \{)/);
  assert.doesNotMatch(styleText, /\[data-part="secondary"\](?:,| \{)/);
});

test("toggles navbar sections live without collapsing the whole header", async () => {
  const content = await loadContent({
    settings: {},
    startUrl: "https://www.reddit.com/",
  });
  const style = content.injectedStyles[0];
  const baseRules = style.textContent;

  content.storageListeners[0]({
    hideNavbarSearch: { newValue: true },
    hideNavbarNotifications: { newValue: true },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(style.textContent, /search-dynamic-id-cache-controller/);
  assert.match(style.textContent, /data-part="inbox"/);
  assert.doesNotMatch(style.textContent, /--shreddit-header-height: 0px/);

  content.storageListeners[0]({
    hideNavbarSearch: { oldValue: true },
    hideNavbarNotifications: { oldValue: true },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(style.textContent, baseRules);
});

test("hides each left-sidebar section with locale-independent structural rules", async () => {
  const cases = [
    ["hideLeftSidebarGames", "LeftNavGamesSection_", 'noun="games_drawer"'],
    ["hideLeftSidebarCustomFeeds", "LeftNavMultiredditsSection_", 'aria-controls="multireddits_section"'],
    ["hideLeftSidebarRecent", "LeftNavRecentSection_", "#recent-communities-section"],
    ["hideLeftSidebarCommunities", "LeftNavCommunitiesSection_", 'aria-controls="communities_section"'],
    ["hideLeftSidebarResources", "LeftNavResourcesSection_", 'noun="resources_menu"'],
  ];

  for (const [setting, loader, section] of cases) {
    const content = await loadContent({
      settings: { [setting]: true },
      startUrl: "https://www.reddit.com/",
    });
    const styleText = content.injectedStyles[0].textContent;
    assert.ok(styleText.includes(loader), setting);
    assert.ok(styleText.includes(section), setting);
    assert.doesNotMatch(styleText, /#left-sidebar-container, #left-sidebar \{/);
    assert.deepEqual(content.queriedSelectors, []);
  }
});

test("toggles left-sidebar sections live without hiding the whole sidebar", async () => {
  const content = await loadContent({
    settings: {},
    startUrl: "https://www.reddit.com/",
  });
  const style = content.injectedStyles[0];
  const baseRules = style.textContent;

  content.storageListeners[0]({
    hideLeftSidebarGames: { newValue: true },
    hideLeftSidebarResources: { newValue: true },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(style.textContent, /LeftNavGamesSection_/);
  assert.match(style.textContent, /LeftNavResourcesSection_/);
  assert.doesNotMatch(style.textContent, /#left-sidebar-container, #left-sidebar \{/);

  content.storageListeners[0]({
    hideLeftSidebarGames: { oldValue: true },
    hideLeftSidebarResources: { oldValue: true },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(style.textContent, baseRules);
});

test("hides links to blocked main pages from the top left-navigation section", async () => {
  const content = await loadContent({
    settings: { blockNews: true },
    startUrl: "https://www.reddit.com/r/firefox/",
  });
  const style = content.injectedStyles[0];

  assert.match(style.textContent, /#left-sidebar left-nav-top-section/);
  assert.match(style.textContent, /a\[href="\/news" i\]/);
  assert.match(style.textContent, /a\[href\^="\/news\/" i\]/);
  assert.match(style.textContent, /li:has/);
  assert.doesNotMatch(style.textContent, /a\[href="\/explore" i\]/);
  assert.doesNotMatch(style.textContent, /href\^="\/news" i/);
  assert.deepEqual(content.queriedSelectors, ["left-nav-top-section"]);

  content.storageListeners[0]({
    blockNews: { oldValue: true, newValue: false },
    blockExplore: { oldValue: false, newValue: true },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(style.textContent, /a\[href="\/news" i\]/);
  assert.match(style.textContent, /a\[href="\/explore" i\]/);
});

test("hides global feed-sort links and the navbar logo when the homepage is blocked", async () => {
  const content = await loadContent({
    settings: { blockHomepage: true },
    startUrl: "https://www.reddit.com/r/firefox/",
  });
  const style = content.injectedStyles[0];

  for (const sort of ["best", "hot", "new", "top", "rising", "controversial"]) {
    assert.ok(style.textContent.includes(`a[href="/${sort}" i]`), sort);
    assert.ok(style.textContent.includes(`a[href^="/${sort}?" i]`), sort);
  }
  assert.match(style.textContent, /#shreddit-header #reddit-logo/);
  assert.match(style.textContent, /a:has\(#reddit-logo\)/);

  content.storageListeners[0]({
    blockHomepage: { oldValue: true, newValue: false },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(style.textContent, /#reddit-logo/);
});

test("updates blocked main-page links inside the top navigation shadow root", async () => {
  const styles = [];
  const shadowRoot = {
    appendChild(style) {
      styles.push(style);
    },
    querySelector(selector) {
      return styles.find((style) => `#${style.id}` === selector) || null;
    },
  };
  const section = { shadowRoot };
  const content = await loadContent({
    querySelectorAll: (selector) => selector === "left-nav-top-section"
      ? [section]
      : [],
    settings: { blockNews: true },
    startUrl: "https://www.reddit.com/r/firefox/",
  });

  assert.equal(styles.length, 1);
  assert.equal(styles[0].id, "frontfilter-main-page-links-style");
  assert.match(styles[0].textContent, /a\[href="\/news" i\]/);
  assert.doesNotMatch(styles[0].textContent, /#left-sidebar/);

  content.storageListeners[0]({ blockNews: { oldValue: true } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(styles[0].textContent, "");
});

test("toggles navbar and comments independently while retaining feed filters", async () => {
  const post = createPost({ subreddit: "firefox" });
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedSubreddits: [{ name: "firefox", mode: "all" }] },
    startUrl: "https://www.reddit.com/",
  });
  const style = content.injectedStyles[0];
  const originalRules = style.textContent;
  const navbarSectionKeys = [
    "hideNavbarMenu",
    "hideNavbarSearch",
    "hideNavbarChat",
    "hideNavbarNotifications",
    "hideNavbarProfile",
    "hideNavbarOthers",
  ];

  for (const [hideNavbar, hideComments] of [
    [true, false], [true, true], [false, true], [true, true], [true, false],
  ]) {
    content.storageListeners[0]({
      hideNavbar: { newValue: hideNavbar },
      ...Object.fromEntries(navbarSectionKeys.map((key) => [
        key,
        { newValue: hideNavbar },
      ])),
      hideComments: { newValue: hideComments },
      hideCommentReplies: { newValue: hideComments },
    }, "local");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(style.textContent.includes("reddit-header-large"), hideNavbar);
    assert.equal(style.textContent.includes("shreddit-comment"), hideComments);
    assert.ok(style.textContent.startsWith(originalRules));
    assert.equal(post.dataset.frontfilterPostHidden, "true");
    assert.equal(content.injectedStyles.length, 1);
    assert.deepEqual(content.redirects, []);
  }

  content.storageListeners[0]({
    hideNavbar: { oldValue: true },
    ...Object.fromEntries(navbarSectionKeys.map((key) => [
      key,
      { oldValue: true },
    ])),
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(style.textContent, originalRules);
});

test("hides comment layouts and light-DOM feed actions without blocking the post", async () => {
  const content = await loadContent({
    settings: { hideComments: true },
    startUrl: "https://www.reddit.com/r/firefox/comments/abc/post",
  });

  const style = content.injectedStyles[0];
  const commentRule = style.textContent.split("\n")[1];
  for (const selector of [
    "shreddit-comment", "shreddit-comment-tree",
    '[data-testid="comment"]', '[data-testid="comment-tree"]',
    ".Comment", ".comment",
    '[data-action-bar-action="comments"]',
    '[data-post-click-location="comments-button"]',
    '[name="comments-action-button"]',
    '[data-click-id="comments"]', "a.comments",
  ]) {
    assert.ok(commentRule.includes(selector));
  }
  assert.match(commentRule, /\{ display: none !important; \}/);
  assert.deepEqual(content.redirects, []);
  assert.deepEqual(content.queriedSelectors, ["shreddit-post"]);
});

test("hides only nested comment replies while keeping top-level comments and actions", async () => {
  const content = await loadContent({
    settings: { hideCommentReplies: true },
    startUrl: "https://www.reddit.com/r/firefox/comments/abc/post",
  });

  const replyRule = content.injectedStyles[0].textContent.split("\n")[1];
  for (const selector of [
    'shreddit-comment[depth]:not([depth="0"])',
    'shreddit-comment[parent-id^="t1_"]',
    'shreddit-comment [slot="children"]',
    '[data-testid="comment"] [data-testid="comment"]',
    ".Comment .Comment",
    ".comment .comment",
    ".comment > .child",
  ]) {
    assert.ok(replyRule.includes(selector));
  }
  assert.doesNotMatch(replyRule, /data-action-bar-action|a\.comments/);
  assert.deepEqual(content.queriedSelectors, []);
});

test("switches live between all comments, top-level comments and every comment", async () => {
  const content = await loadContent({
    settings: {},
    startUrl: "https://www.reddit.com/r/firefox/comments/abc/post",
  });
  const style = content.injectedStyles[0];
  const baseRules = style.textContent;

  content.storageListeners[0]({ hideCommentReplies: { newValue: true } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(style.textContent, /comment > \.child/);
  assert.doesNotMatch(style.textContent, /data-action-bar-action/);

  content.storageListeners[0]({ hideComments: { newValue: true } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(style.textContent, /data-action-bar-action/);
  assert.match(style.textContent, /shreddit-comment-tree/);

  content.storageListeners[0]({ hideComments: { newValue: false } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(style.textContent, /comment > \.child/);
  assert.doesNotMatch(style.textContent, /data-action-bar-action/);

  content.storageListeners[0]({ hideCommentReplies: { newValue: false } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(style.textContent, baseRules);
});

test("toggles suggested communities with persistent CSS and no DOM scans", async () => {
  const content = await loadContent({
    settings: { hideSuggestedCommunities: true },
    startUrl: "https://www.reddit.com/",
  });
  const style = content.injectedStyles[0];

  assert.match(
    style.textContent,
    /in-feed-community-recommendations \{ display: none !important; \}/,
  );
  assert.deepEqual(content.queriedSelectors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(content.observerOptions.at(-1))),
    { childList: true, subtree: true },
  );

  content.storageListeners[0]({
    hideSuggestedCommunities: { oldValue: true, newValue: false },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(style.textContent, /in-feed-community-recommendations/);
  assert.deepEqual(content.queriedSelectors, []);

  content.storageListeners[0]({
    hideSuggestedCommunities: { oldValue: false, newValue: true },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(style.textContent, /in-feed-community-recommendations/);
  assert.equal(content.injectedStyles.length, 1);
});

test("hides modern feed comment actions inside shreddit-post shadow roots", async () => {
  const styles = [];
  const shadowRoot = {
    appendChild(style) {
      styles.push(style);
    },
    querySelector(selector) {
      return styles.find((style) => `#${style.id}` === selector) || null;
    },
  };
  const post = { shadowRoot };
  const content = await loadContent({
    querySelectorAll: (selector) => selector === "shreddit-post" ? [post] : [],
    settings: { hideComments: true },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(styles.length, 1);
  assert.equal(styles[0].id, "frontfilter-comment-actions-style");
  assert.match(styles[0].textContent, /data-action-bar-action="comments"/);
  assert.match(styles[0].textContent, /data-post-click-location="comments-button"/);

  content.storageListeners[0]({ hideComments: { newValue: false } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(styles[0].textContent, "");

  content.storageListeners[0]({ hideComments: { newValue: true } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /display: none !important/);
});

test("toggles comment visibility live while preserving post and community filters", async () => {
  const post = createPost({ subreddit: "firefox" });
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedSubreddits: [{ name: "firefox", mode: "all" }] },
    startUrl: "https://www.reddit.com/",
  });
  const style = content.injectedStyles[0];
  const originalRules = style.textContent;

  for (const enabled of [true, false, true]) {
    content.storageListeners[0]({
      hideComments: { newValue: enabled },
      hideCommentReplies: { newValue: enabled },
    }, "local");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(style.textContent.includes("shreddit-comment"), enabled);
    assert.ok(style.textContent.startsWith(originalRules));
    assert.equal(post.dataset.frontfilterPostHidden, "true");
    assert.equal(content.injectedStyles.length, 1);
    assert.deepEqual(content.redirects, []);
  }

  content.storageListeners[0]({
    hideComments: { oldValue: true },
    hideCommentReplies: { oldValue: true },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(style.textContent, originalRules);
});

test("disables video autoplay while preserving manual playback and restores it live", async () => {
  const playerVideo = createMediaElement({ localName: "video", paused: false });
  const player = createMediaElement({
    attributes: ["autoplay", "autoplay-pref", "muted-autoplay-fallback"],
    localName: "shreddit-player",
    shadowVideos: [playerVideo],
  });
  const nativeVideo = createMediaElement({
    attributes: ["autoplay"],
    localName: "video",
    paused: false,
  });
  const media = [player, nativeVideo];
  const content = await loadContent({
    querySelectorAll: (selector) => selector === "shreddit-player, video" ? media : [],
    settings: { disableAutoplay: true },
    startUrl: "https://www.reddit.com/",
  });

  for (const attribute of ["autoplay", "autoplay-pref", "muted-autoplay-fallback"]) {
    assert.equal(player.hasAttribute(attribute), false);
  }
  assert.equal(playerVideo.autoplay, false);
  assert.equal(playerVideo.pauseCount, 1);
  assert.equal(nativeVideo.hasAttribute("autoplay"), false);
  assert.equal(nativeVideo.autoplay, false);
  assert.equal(nativeVideo.pauseCount, 1);

  // Once autoplay has been neutralized, later processing must not interrupt a
  // video that the user started manually.
  playerVideo.paused = false;
  nativeVideo.paused = false;
  content.processFilteredContent();
  assert.equal(playerVideo.pauseCount, 1);
  assert.equal(nativeVideo.pauseCount, 1);

  // If Reddit enables autoplay again while recycling a player, neutralize it
  // and stop that automatic attempt.
  player.setAttribute("autoplay-pref", "");
  content.processFilteredContent();
  assert.equal(player.hasAttribute("autoplay-pref"), false);
  assert.equal(playerVideo.pauseCount, 2);

  content.storageListeners[0]({ disableAutoplay: { newValue: false } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  for (const attribute of ["autoplay", "autoplay-pref", "muted-autoplay-fallback"]) {
    assert.equal(player.hasAttribute(attribute), true);
  }
  assert.equal(nativeVideo.hasAttribute("autoplay"), true);
  assert.equal(nativeVideo.autoplay, true);
  assert.equal(player.hasAttribute("data-frontfilter-autoplay-state"), false);
  assert.equal(playerVideo.hasAttribute("data-frontfilter-autoplay-state"), false);
});

test("hides posts from ALL-mode subreddits using post attributes", async () => {
  const blockedPost = createPost({ subreddit: "r/Firefox" });
  const allowedPost = createPost({ subreddit: "javascript" });

  await loadContent({
    fetch: async () => ({ ok: false }),
    querySelectorAll: (selector) => isPostCollectionSelector(selector)
      ? [blockedPost, allowedPost]
      : [],
    settings: {
      blockedSubreddits: [{ name: "fire*", mode: "all" }],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(blockedPost.dataset.frontfilterPostHidden, "true");
  assert.equal("frontfilterPostHidden" in allowedPost.dataset, false);
});

test("keeps allowed subreddit posts despite global and wildcard community blocks", async () => {
  const exceptionPost = createPost({ subreddit: "ItalyPersonalFinance" });
  const blockedPost = createPost({ subreddit: "italytravel" });

  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector)
      ? [exceptionPost, blockedPost]
      : [],
    settings: {
      blockSubHome: true,
      blockedSubreddits: [{ name: "*italy*", mode: "all" }],
      allowedSubreddits: ["italypersonalfinance"],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal("frontfilterPostHidden" in exceptionPost.dataset, false);
  assert.equal(blockedPost.dataset.frontfilterPostHidden, "true");
});

test("still applies post keyword filters inside allowed subreddits", async () => {
  const post = createPost({
    subreddit: "ItalyPersonalFinance",
    title: "Trump appears in this title",
  });

  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: {
      blockedSubreddits: [{ name: "*italy*", mode: "all" }],
      allowedSubreddits: ["italypersonalfinance"],
      blockedTitleKeywords: ["trump"],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(post.dataset.frontfilterPostHidden, "true");
});

test("hides post titles containing configured keywords case-insensitively", async () => {
  const blockedPost = createPost({ title: "Latest TRUMP campaign update" });
  const allowedPost = createPost({ title: "A different headline" });

  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector)
      ? [blockedPost, allowedPost]
      : [],
    settings: { blockedTitleKeywords: ["Trump"] },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(blockedPost.dataset.frontfilterPostHidden, "true");
  assert.equal("frontfilterPostHidden" in allowedPost.dataset, false);
});

test("reads title text from legacy post markup when title attributes are absent", async () => {
  const titleElement = {
    textContent: "A Trump headline",
    closest: () => post,
  };
  const post = {
    dataset: {},
    getAttribute: () => null,
    querySelectorAll(selector) {
      return selector.includes("a.title") ? [titleElement] : [];
    },
  };

  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedTitleKeywords: ["trump"] },
    startUrl: "https://old.reddit.com/",
  });

  assert.equal(post.dataset.frontfilterPostHidden, "true");
});

test("hides posts when their text preview contains a configured keyword", async () => {
  const bodyElement = {
    textContent: "An analysis of the TRUMP campaign",
    closest(selector) {
      return selector.includes("shreddit-comment") ? null : post;
    },
  };
  const post = {
    dataset: {},
    getAttribute: () => null,
    querySelectorAll(selector) {
      return selector.includes('[slot="text-body"]') ? [bodyElement] : [];
    },
  };

  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedTitleKeywords: ["Trump"] },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(post.dataset.frontfilterPostHidden, "true");
});

test("does not treat nested comment text as post content", async () => {
  const commentBody = {
    textContent: "Trump appears only in this comment",
    closest(selector) {
      return selector.includes("shreddit-comment") ? {} : post;
    },
  };
  const post = {
    dataset: {},
    getAttribute: () => null,
    querySelectorAll(selector) {
      return selector.includes('[slot="text-body"]') ? [commentBody] : [];
    },
  };

  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedTitleKeywords: ["Trump"] },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal("frontfilterPostHidden" in post.dataset, false);
});

test("treats post keywords as literal text and reveals posts when removed", async () => {
  const post = createPost({ title: "Save [50%] on this item" });
  const content = await loadContent({
    querySelectorAll(selector) {
      if (isPostCollectionSelector(selector)) return [post];
      if (selector === '[data-frontfilter-post-hidden="true"]'
        && post.dataset.frontfilterPostHidden === "true") return [post];
      return [];
    },
    settings: { blockedTitleKeywords: ["[50%]"] },
    startUrl: "https://www.reddit.com/",
  });
  assert.equal(post.dataset.frontfilterPostHidden, "true");

  content.storageListeners[0]({
    blockedTitleKeywords: { oldValue: ["[50%]"], newValue: [] },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal("frontfilterPostHidden" in post.dataset, false);
});

test("does not hide feed posts for HOME-mode subreddit entries", async () => {
  const post = createPost({ subreddit: "firefox" });

  await loadContent({
    fetch: async () => ({ ok: false }),
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: {
      blockedSubreddits: [{ name: "firefox", mode: "home" }],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal("frontfilterPostHidden" in post.dataset, false);
});

test("uses post permalinks when a Reddit layout has no known post selector", async () => {
  const post = createPost();
  const link = {
    getAttribute: () => "/r/firefox/comments/abc/a-post",
    closest(selector) {
      return selector.includes("shreddit-comment") ? null : post;
    },
  };

  await loadContent({
    fetch: async () => ({ ok: false }),
    querySelectorAll(selector) {
      if (selector === 'a[href*="/comments/"]') return [link];
      return [];
    },
    settings: {
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(post.dataset.frontfilterPostHidden, "true");
});

test("hides blocked communities but keeps exceptions inside popular panels", async () => {
  const blockedItem = { dataset: {} };
  const allowedItem = { dataset: {} };
  const panel = {
    contains: () => true,
    querySelectorAll: () => [blockedLink, allowedLink],
  };
  const blockedLink = {
    getAttribute: () => "/r/italytravel",
    closest: () => blockedItem,
  };
  const allowedLink = {
    getAttribute: () => "/r/italypersonalfinance",
    closest: () => allowedItem,
  };

  await loadContent({
    fetch: async () => ({ ok: false }),
    querySelectorAll: (selector) => selector.includes("popular-communities")
      ? [panel]
      : [],
    settings: {
      blockSubHome: true,
      blockedSubreddits: [{ name: "*italy*", mode: "all" }],
      allowedSubreddits: ["italypersonalfinance"],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(blockedItem.dataset.frontfilterCommunityHidden, "true");
  assert.equal("frontfilterCommunityHidden" in allowedItem.dataset, false);
});

test("reveals posts after the last active feed filter is disabled", async () => {
  const hiddenPost = { dataset: { frontfilterPostHidden: "true" } };
  const content = await loadContent({
    querySelectorAll: (selector) => selector === '[data-frontfilter-post-hidden="true"]'
      ? [hiddenPost]
      : [],
    settings: { blockedSubreddits: [{ name: "firefox", mode: "all" }] },
    startUrl: "https://www.reddit.com/",
  });

  content.storageListeners[0](
    { blockedSubreddits: { oldValue: [{ name: "firefox", mode: "all" }], newValue: [] } },
    "local",
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal("frontfilterPostHidden" in hiddenPost.dataset, false);
});

test("clears stale hidden markers while filters remain active", async () => {
  const hiddenPost = { dataset: { frontfilterPostHidden: "true" } };
  const hiddenCommunity = {
    dataset: { frontfilterCommunityHidden: "true" },
  };

  await loadContent({
    fetch: async () => ({ ok: false }),
    querySelectorAll(selector) {
      if (selector === '[data-frontfilter-post-hidden="true"]') {
        return [hiddenPost];
      }
      if (selector === '[data-frontfilter-community-hidden="true"]') {
        return [hiddenCommunity];
      }
      return [];
    },
    settings: {
      blockSubHome: true,
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal("frontfilterPostHidden" in hiddenPost.dataset, false);
  assert.equal(
    "frontfilterCommunityHidden" in hiddenCommunity.dataset,
    false,
  );
});

test("reveals a current post candidate when its blocking entry changes", async () => {
  const post = createPost({ subreddit: "firefox" });
  const content = await loadContent({
    fetch: async () => ({ ok: false }),
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: {
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    },
    startUrl: "https://www.reddit.com/",
  });
  assert.equal(post.dataset.frontfilterPostHidden, "true");

  content.storageListeners[0]({
    blockedSubreddits: {
      oldValue: [{ name: "firefox", mode: "all" }],
      newValue: [{ name: "javascript", mode: "all" }],
    },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal("frontfilterPostHidden" in post.dataset, false);
});

test("merges storage changes received while the initial config is loading", async () => {
  const initialSettings = deferred();
  const content = await loadContent({
    fetch: async () => ({ ok: false }),
    settings: initialSettings.promise,
    startUrl: "https://www.reddit.com/r/popular",
  });

  content.storageListeners[0](
    { blockPopular: { oldValue: true, newValue: false } },
    "local",
  );
  initialSettings.resolve({ blockPopular: true, blockHomepage: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(content.redirects, []);

  content.location.href = "https://www.reddit.com/";
  content.location.pathname = "/";
  await content.checkCurrentPage({ force: true });

  assert.equal(content.redirects.length, 1);
  assert.equal(new URL(content.redirects[0]).searchParams.get("page"), "homepage");

  content.location.href = "https://www.reddit.com/r/popular";
  content.location.pathname = "/r/popular";
  await content.checkCurrentPage({ force: true });

  assert.equal(content.redirects.length, 1);
});
