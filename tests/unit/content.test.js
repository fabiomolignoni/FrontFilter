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

async function loadContent({ querySelectorAll = () => [], settings, startUrl, body = {} }) {
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
  const document = {
    body,
    addEventListener(type, listener) {
      if (type === "DOMContentLoaded") readyListeners.push(listener);
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
    },
  };
  const observers = [];
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
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
    Event,
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

  for (const file of [
    "shared/core.js", "content/selectors.js", "content/posts.js", "content/page-style.js",
    "content/autoplay.js", "content/quick-block.js", "content/main.js",
  ]) {
    const source = readFileSync(join(__dirname, "..", "..", "src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
    if (file === "shared/core.js") {
      vm.runInContext(`FrontFilter.createFeedLimiter = (options) => {
        FrontFilterFeedStub.options = options;
        return FrontFilterFeedStub;
      };`, context);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));

  return {
    checkCurrentPage: context.checkCurrentPage,
    getFeedLimiterUpdateCount: () => context.FrontFilterFeedStub.updateCount,
    isFeedRecordBlocked: (record) => context.FrontFilterFeedStub.options.isBlocked(record),
    processFilteredContent: context.processFilteredContent,
    // Simulates the parser reaching the end of the page.
    async finishParsing() {
      document.body = {};
      readyListeners.splice(0).forEach((listener) => listener());
      await new Promise((resolve) => setImmediate(resolve));
    },
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
    await new Promise((resolve) => setImmediate(resolve));
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
    settings: Object.fromEntries(Object.keys(PAGE_RULE_SETTINGS).map((key) => [key, true])),
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
    await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(content.isFeedRecordBlocked(suggested), false);
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
  // The page-world bridge then asks the restored player to try autoplay.
  assert.deepEqual(player.dispatchedEvents, ["frontfilter-autoplay-restored"]);
  assert.deepEqual(playerVideo.dispatchedEvents, []);
  assert.deepEqual(nativeVideo.dispatchedEvents, []);
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal("frontfilterCommentHidden" in blocked.dataset, false);
  assert.equal(allowed.dataset.frontfilterCommentHidden, "true");
  assert.deepEqual([blocked.textReads, allowed.textReads], [2, 2]);

  // With every comment hidden, or no keywords, no comment text is read.
  content.storageListeners[0]({ hideComments: { newValue: true } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  content.processFilteredContent();
  assert.deepEqual([blocked.textReads, allowed.textReads], [2, 2]);
  assert.equal("frontfilterCommentHidden" in allowed.dataset, false);

  content.storageListeners[0]({
    hideComments: { newValue: false },
    blockedTitleKeywords: { newValue: [] },
  }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([blocked.textReads, allowed.textReads], [2, 2]);
  assert.equal("frontfilterCommentHidden" in allowed.dataset, false);
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
  // Comment collections are looked up once and stay live.
  assert.deepEqual(content.liveCollections, ["shreddit-comment", ".thing.comment"]);

  content.observers[0].callback([{ target: insideComments }, { target: textInComments }]);
  assert.equal(postScans(), initialScans);
  content.observers[0].callback([{ target: insideComments }, { target: outsideComments }]);
  assert.equal(postScans(), initialScans + 1);
  assert.equal(content.liveCollections.length, 2);
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
