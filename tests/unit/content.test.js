const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { STATS_RECORDER_SCRIPTS, deferred, runScripts, settle } = require("./helpers");

const CONTENT_SCRIPTS = [
  "shared/core.js", "shared/stats.js", "content/selectors.js", "content/posts.js",
  "content/page-style.js", "content/autoplay.js", "content/quick-block.js",
  "content/stats-recorder.js", "content/main.js",
];

async function loadContent({
  querySelectorAll = () => [], settings, startUrl, body = {},
  // Whether the page is in front, in the focused window.
  focused = false,
  sendMessage = async () => ({ success: true }),
  scripts = CONTENT_SCRIPTS,
}) {
  const redirects = [];
  const readyListeners = [];
  const injectedStyles = [];
  const location = {
    href: startUrl,
    origin: new URL(startUrl).origin,
    pathname: new URL(startUrl).pathname,
    replace(url) {
      redirects.push(url);
    },
  };
  const rootAttributes = new Set();
  const documentListeners = {};
  const page = { focused };
  const document = {
    body,
    get visibilityState() { return page.focused ? "visible" : "hidden"; },
    hasFocus: () => page.focused,
    addEventListener(type, listener) {
      if (type === "DOMContentLoaded") readyListeners.push(listener);
      else (documentListeners[type] ??= []).push(listener);
    },
    documentElement: {
      appendChild(style) { injectedStyles.push(style); },
      hasAttribute: (name) => rootAttributes.has(name),
      toggleAttribute(name, force) {
        if (force) rootAttributes.add(name);
        else rootAttributes.delete(name);
        return force;
      },
    },
    createElement: () => ({ id: "", style: {}, textContent: "" }),
    getElementById: (id) => injectedStyles.find((style) => style.id === id) || null,
    querySelectorAll(selector) {
      queriedSelectors.push(selector);
      return querySelectorAll(selector);
    },
    querySelector(selector) {
      queriedSelectors.push(selector);
      return querySelectorAll(selector)[0] ?? null;
    },
    // Live collections re-read the fake DOM on every iteration.
    getElementsByTagName: (name) => liveCollection(name),
    getElementsByClassName: (names) => liveCollection(`.${names.split(" ").join(".")}`),
  };
  const liveCollections = [];
  function liveCollection(selector) {
    liveCollections.push(selector);
    return { [Symbol.iterator]: () => querySelectorAll(selector)[Symbol.iterator]() };
  }
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
      sendMessage: (message) => {
        sentMessages.push(JSON.parse(JSON.stringify(message)));
        return sendMessage(message);
      },
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
    },
  };
  // Listeners for messages to this page, as from the settings page.
  const messageListeners = [];
  const sentMessages = [];
  const observers = [];
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(_target, options) { observerOptions.push({ ...options }); }
  }
  const windowListeners = {};
  const window = {
    location,
    addEventListener(type, listener) { (windowListeners[type] ??= []).push(listener); },
  };
  const intervals = [];
  // Timeouts run when a test calls runTimers(); the clock moves when a
  // test sets clock.now.
  const timeouts = new Map();
  let lastTimeout = 0;
  const clock = { now: new Date(2026, 10, 11, 12).getTime() };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length > 0 ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  // Custom elements are defined when a test calls define(name).
  const definitions = new Map();
  const definition = (name) => {
    if (!definitions.has(name)) definitions.set(name, deferred());
    return definitions.get(name);
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    chrome,
    console,
    customElements: { whenDefined: (name) => definition(name).promise },
    Date: FakeDate,
    document,
    Event,
    MutationObserver,
    requestAnimationFrame: (callback) => callback(),
    setInterval: (callback) => intervals.push(callback),
    clearInterval: (id) => { intervals[id - 1] = () => {}; },
    setTimeout(callback) {
      timeouts.set(++lastTimeout, callback);
      return lastTimeout;
    },
    clearTimeout: (id) => timeouts.delete(id),
    window,
  });

  // This harness isolates legacy filtering. The limiters have their own DOM tests.
  vm.runInContext(`
    var FrontFilterFeedStub = {
      updateCount: 0,
      update() { this.updateCount += 1; },
    };
    var FrontFilterCommentStub = {
      updateCount: 0,
      update() { this.updateCount += 1; },
    };
  `, context);

  for (const file of scripts) {
    runScripts(context, [file]);
    if (file === "shared/core.js") {
      vm.runInContext(`FrontFilter.createFeedLimiter = (options) => {
        FrontFilterFeedStub.options = options;
        return FrontFilterFeedStub;
      };
      FrontFilter.createCommentLimiter = (options) => {
        FrontFilterCommentStub.options = options;
        return FrontFilterCommentStub;
      };`, context);
    }
  }
  await settle();

  return {
    checkCurrentPage: context.checkCurrentPage,
    getFeedLimiterUpdateCount: () => context.FrontFilterFeedStub.updateCount,
    getCommentLimiterUpdateCount: () => context.FrontFilterCommentStub.updateCount,
    isFeedRecordBlocked: (record) => context.FrontFilterFeedStub.options.isBlocked(record),
    isCommentBlocked: (comment) => context.FrontFilterCommentStub.options.isBlocked(comment),
    processFilteredContent: context.processFilteredContent,
    // Simulates the parser reaching the end of the page.
    async finishParsing() {
      document.body = {};
      readyListeners.splice(0).forEach((listener) => listener());
      await settle();
    },
    async define(name) {
      definition(name).resolve();
      await settle();
    },
    // Runs the checks for SPA navigations, which Reddit makes with the
    // History API: on popstate, and by polling.
    async poll() {
      intervals.forEach((callback) => callback());
      await settle();
    },
    async popState() {
      windowListeners.popstate.forEach((listener) => listener());
      await settle();
    },
    // Fires an event of the window, such as focus or a kind of input.
    dispatchWindow(type) {
      (windowListeners[type] || []).forEach((listener) => listener({ type }));
    },
    // Brings the page to the front or sends it behind another tab.
    setFocused(value) {
      page.focused = value;
      (documentListeners.visibilitychange || []).forEach((listener) => listener());
      (windowListeners[value ? "focus" : "blur"] || []).forEach((listener) => listener());
    },
    // Sends the page a message, as the settings page does, and returns its
    // answer, copied as browsers copy it, or undefined if no listener answers.
    ask(message) {
      return new Promise((resolve) => {
        const respond = (answer) => resolve(answer === undefined ? answer : JSON.parse(JSON.stringify(answer)));
        const answering = messageListeners
          .map((listener) => listener(message, {}, respond))
          .some((result) => result === true);
        if (!answering) resolve(undefined);
      });
    },
    runTimers() {
      for (const [id, callback] of Array.from(timeouts)) {
        timeouts.delete(id);
        callback();
      }
    },
    clock,
    sentMessages,
    // Runs code in the content script's scope, to stand in for its modules.
    run: (source) => vm.runInContext(source, context),
    location,
    redirects,
    storageListeners,
    queriedSelectors,
    observerOptions,
    injectedStyles,
    rootAttributes,
    observers,
    liveCollections,
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
    dispatchedEvents: [],
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
    dispatchEvent(event) {
      this.dispatchedEvents.push(event.type);
      return true;
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

test("applies page rules as soon as settings load, before the page body exists", async () => {
  const content = await loadContent({
    body: null,
    settings: { hideNavbar: true },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(content.injectedStyles.length, 1);
  assert.match(content.injectedStyles[0].textContent, /reddit-header-large/);
  assert.deepEqual(content.observerOptions, []);

  await content.finishParsing();
  assert.equal(content.injectedStyles.length, 1);
  assert.equal(content.observerOptions.length, 1);
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
  await settle();

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
  await settle();
  assert.deepEqual(content.redirects, []);

  content.location.href = "https://www.reddit.com/r/javascript/?tl=ja&sort=top";
  content.location.pathname = "/r/javascript/";
  await content.checkCurrentPage();
  assert.deepEqual(content.redirects, []);

  content.storageListeners[0]({ disableAutoTranslation: { newValue: false } }, "local");
  await settle();
  assert.deepEqual(content.redirects, []);
});

test("filters the page again only when a setting changes", async () => {
  const post = createChangingPost("A calm headline");
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedTitleKeywords: ["breaking"] },
    startUrl: "https://www.reddit.com/",
  });
  const reads = post.titleReads;
  content.storageListeners[0]({ quickBlockUndo: { newValue: undefined } }, "local");
  await settle();
  assert.equal(post.titleReads, reads);
  content.storageListeners[0]({ blockedTitleKeywords: { newValue: ["calm"] } }, "local");
  await settle();
  assert.equal(post.dataset.frontfilterPostHidden, "true");
});

test("updates the feed and comment limits once when an SPA navigation changes the URL", async () => {
  const content = await loadContent({
    settings: { limitInfiniteScroll: true, limitComments: true },
    startUrl: "https://www.reddit.com/r/firefox/",
  });
  // Both apply settings once loaded, and again when they change.
  const loadUpdateCount = content.getFeedLimiterUpdateCount();
  assert.ok(loadUpdateCount > 0);
  assert.equal(content.getCommentLimiterUpdateCount(), loadUpdateCount);
  content.storageListeners[0]({ commentLimit: { newValue: 3 } }, "local");
  await settle();
  const initialUpdateCount = content.getFeedLimiterUpdateCount();
  assert.equal(initialUpdateCount, loadUpdateCount + 1);
  assert.equal(content.getCommentLimiterUpdateCount(), initialUpdateCount);

  content.location.href = "https://www.reddit.com/r/firefox/comments/abc/a_post/";
  content.location.pathname = "/r/firefox/comments/abc/a_post/";
  await content.checkCurrentPage();
  assert.equal(content.getFeedLimiterUpdateCount(), initialUpdateCount + 1);
  assert.equal(content.getCommentLimiterUpdateCount(), initialUpdateCount + 1);

  await content.checkCurrentPage();
  assert.equal(content.getFeedLimiterUpdateCount(), initialUpdateCount + 1);
  assert.equal(content.getCommentLimiterUpdateCount(), initialUpdateCount + 1);
});

test("leaves for the block page when the History API reaches a blocked page", async () => {
  for (const navigate of ["popState", "poll"]) {
    const content = await loadContent({
      settings: { blockPopular: true },
      startUrl: "https://www.reddit.com/r/firefox/",
    });
    await content[navigate]();
    assert.deepEqual(content.redirects, [], navigate);

    content.location.href = "https://www.reddit.com/r/popular/";
    content.location.pathname = "/r/popular/";
    await content[navigate]();
    assert.equal(content.redirects.length, 1, navigate);
    assert.equal(new URL(content.redirects[0]).searchParams.get("page"), "popular");
  }
});

test("blocking rules apply to translated pages", async () => {
  const blocked = await loadContent({
    settings: { blockPopular: true },
    startUrl: "https://www.reddit.com/r/popular?tl=it",
  });
  assert.equal(new URL(blocked.redirects[0]).searchParams.get("page"), "popular");
});

test("leaves for the website chosen in the settings, except to offer an undo", async () => {
  const settings = {
    blockPopular: true,
    redirectBlockedPages: true,
    redirectUrl: "https://example.com/",
  };
  const content = await loadContent({ settings, startUrl: "https://www.reddit.com/r/popular/" });
  assert.deepEqual(content.redirects, ["https://example.com/"]);

  // Only the block page offers to undo a one-click block of the open subreddit.
  const quickBlocked = await loadContent({ settings, startUrl: "https://www.reddit.com/r/news/" });
  quickBlocked.run(`quickBlock.takeUndo = (name) => (name === "news" ? "abc123" : "")`);
  quickBlocked.storageListeners[0](
    { blockedSubreddits: { newValue: [{ name: "news", mode: "all" }] } },
    "local",
  );
  await settle();
  assert.equal(quickBlocked.redirects.length, 1);
  const blockPage = new URL(quickBlocked.redirects[0]);
  assert.equal(blockPage.protocol, "moz-extension:");
  assert.equal(blockPage.searchParams.get("undo"), "abc123");

  // A website blocked itself would only redirect again.
  const blockedWebsite = await loadContent({
    settings: { ...settings, redirectUrl: "https://www.reddit.com/r/popular/top/" },
    startUrl: "https://www.reddit.com/r/popular/",
  });
  assert.equal(new URL(blockedWebsite.redirects[0]).searchParams.get("page"), "popular");
});

// Settings implemented as page rules, with the shadow-root hosts they may
// look up. CSS also covers elements Reddit adds later, so these settings
// need no page scans or wider mutation observation. Which elements each one
// hides is tested in real browsers (tests/browser and tests/reddit).
const PAGE_RULE_SETTINGS = {
  hideNavbar: [],
  hideNavbarMenu: [],
  hideNavbarSearch: [],
  hideNavbarChat: [],
  hideNavbarNotifications: [],
  hideNavbarProfile: [],
  hideNavbarOthers: [],
  hideLeftSidebar: [],
  hideLeftSidebarGames: [],
  hideLeftSidebarCustomFeeds: [],
  hideLeftSidebarRecent: [],
  hideLeftSidebarCommunities: [],
  hideLeftSidebarResources: [],
  hideRelatedPosts: [],
  hideSuggestedCommunities: [],
  hideSuggestedPosts: [],
  hideAds: [],
  hideNsfw: [],
  hideSpoilers: [],
  hideKarma: [],
  hideAvatars: [],
  hideUsernames: [],
  hideCommentReplies: [],
  hideComments: ["shreddit-post"],
  hideVotes: ["shreddit-post", "shreddit-comment-action-row"],
  hideAwards: ["shreddit-post", "shreddit-comment-action-row"],
  blockHomepage: ["left-nav-top-section"],
  blockPopular: ["left-nav-top-section"],
  blockExplore: ["left-nav-top-section"],
  blockNews: ["left-nav-top-section"],
};
// No page rule setting redirects a post page.
const POST_PAGE = "https://www.reddit.com/r/firefox/comments/abc/post";
// Parent switches imply their sections, and the settings page saves both.
const IMPLIED_SETTINGS = {
  hideComments: ["hideCommentReplies"],
  hideNavbar: Object.keys(PAGE_RULE_SETTINGS).filter((key) => key.startsWith("hideNavbar")),
  hideLeftSidebar: Object.keys(PAGE_RULE_SETTINGS).filter((key) => key.startsWith("hideLeftSidebar")),
};

test("page rule settings never scan the page, widen the observer or redirect", async () => {
  for (const [setting, shadowHosts] of Object.entries(PAGE_RULE_SETTINGS)) {
    const content = await loadContent({ settings: { [setting]: true }, startUrl: POST_PAGE });
    assert.deepEqual(content.queriedSelectors, shadowHosts, setting);
    assert.deepEqual(
      JSON.parse(JSON.stringify(content.observerOptions.at(-1))),
      { childList: true, subtree: true },
      setting,
    );
    assert.deepEqual(content.redirects, [], setting);
  }
});

test("page rules toggle live without disturbing each other or active filters", async () => {
  const post = createPost({ subreddit: "javascript" });
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedSubreddits: [{ name: "javascript", mode: "all" }] },
    startUrl: POST_PAGE,
  });
  const style = content.injectedStyles[0];
  const settings = Object.keys(PAGE_RULE_SETTINGS);
  async function change(enabled, keys) {
    const saved = keys.flatMap((key) => [key, ...(IMPLIED_SETTINGS[key] || [])]);
    content.storageListeners[0](
      Object.fromEntries(saved.map((key) => [key, { newValue: enabled }])),
      "local",
    );
    await settle();
  }

  const withoutRules = style.textContent;
  for (const setting of settings) {
    await change(true, [setting]);
    assert.notEqual(style.textContent, withoutRules, setting);
    await change(false, [setting]);
    assert.equal(style.textContent, withoutRules, setting);
  }

  // Each setting can be switched off and back on while the others stay.
  await change(true, settings);
  const allRules = style.textContent;
  for (const setting of settings) {
    await change(false, [setting]);
    await change(true, [setting]);
    assert.equal(style.textContent, allRules, setting);
  }
  await change(false, settings);
  assert.equal(style.textContent, withoutRules);

  assert.equal(post.dataset.frontfilterPostHidden, "true");
  assert.equal(content.injectedStyles.length, 1);
  assert.deepEqual(content.redirects, []);
});

test("page rules match structure, never translated text", async () => {
  const content = await loadContent({
    settings: {
      ...Object.fromEntries(Object.keys(PAGE_RULE_SETTINGS).map((key) => [key, true])),
      blockedUsers: ["spez"],
    },
    startUrl: POST_PAGE,
  });
  const rules = Array.from(
    content.injectedStyles[0].textContent.matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ([, selector, declarations]) => ({ selector: selector.trim(), declarations: declarations.trim() }),
  );

  assert.ok(rules.length > Object.keys(PAGE_RULE_SETTINGS).length);
  for (const { selector, declarations } of rules) {
    assert.doesNotMatch(selector, /aria-label|:lang\(|:has-text\(|:contains\(|\[(title|alt|placeholder)\b/i, selector);
    assert.match(
      declarations,
      /^(display: none !important;|--shreddit-header-height: 0px !important; --header-height: 0px !important;)$/,
      selector,
    );
  }
});

test("hides blocked users' posts and comments with page rules, ignoring case", async () => {
  const content = await loadContent({
    settings: { blockedUsers: ["u/Spez", "some-user_1"] },
    startUrl: POST_PAGE,
  });
  const style = content.injectedStyles[0];
  const authors = '[author="spez" i], [author="some-user_1" i]';
  for (const selector of [
    `shreddit-post:is(${authors})`,
    `article:has(> shreddit-post:is(${authors}))`,
    `shreddit-feed :is(shreddit-post:is(${authors}), article:has(> shreddit-post:is(${authors}))) + hr`,
    `shreddit-comment:is(${authors})`,
    '.thing:is([data-author="spez" i], [data-author="some-user_1" i])',
  ]) {
    assert.ok(style.textContent.includes(`${selector} { display: none !important; }`), selector);
  }
  // CSS covers what Reddit adds later: no page scans, wider observation or
  // redirects of the user's posts.
  assert.deepEqual(content.queriedSelectors, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(content.observerOptions.at(-1))),
    { childList: true, subtree: true },
  );
  assert.deepEqual(content.redirects, []);

  content.storageListeners[0]({ blockedUsers: { newValue: [] } }, "local");
  await settle();
  assert.doesNotMatch(style.textContent, /author/);
});

test("leaves a blocked user's profile for the block page", async () => {
  const content = await loadContent({
    settings: { blockedUsers: ["spez"] },
    startUrl: "https://www.reddit.com/user/kn0thing/",
  });
  assert.deepEqual(content.redirects, []);

  content.location.href = "https://www.reddit.com/user/Spez/comments/";
  content.location.pathname = "/user/Spez/comments/";
  await content.popState();
  assert.equal(content.redirects.length, 1);
  const redirect = new URL(content.redirects[0]);
  assert.equal(redirect.searchParams.get("target"), "user");
  assert.equal(redirect.searchParams.get("user"), "spez");
  assert.equal(redirect.hash.slice(1), "https://www.reddit.com/user/Spez/comments/");
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
  await settle();
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
  await settle();
  assert.doesNotMatch(style.textContent, /#reddit-logo/);
});

function createShadowHost() {
  const host = { styles: [], writes: 0 };
  host.shadowRoot = {
    appendChild(style) {
      let text = style.textContent;
      Object.defineProperty(style, "textContent", {
        get: () => text,
        set: (value) => {
          text = value;
          host.writes += 1;
        },
      });
      host.styles.push(style);
    },
    querySelector(selector) {
      return host.styles.find((style) => `#${style.id}` === selector) || null;
    },
  };
  return host;
}

test("writes shadow-root rules once and empties them when signals show again", async () => {
  const post = createShadowHost();
  const actionRow = createShadowHost();
  const content = await loadContent({
    querySelectorAll: (selector) => ({
      "shreddit-post": [post],
      "shreddit-comment-action-row": [actionRow],
    })[selector] || [],
    settings: { hideVotes: true, hideAwards: true },
    startUrl: "https://www.reddit.com/r/test/comments/abc/title/",
  });

  for (const host of [post, actionRow]) {
    assert.equal(host.styles.length, 1);
    assert.equal(host.styles[0].id, "frontfilter-social-signals-style");
  }
  // Unchanged shadow stylesheets are not rewritten on later mutations.
  content.processFilteredContent();
  assert.deepEqual([post.writes, actionRow.writes], [1, 1]);

  for (const setting of ["hideAwards", "hideVotes"]) {
    content.storageListeners[0]({ [setting]: { newValue: false } }, "local");
    await settle();
  }
  for (const host of [post, actionRow]) {
    assert.equal(host.styles.length, 1);
    assert.equal(host.styles[0].textContent, "");
  }
});

test("hides suggested posts only in the Home feed, in CSS and in the feed limiter", async () => {
  const content = await loadContent({
    settings: { hideSuggestedPosts: true },
    startUrl: "https://www.reddit.com/",
  });
  const suggested = { subreddit: "safe", title: "", bodyTexts: [], recommended: true };
  const joined = { ...suggested, recommended: false };

  // The page rules apply under this marker only.
  assert.ok(content.rootAttributes.has("data-frontfilter-home-feed"));
  assert.equal(content.isFeedRecordBlocked(suggested), true);
  assert.equal(content.isFeedRecordBlocked(joined), false);

  // Popular and other feeds consist of recommendations by design.
  content.location.href = "https://www.reddit.com/r/popular/";
  content.location.pathname = "/r/popular/";
  await content.checkCurrentPage();
  assert.equal(content.rootAttributes.has("data-frontfilter-home-feed"), false);
  assert.equal(content.isFeedRecordBlocked(suggested), false);

  content.location.href = "https://www.reddit.com/best/";
  content.location.pathname = "/best/";
  await content.checkCurrentPage();
  assert.ok(content.rootAttributes.has("data-frontfilter-home-feed"));

  content.storageListeners[0]({ hideSuggestedPosts: { newValue: false } }, "local");
  await settle();
  assert.equal(content.isFeedRecordBlocked(suggested), false);
});

test("hides NSFW posts on every page, in CSS and in the feed limiter", async () => {
  const content = await loadContent({
    settings: { hideNsfw: true },
    startUrl: "https://www.reddit.com/r/popular/",
  });
  const record = (nsfw) => ({ subreddit: "safe", title: "", bodyTexts: [], recommended: false, nsfw });
  const style = content.injectedStyles[0];

  assert.match(style.textContent, /\[subreddit-nsfw\]/);
  assert.equal(content.isFeedRecordBlocked(record(true)), true);
  assert.equal(content.isFeedRecordBlocked(record(false)), false);

  content.storageListeners[0]({ hideNsfw: { newValue: false } }, "local");
  await settle();
  assert.doesNotMatch(style.textContent, /nsfw/);
  assert.equal(content.isFeedRecordBlocked(record(true)), false);
});

test("hides spoilers on every page, in CSS and in the feed limiter, apart from NSFW posts", async () => {
  const content = await loadContent({
    settings: { hideSpoilers: true },
    startUrl: "https://www.reddit.com/r/popular/",
  });
  const record = (tags) => ({ subreddit: "safe", title: "", bodyTexts: [], recommended: false, ...tags });
  const style = content.injectedStyles[0];

  assert.match(style.textContent, /\[spoiler\]/);
  assert.doesNotMatch(style.textContent, /nsfw/);
  assert.equal(content.isFeedRecordBlocked(record({ spoiler: true })), true);
  assert.equal(content.isFeedRecordBlocked(record({ nsfw: true })), false);
  assert.equal(content.isFeedRecordBlocked(record({})), false);

  content.storageListeners[0]({
    hideSpoilers: { newValue: false },
    hideNsfw: { newValue: true },
  }, "local");
  await settle();
  assert.doesNotMatch(style.textContent, /spoiler/);
  assert.equal(content.isFeedRecordBlocked(record({ spoiler: true })), false);
  assert.equal(content.isFeedRecordBlocked(record({ nsfw: true })), true);
});

test("leaves blocked users' posts out of the scroll limit, whatever the case of their name", async () => {
  const content = await loadContent({
    settings: { blockedUsers: ["spez"] },
    startUrl: "https://www.reddit.com/",
  });
  const record = (author) => ({ subreddit: "safe", title: "", bodyTexts: [], recommended: false, author });

  assert.equal(content.isFeedRecordBlocked(record("spez")), true);
  assert.equal(content.isFeedRecordBlocked(record("Spez")), true);
  assert.equal(content.isFeedRecordBlocked(record("spezz")), false);
  assert.equal(content.isFeedRecordBlocked(record("")), false);

  content.storageListeners[0]({ blockedUsers: { newValue: [] } }, "local");
  await settle();
  assert.equal(content.isFeedRecordBlocked(record("spez")), false);
});

test("leaves comments that page filters hide out of the comment limit", async () => {
  const content = await loadContent({
    settings: { blockedUsers: ["spez"], blockedTitleKeywords: ["spoiler*"], allowedKeywords: ["review"] },
    startUrl: "https://www.reddit.com/r/movies/comments/abc/a_post/",
  });
  const blocked = (author, text) => content.isCommentBlocked({ author, text });

  assert.equal(blocked("Spez", "Nice"), true);
  assert.equal(blocked("alice", "Spoilers ahead"), true);
  assert.equal(blocked("alice", "A spoiler-free review"), false);
  assert.equal(blocked("alice", "Nice"), false);
  // A comment whose text has not rendered is judged by its author.
  assert.equal(blocked("alice", ""), false);
});

test("disables autoplay for players that render once their element is defined", async () => {
  for (const disableAutoplay of [true, false]) {
    const media = [];
    const content = await loadContent({
      querySelectorAll: (selector) => selector === "shreddit-player, video" ? media : [],
      settings: { disableAutoplay },
      startUrl: "https://www.reddit.com/",
    });
    const player = createMediaElement({ attributes: ["autoplay"], localName: "shreddit-player" });
    media.push(player);
    await content.define("shreddit-player");
    assert.equal(player.hasAttribute("autoplay"), !disableAutoplay);
  }
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
  await settle();
  for (const attribute of ["autoplay", "autoplay-pref", "muted-autoplay-fallback"]) {
    assert.equal(player.hasAttribute(attribute), true);
  }
  assert.equal(nativeVideo.hasAttribute("autoplay"), true);
  assert.equal(nativeVideo.autoplay, true);
  assert.equal(player.hasAttribute("data-frontfilter-autoplay-state"), false);
  assert.equal(playerVideo.hasAttribute("data-frontfilter-autoplay-state"), false);
  // The page-world bridge then asks the restored player to try autoplay.
  assert.deepEqual(player.dispatchedEvents, ["frontfilter-autoplay-restored"]);
  assert.deepEqual(playerVideo.dispatchedEvents, []);
  assert.deepEqual(nativeVideo.dispatchedEvents, []);
});

test("restores autoplay attributes with the values Reddit gave them", async () => {
  const player = createMediaElement({
    attributes: ["autoplay", "autoplay-pref"],
    localName: "shreddit-player",
  });
  player.setAttribute("autoplay-pref", "false");
  const content = await loadContent({
    querySelectorAll: (selector) => selector === "shreddit-player, video" ? [player] : [],
    settings: { disableAutoplay: true },
    startUrl: "https://www.reddit.com/",
  });
  assert.equal(player.hasAttribute("autoplay-pref"), false);
  // Reddit setting an attribute again leaves the earlier values remembered.
  player.setAttribute("muted-autoplay-fallback", "1");
  content.processFilteredContent();

  content.storageListeners[0]({ disableAutoplay: { newValue: false } }, "local");
  await settle();
  assert.deepEqual(
    ["autoplay", "autoplay-pref", "muted-autoplay-fallback"].map((name) => player.getAttribute(name)),
    ["", "false", "1"],
  );
  assert.equal(player.hasAttribute("data-frontfilter-autoplay-state"), false);
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

test("does not take a profile post's u/name for a subreddit named u", async () => {
  const profilePost = createPost({ subreddit: "u/alice" });
  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [profilePost] : [],
    settings: { blockedSubreddits: [{ name: "*u", mode: "all" }] },
    startUrl: "https://www.reddit.com/",
  });
  assert.equal("frontfilterPostHidden" in profilePost.dataset, false);
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

function createFlairPost(flair) {
  const post = createPost();
  const flairElement = { textContent: ` ${flair} `, closest: () => post };
  post.querySelectorAll = (selector) =>
    selector === "shreddit-post-flair, .linkflairlabel" ? [flairElement] : [];
  return post;
}

// Current Reddit nests the body inside <details>, so it is found as the
// first [slot="comment"] descendant, which belongs to a reply when the
// comment has no body of its own.
function createComment(text, { bodyOwner } = {}) {
  const comment = { dataset: {}, localName: "shreddit-comment", textReads: 0 };
  const body = text === null ? null : {
    closest: (selector) => selector === "shreddit-comment" ? bodyOwner || comment : null,
    get textContent() {
      comment.textReads += 1;
      return text;
    },
  };
  comment.querySelector = (selector) => selector === '[slot="comment"]' ? body : null;
  return comment;
}

test("hides posts whose flair matches a blocked flair or wildcard", async () => {
  const meme = createFlairPost("MEME");
  const politics = createFlairPost("US Politics");
  const question = createFlairPost("Question");

  await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector)
      ? [meme, politics, question]
      : [],
    settings: { blockedFlairs: ["meme", "*politic*"] },
    startUrl: "https://www.reddit.com/r/test/",
  });

  assert.equal(meme.dataset.frontfilterPostHidden, "true");
  assert.equal(politics.dataset.frontfilterPostHidden, "true");
  assert.equal("frontfilterPostHidden" in question.dataset, false);
});

test("filters comments by keyword, reading each comment's text only once", async () => {
  const blocked = createComment("I think TRUMP will win");
  const allowed = createComment("Nice photo");
  const pending = createComment(null);
  // A deleted comment whose first body match is a matching reply's.
  const deleted = createComment("Trump reply", { bodyOwner: {} });
  const comments = [blocked, allowed, pending, deleted];
  const content = await loadContent({
    querySelectorAll: (selector) => ({
      "shreddit-comment": comments,
      '[data-frontfilter-comment-hidden="true"]': comments.filter(
        (comment) => comment.dataset.frontfilterCommentHidden === "true",
      ),
    })[selector] || [],
    settings: { blockedTitleKeywords: ["Trump"] },
    startUrl: "https://www.reddit.com/r/test/comments/abc/post/",
  });

  assert.equal(blocked.dataset.frontfilterCommentHidden, "true");
  assert.equal("frontfilterCommentHidden" in allowed.dataset, false);
  assert.equal("frontfilterCommentHidden" in deleted.dataset, false);
  assert.deepEqual([blocked.textReads, allowed.textReads, deleted.textReads], [1, 1, 0]);

  // Later mutations reuse the cached result, including for comments without
  // a body of their own; comments whose body has not rendered are retried.
  let pendingLookups = 0;
  const lookUpBody = pending.querySelector;
  pending.querySelector = (selector) => {
    pendingLookups += 1;
    return lookUpBody(selector);
  };
  content.processFilteredContent();
  content.processFilteredContent();
  assert.deepEqual([blocked.textReads, allowed.textReads, deleted.textReads], [1, 1, 0]);
  assert.equal(pendingLookups, 2);

  // New keywords re-check every comment once.
  content.storageListeners[0]({ blockedTitleKeywords: { newValue: ["photo"] } }, "local");
  await settle();
  assert.equal("frontfilterCommentHidden" in blocked.dataset, false);
  assert.equal(allowed.dataset.frontfilterCommentHidden, "true");
  assert.deepEqual([blocked.textReads, allowed.textReads], [2, 2]);

  // With every comment hidden, or no keywords, no comment text is read.
  content.storageListeners[0]({ hideComments: { newValue: true } }, "local");
  await settle();
  content.processFilteredContent();
  assert.deepEqual([blocked.textReads, allowed.textReads], [2, 2]);
  assert.equal("frontfilterCommentHidden" in allowed.dataset, false);

  content.storageListeners[0]({
    hideComments: { newValue: false },
    blockedTitleKeywords: { newValue: [] },
  }, "local");
  await settle();
  assert.deepEqual([blocked.textReads, allowed.textReads], [2, 2]);
  assert.equal("frontfilterCommentHidden" in allowed.dataset, false);
});

test("reads a comment again once its text changes", async () => {
  // Reddit can insert a comment before all of its text has arrived.
  const comment = createComment("Breaking");
  const reply = createComment("Nice photo");
  let text = "Breaking";
  comment.querySelector('[slot="comment"]').closest = () => comment;
  Object.defineProperty(comment.querySelector('[slot="comment"]'), "textContent", {
    get: () => {
      comment.textReads += 1;
      return text;
    },
  });
  const content = await loadContent({
    querySelectorAll: (selector) => ({
      "shreddit-comment": [comment, reply],
      '[data-frontfilter-comment-hidden="true"]': [comment, reply].filter(
        (element) => element.dataset.frontfilterCommentHidden === "true",
      ),
    })[selector] || [],
    settings: { blockedTitleKeywords: ["Trump"] },
    startUrl: "https://www.reddit.com/r/test/comments/abc/post/",
  });
  assert.equal("frontfilterCommentHidden" in comment.dataset, false);
  assert.deepEqual([comment.textReads, reply.textReads], [1, 1]);

  // Text inside a comment's body is read; the comment's replies keep their
  // verdicts.
  const inComment = (selector) => {
    if (selector.includes('[slot="comment"]') || selector.includes("shreddit-comment")) return comment;
    return null;
  };
  text = "Breaking: Trump wins";
  content.observers[0].callback([{
    type: "characterData",
    target: { parentElement: { closest: inComment } },
  }]);
  assert.equal(comment.dataset.frontfilterCommentHidden, "true");
  assert.deepEqual([comment.textReads, reply.textReads], [2, 1]);

  // Text elsewhere, such as a timestamp, is not.
  content.observers[0].callback([{
    type: "characterData",
    target: { parentElement: { closest: () => null } },
  }]);
  assert.deepEqual([comment.textReads, reply.textReads], [2, 1]);
});

test("skips page-wide post scans when only comments change", async () => {
  const comment = createComment("Nice photo");
  const content = await loadContent({
    querySelectorAll: (selector) => selector === "shreddit-comment" ? [comment] : [],
    settings: { blockedTitleKeywords: ["trump"] },
    startUrl: "https://www.reddit.com/r/test/comments/abc/post/",
  });
  const postScans = () => content.queriedSelectors.filter(isPostCollectionSelector).length;
  const insideComments = { closest: (selector) => selector.includes("shreddit-comment") ? {} : null };
  const outsideComments = { closest: () => null };
  const textInComments = { parentElement: insideComments };

  const initialScans = postScans();
  assert.ok(initialScans > 0);
  // Collections are looked up once and stay live: comments for filters,
  // and posts for statistics, which count the hidden ones.
  assert.deepEqual(content.liveCollections, [
    "shreddit-comment", ".thing.comment", "shreddit-post", "shreddit-ad-post",
  ]);

  content.observers[0].callback([{ target: insideComments }, { target: textInComments }]);
  assert.equal(postScans(), initialScans);
  content.observers[0].callback([{ target: insideComments }, { target: outsideComments }]);
  assert.equal(postScans(), initialScans + 1);
  assert.equal(content.liveCollections.length, 4);
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

test("keeps posts and comments that contain an allowed keyword", async () => {
  const bodyElement = {
    textContent: "Also about Biden",
    closest(selector) {
      return selector.includes("shreddit-comment") ? null : previewedPost;
    },
  };
  // The preview's allowed keyword keeps the whole post.
  const previewedPost = {
    dataset: {},
    getAttribute: (name) => (name === "post-title" ? "Trump rally" : null),
    querySelectorAll(selector) {
      return selector.includes('[slot="text-body"]') ? [bodyElement] : [];
    },
  };
  const blockedPost = createPost({ title: "Trump rally" });
  const allowedPost = createPost({ title: "Trump and BIDEN debate" });
  const posts = [previewedPost, blockedPost, allowedPost];
  const blockedComment = createComment("Trump again");
  const allowedComment = createComment("Trump or Bidén?");
  const comments = [blockedComment, allowedComment];
  const content = await loadContent({
    querySelectorAll: (selector) => {
      if (isPostCollectionSelector(selector)) return posts;
      if (selector === "shreddit-comment") return comments;
      if (selector === '[data-frontfilter-post-hidden="true"]') {
        return posts.filter((post) => post.dataset.frontfilterPostHidden === "true");
      }
      if (selector === '[data-frontfilter-comment-hidden="true"]') {
        return comments.filter((comment) => comment.dataset.frontfilterCommentHidden === "true");
      }
      return [];
    },
    settings: { blockedTitleKeywords: ["trump"], allowedKeywords: ["biden"] },
    startUrl: "https://www.reddit.com/r/test/comments/abc/post/",
  });
  const hidden = () => [
    ...posts.map((post) => post.dataset.frontfilterPostHidden === "true"),
    ...comments.map((comment) => comment.dataset.frontfilterCommentHidden === "true"),
  ];

  assert.deepEqual(hidden(), [false, true, false, true, false]);

  // Without exceptions every match hides; exceptions alone hide nothing.
  content.storageListeners[0]({ allowedKeywords: { newValue: [] } }, "local");
  await settle();
  assert.deepEqual(hidden(), [true, true, true, true, true]);
  content.storageListeners[0]({
    blockedTitleKeywords: { newValue: [] },
    allowedKeywords: { newValue: ["biden"] },
  }, "local");
  await settle();
  assert.deepEqual(hidden(), [false, false, false, false, false]);
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
  await settle();

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
      if (selector.startsWith('a[href*="/comments/"]:not(')) return [link];
      return [];
    },
    settings: {
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.equal(post.dataset.frontfilterPostHidden, "true");
});

test("does not take a post for one from the subreddit of a thread it links to", async () => {
  const post = createPost({ subreddit: "r/pics" });
  const link = {
    getAttribute: () => "https://www.reddit.com/r/firefox/comments/abc/a-thread",
    closest: (selector) => selector.includes("shreddit-comment") ? null : post,
  };
  await loadContent({
    querySelectorAll(selector) {
      if (isPostCollectionSelector(selector)) return [post];
      if (selector.startsWith('a[href*="/comments/"]:not(')) return [link];
      return [];
    },
    settings: { blockedSubreddits: [{ name: "firefox", mode: "all" }] },
    startUrl: "https://www.reddit.com/",
  });
  assert.equal("frontfilterPostHidden" in post.dataset, false);
});

// A crosspost card as Reddit renders it: marked as one, with a content link
// to the post it shares. A link post can link to a thread without sharing it.
function createCrosspost(subreddit, source, { marked = true } = {}) {
  const post = createPost({ subreddit });
  const getOwnAttribute = post.getAttribute;
  post.getAttribute = (name) => name === "content-href" ? source : getOwnAttribute(name);
  post.matches = (selector) => marked && selector === '[is-crosspost], [post-type="crosspost" i]';
  return post;
}

test("hides crossposts of posts from ALL-mode subreddits, in pages and the scroll limit", async () => {
  const posts = [
    createCrosspost("pics", "/r/Firefox/comments/abc/a_post/"),
    createCrosspost("pics", "https://www.reddit.com/r/firefox/comments/def/a_post/"),
    createCrosspost("pics", "/r/firefox/comments/ghi/a_thread/", { marked: false }),
    // Profiles are not subreddits, HOME rules only block front pages, and
    // exceptions keep their subreddit's posts.
    createCrosspost("pics", "/user/firefox/comments/jkl/a_post/"),
    createCrosspost("pics", "/r/news/comments/mno/a_post/"),
    createCrosspost("pics", "/r/firefoxdev/comments/pqr/a_post/"),
  ];
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? posts : [],
    settings: {
      blockedSubreddits: [{ name: "firefox*", mode: "all" }, { name: "news", mode: "home" }],
      allowedSubreddits: ["firefoxdev"],
    },
    startUrl: "https://www.reddit.com/",
  });

  assert.deepEqual(
    posts.map((post) => post.dataset.frontfilterPostHidden === "true"),
    [true, true, false, false, false, false],
  );
  assert.ok(content.observerOptions.at(-1).attributeFilter.includes("content-href"));
  const record = (crosspostedFrom) => ({
    subreddit: "pics", crosspostedFrom, title: "", bodyTexts: [], recommended: false, author: "",
  });
  assert.equal(content.isFeedRecordBlocked(record("firefox")), true);
  assert.equal(content.isFeedRecordBlocked(record("firefoxdev")), false);
  assert.equal(content.isFeedRecordBlocked(record("")), false);
});

// A post whose title can change, counting how often filters read it.
function createChangingPost(title) {
  return {
    dataset: {},
    title,
    titleReads: 0,
    getAttribute(name) {
      if (name === "data-subreddit") return "pics";
      if (name !== "post-title") return null;
      this.titleReads += 1;
      return this.title;
    },
    closest(selector) {
      return selector.includes("shreddit-post") ? this : null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

test("reads a post again only once it or the settings change", async () => {
  const post = createChangingPost("A calm headline");
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedTitleKeywords: ["breaking"] },
    startUrl: "https://www.reddit.com/",
  });
  const reads = post.titleReads;
  assert.ok(reads > 0);
  content.processFilteredContent();
  assert.equal(post.titleReads, reads);

  post.title = "Breaking: a headline";
  content.observers[0].callback([{ type: "attributes", target: post }]);
  assert.equal(post.dataset.frontfilterPostHidden, "true");

  content.storageListeners[0]({
    blockedTitleKeywords: { oldValue: ["breaking"], newValue: ["calm"] },
  }, "local");
  await settle();
  assert.equal("frontfilterPostHidden" in post.dataset, false);
});

test("ignores text and class changes where filters do not look", async () => {
  const post = createChangingPost("A calm headline");
  const content = await loadContent({
    querySelectorAll: (selector) => isPostCollectionSelector(selector) ? [post] : [],
    settings: { blockedTitleKeywords: ["breaking"] },
    startUrl: "https://www.reddit.com/",
  });
  const postScans = () => content.queriedSelectors.filter(isPostCollectionSelector).length;
  const scans = postScans();
  const text = (inPostText) => ({
    type: "characterData",
    target: { parentElement: { closest: (selector) => inPostText && selector.includes('[slot="title"]') ? post : null } },
  });

  const classChange = (target) => ({ type: "attributes", attributeName: "class", target });

  // A timestamp ticks and a menu opens: nothing to filter.
  content.observers[0].callback([text(false), classChange({ closest: () => null })]);
  assert.equal(postScans(), scans);
  // A title's text changes.
  content.observers[0].callback([text(true)]);
  assert.equal(postScans(), scans + 1);
  // A post's classes change.
  content.observers[0].callback([classChange(post)]);
  assert.equal(postScans(), scans + 2);
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
  await settle();

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
  await settle();

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
  await settle();

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

// Statistics

// The records this page sent the background, as it received them.
function sentRecords(content) {
  return content.sentMessages
    .filter(({ action }) => action === "recordStats")
    .map(({ record }) => record);
}

const emptyRecord = (fields) => ({ time: 0, posts: {}, comments: {}, blocked: {}, ...fields });

// A modern Reddit post, with its attributes, in a feed.
function createTaggedPost(attributes = {}) {
  return {
    dataset: {},
    localName: "shreddit-post",
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    matches: () => false,
    closest: (selector) => (selector === "shreddit-feed" ? {} : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// Lets the page's 10-second clock run for a while, in its steps.
async function spend(content, ms) {
  for (let elapsed = 0; elapsed < ms; elapsed += 10000) {
    content.clock.now += Math.min(10000, ms - elapsed);
    await content.poll();
  }
}

test("counts time while the page is in front and in use, and sends it every minute", async () => {
  const content = await loadContent({ focused: true, settings: {}, startUrl: "https://www.reddit.com/" });
  await spend(content, 50000);
  assert.deepEqual(sentRecords(content), []);
  content.dispatchWindow("scroll");
  await spend(content, 10000);
  assert.deepEqual(sentRecords(content), [emptyRecord({ time: 60000 })]);

  // Behind another tab, it stops and sends what it counted.
  await spend(content, 20000);
  content.setFocused(false);
  assert.deepEqual(sentRecords(content).at(-1), emptyRecord({ time: 20000 }));
  await spend(content, 60000);
  assert.equal(sentRecords(content).length, 2);

  // In front again, it counts once the reader does something.
  content.setFocused(true);
  await spend(content, 30000);
  content.setFocused(false);
  assert.deepEqual(sentRecords(content).at(-1), emptyRecord({ time: 30000 }));
});

const sentTime = (content) => sentRecords(content).reduce((sum, { time }) => sum + time, 0);

test("stops counting time 5 minutes after the last input", async () => {
  const content = await loadContent({ focused: true, settings: {}, startUrl: "https://www.reddit.com/" });
  await spend(content, 4 * 60000 + 30000);
  assert.equal(sentTime(content), 4 * 60000);
  await spend(content, 2 * 60000 + 30000);
  assert.equal(sentTime(content), 5 * 60000);

  // Input brings it back.
  content.dispatchWindow("keydown");
  await spend(content, 40000);
  content.setFocused(false);
  assert.equal(sentTime(content), 5 * 60000 + 40000);
});

// A Reddit page open when FrontFilter was installed or updated in Chrome,
// which the background script gives the recorder alone.
const loadStatsOnly = (options) => loadContent({
  focused: true, startUrl: "https://www.reddit.com/", ...options, scripts: STATS_RECORDER_SCRIPTS,
});

test("counts time alone on a page open before an update, as content scripts do", async () => {
  const content = await loadStatsOnly({ settings: {} });
  await spend(content, 60000);
  assert.deepEqual(sentRecords(content), [emptyRecord({ time: 60000 })]);

  // Behind another tab, it stops and sends what it counted.
  await spend(content, 20000);
  content.setFocused(false);
  assert.deepEqual(sentRecords(content).at(-1), emptyRecord({ time: 20000 }));
  // It stops 5 minutes after the last input.
  content.setFocused(true);
  content.dispatchWindow("wheel");
  await spend(content, 7 * 60000);
  assert.equal(sentTime(content), 80000 + 5 * 60000);
  // It reads no page and answers no message, so the settings page treats
  // the page as one without a content script.
  assert.deepEqual(content.queriedSelectors, []);
  assert.equal(await content.ask({ action: "countHidden" }), undefined);
});

test("counts no time on a page open before an update while statistics are paused", async () => {
  const content = await loadStatsOnly({ settings: { pauseStatistics: true } });
  await spend(content, 2 * 60000);
  assert.deepEqual(sentRecords(content), []);

  // Unpaused, it counts from then on.
  content.storageListeners.forEach((listener) => listener({ pauseStatistics: { newValue: false } }, "local"));
  content.dispatchWindow("pointerdown");
  await spend(content, 60000);
  assert.deepEqual(sentRecords(content), [emptyRecord({ time: 60000 })]);

  // Paused again, it sends nothing more.
  content.storageListeners.forEach((listener) => listener({ pauseStatistics: { newValue: true } }, "local"));
  content.dispatchWindow("pointerdown");
  await spend(content, 2 * 60000);
  content.setFocused(false);
  assert.equal(sentRecords(content).length, 1);
});

test("counts nothing, and reads no post, while statistics are paused", async () => {
  const post = createTaggedPost({ nsfw: "" });
  const content = await loadContent({
    focused: true,
    querySelectorAll: (selector) => (selector === "shreddit-post" ? [post] : []),
    settings: { pauseStatistics: true, hideNsfw: true },
    startUrl: "https://www.reddit.com/",
  });
  await spend(content, 2 * 60000);
  content.runTimers();
  assert.deepEqual(sentRecords(content), []);
  assert.deepEqual(content.liveCollections, []);

  // Unpaused, it counts from then on.
  content.storageListeners[0]({ pauseStatistics: { oldValue: true, newValue: false } }, "local");
  await settle();
  content.dispatchWindow("pointerdown");
  await spend(content, 60000);
  content.runTimers();
  // What was held back goes together.
  assert.deepEqual(sentRecords(content), [emptyRecord({ time: 60000, posts: { nsfw: 1 } })]);
});

test("counts the posts filters and page rules hide, once each, by the first reason", async () => {
  const posts = [
    // Blocked subreddits and users come before keywords, then kinds of posts.
    createTaggedPost({ "data-subreddit": "news", "post-title": "Breaking", nsfw: "" }),
    createTaggedPost({ author: "Spez", "post-title": "Breaking" }),
    createTaggedPost({ "post-title": "Breaking news", nsfw: "" }),
    createTaggedPost({ nsfw: "", spoiler: "" }),
    createTaggedPost({ spoiler: "" }),
    createTaggedPost({ "recommendation-source": "similar" }),
    createTaggedPost({ "is-promoted": "" }),
    createTaggedPost({ "post-title": "Calm" }),
  ];
  const content = await loadContent({
    querySelectorAll: (selector) => (isPostCollectionSelector(selector) || selector === "shreddit-post" ? posts : []),
    settings: {
      blockedSubreddits: [{ name: "news", mode: "all" }],
      blockedUsers: ["spez"],
      blockedTitleKeywords: ["breaking"],
      hideNsfw: true,
      hideSpoilers: true,
      hideSuggestedPosts: true,
      hideAds: true,
    },
    startUrl: "https://www.reddit.com/",
  });
  content.runTimers();
  assert.deepEqual(sentRecords(content), [emptyRecord({
    posts: { subreddits: 1, users: 1, keywords: 1, nsfw: 1, spoilers: 1, suggested: 1, ads: 1 },
  })]);

  // Later passes count no post again.
  content.processFilteredContent();
  content.runTimers();
  assert.equal(sentRecords(content).length, 1);

  // A post that a new filter hides counts then.
  content.storageListeners[0]({
    blockedTitleKeywords: { oldValue: ["breaking"], newValue: ["breaking", "calm"] },
  }, "local");
  await settle();
  content.runTimers();
  assert.deepEqual(sentRecords(content).at(-1), emptyRecord({ posts: { keywords: 1 } }));
});

test("counts suggested posts as hidden only in the Home feed", async () => {
  const post = createTaggedPost({ "recommendation-source": "similar" });
  const content = await loadContent({
    querySelectorAll: (selector) => (selector === "shreddit-post" ? [post] : []),
    settings: { hideSuggestedPosts: true },
    startUrl: "https://www.reddit.com/r/popular/",
  });
  content.runTimers();
  assert.deepEqual(sentRecords(content), []);
});

test("counts the comments of blocked users and those keywords hide", async () => {
  const comments = [createComment("Breaking: a reply"), createComment("Fine"), createComment("Also fine")];
  const authors = ["someone", "someone", "Spez"];
  comments.forEach((comment, index) => {
    comment.getAttribute = (name) => (name === "author" ? authors[index] : null);
  });
  const content = await loadContent({
    querySelectorAll: (selector) => (selector === "shreddit-comment" ? comments : []),
    settings: { blockedTitleKeywords: ["breaking"], blockedUsers: ["spez"] },
    startUrl: POST_PAGE,
  });
  content.processFilteredContent();
  content.runTimers();
  assert.deepEqual(sentRecords(content), [emptyRecord({ comments: { keywords: 1, users: 1 } })]);

  // Comments hidden with all the others are not filtered.
  const allHidden = await loadContent({
    querySelectorAll: (selector) => (selector === "shreddit-comment" ? comments : []),
    settings: { blockedTitleKeywords: ["breaking"], blockedUsers: ["spez"], hideComments: true },
    startUrl: POST_PAGE,
  });
  allHidden.runTimers();
  assert.deepEqual(sentRecords(allHidden), []);
});

test("tells the settings page what filters hide on it, when asked", async () => {
  const posts = [
    createTaggedPost({ "data-subreddit": "news", nsfw: "" }),
    createTaggedPost({ spoiler: "" }),
    createTaggedPost({ "is-promoted": "" }),
    createTaggedPost({ "post-title": "Calm" }),
  ];
  const comments = [createComment("Breaking: a reply"), createComment("Fine"), createComment("Also fine")];
  const authors = ["someone", "someone", "Spez"];
  comments.forEach((comment, index) => {
    comment.getAttribute = (name) => (name === "author" ? authors[index] : null);
  });
  const page = { uncounted: false };
  const querySelectorAll = (selector) => {
    if (isPostCollectionSelector(selector) || selector === "shreddit-post") return posts;
    if (selector === "shreddit-comment") return comments;
    return selector.includes(".thing") && page.uncounted ? [{}] : [];
  };
  const settings = {
    blockedSubreddits: [{ name: "news", mode: "all" }],
    blockedUsers: ["spez"],
    blockedTitleKeywords: ["breaking"],
    hideNsfw: true,
    hideAds: true,
    // The count is not kept, so it does not pause with statistics.
    pauseStatistics: true,
  };
  const content = await loadContent({ querySelectorAll, settings, startUrl: POST_PAGE });
  content.processFilteredContent();
  // Each post or comment counts once, whatever hides it.
  assert.deepEqual(await content.ask({ action: "countHidden" }), { posts: 2, comments: 2 });
  assert.equal(await content.ask({ action: "somethingElse" }), undefined);

  // It follows the settings.
  content.storageListeners[0]({ hideSpoilers: { oldValue: false, newValue: true } }, "local");
  await settle();
  assert.deepEqual(await content.ask({ action: "countHidden" }), { posts: 3, comments: 2 });

  // Comments hidden with all the others are not filtered.
  content.storageListeners[0]({ hideComments: { oldValue: false, newValue: true } }, "local");
  await settle();
  assert.deepEqual(await content.ask({ action: "countHidden" }), { posts: 3, comments: 0 });

  // A page with posts statistics do not read, as Old Reddit's or search
  // results, gives no count.
  page.uncounted = true;
  assert.equal(await content.ask({ action: "countHidden" }), null);
});

test("counts a page it leaves for the chosen website as blocked, before leaving", async () => {
  const content = await loadContent({
    settings: {
      blockedSubreddits: [{ name: "news*", mode: "all" }],
      redirectBlockedPages: true,
      redirectUrl: "https://example.com/",
    },
    startUrl: "https://www.reddit.com/r/newsbot/comments/abc/post",
  });
  assert.deepEqual(content.redirects, ["https://example.com/"]);
  assert.deepEqual(sentRecords(content), [emptyRecord({ blocked: { "subreddit:newsbot": 1 } })]);

  // The block page counts the visits it shows itself.
  const toBlockPage = await loadContent({
    settings: { blockPopular: true },
    startUrl: "https://www.reddit.com/r/popular/",
  });
  assert.equal(toBlockPage.redirects.length, 1);
  assert.deepEqual(sentRecords(toBlockPage), []);
});
