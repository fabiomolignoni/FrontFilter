/**
 * FrontFilter - Content Script
 * Handles filtering posts and SPA navigation blocking.
 */

const settingsStore = FrontFilter.createSettingsStore(chrome.storage.local, {
  onLoadError(error) {
    console.error("Could not load FrontFilter settings:", error);
  },
});
let config = settingsStore.get();
let filterIndex = createFilterIndex(config);
let configLoaded = false;
let lastCheckedUrl = "";
let observer = null;
let processingScheduled = false;
let postFilteringActive = false;
let communityFilteringActive = false;
let commentActionsHidden = false;
let videoAutoplayDisabled = false;
let mainPageLinksHidden = false;
let observerOptionsSignature = "";
const feedLimiter = FrontFilter.createFeedLimiter({
  getSettings: () => config,
  isBlocked: ({ subreddit, title, bodyTexts }) =>
    isSubredditNameBlocked(subreddit)
    || containsBlockedPostText(title, bodyTexts),
});

const HIDDEN_STYLE_ID = "frontfilter-hidden-style";
const HIDDEN_ELEMENT_TYPES = Object.freeze({
  post: Object.freeze({
    datasetKey: "frontfilterPostHidden",
    selector: '[data-frontfilter-post-hidden="true"]',
  }),
  community: Object.freeze({
    datasetKey: "frontfilterCommunityHidden",
    selector: '[data-frontfilter-community-hidden="true"]',
  }),
});
const HIDDEN_STYLE_TEXT = Object.values(HIDDEN_ELEMENT_TYPES)
  .map(({ selector }) => selector)
  .join(", ") + " { display: none !important; }";

const POST_ROOT_SELECTORS = [
  '[data-testid="post-container"]',
  '[data-testid="post"]',
  "[data-post-id]",
  ".Post",
  "shreddit-post",
  ".thing",
  "article",
  '[role="article"]',
  ".post-container",
];
const POST_FALLBACK_SELECTORS = [
  '[data-click-id="body"]',
  "[data-ks-id]",
];
const POST_ROOT_SELECTOR = POST_ROOT_SELECTORS.join(", ");
const POST_SELECTOR = [...POST_ROOT_SELECTORS, ...POST_FALLBACK_SELECTORS].join(", ");
const POST_PERMALINK_SELECTOR = 'a[href*="/comments/"]';
const COMMENT_LAYOUT_SELECTOR = [
  "shreddit-comment",
  "shreddit-comment-tree",
  '[data-testid="comment"]',
  '[data-testid="comment-tree"]',
  ".Comment",
  ".comment",
].join(", ");
const COMMENT_ACTION_SELECTOR = [
  '[data-action-bar-action="comments"]',
  '[data-post-click-location="comments-button"]',
  '[name="comments-action-button"]',
  '[data-click-id="comments"]',
  "a.comments",
].join(", ");
const COMMENT_VISIBILITY_SELECTOR = [
  COMMENT_LAYOUT_SELECTOR,
  COMMENT_ACTION_SELECTOR,
].join(", ");
const COMMENT_REPLY_SELECTOR = [
  'shreddit-comment[depth]:not([depth="0"])',
  'shreddit-comment-tree[depth]:not([depth="0"])',
  'shreddit-comment[parent-id^="t1_"]',
  'shreddit-comment[parentid^="t1_"]',
  "shreddit-comment shreddit-comment",
  'shreddit-comment [slot="children"]',
  '[data-testid="comment"][data-depth]:not([data-depth="0"])',
  '[data-testid="comment"][depth]:not([depth="0"])',
  '[data-testid="comment"][data-parent-id^="t1_"]',
  '[data-testid="comment"] [data-testid="comment"]',
  '[data-testid="comment"] [data-testid="comment-children"]',
  ".Comment .Comment",
  ".comment .comment",
  ".comment > .child",
].join(", ");
const COMMENT_ACTION_STYLE_ID = "frontfilter-comment-actions-style";
const COMMENT_ACTION_STYLE_TEXT = `${COMMENT_ACTION_SELECTOR} { display: none !important; }`;
const SUGGESTED_COMMUNITIES_SELECTOR = "in-feed-community-recommendations";
const MAIN_PAGE_LINK_STYLE_ID = "frontfilter-main-page-links-style";
const AUTOPLAY_ATTRIBUTE_NAMES = [
  "autoplay",
  "autoplay-pref",
  "muted-autoplay-fallback",
];
const AUTOPLAY_STATE_ATTRIBUTE = "data-frontfilter-autoplay-state";
const NAVBAR_SELECTOR = [
  "#header",
  "#shreddit-header",
  "reddit-header-large",
  "reddit-header-small",
  "shreddit-app > header",
  'header[role="banner"]',
].join(", ");
// Shreddit reserves space for its fixed navbar separately from the header itself.
// Reset both layout variables at their roots so padding and sticky offsets collapse.
const NAVBAR_LAYOUT_STYLE = ":root, body, shreddit-app { --shreddit-header-height: 0px !important; --header-height: 0px !important; }";
const NAVBAR_COMPONENT_SCOPES = [
  "#header",
  "#shreddit-header",
  "reddit-header-large",
  "reddit-header-small",
  "shreddit-app > header",
  'header[role="banner"]',
  "nav.h-header-large",
];
function scopeNavbarSelectors(selectors) {
  return NAVBAR_COMPONENT_SCOPES.flatMap((scope) =>
    selectors.map((selector) => `${scope} ${selector}`)
  ).join(", ");
}
const NAVBAR_SECTION_SELECTORS = Object.freeze({
  hideNavbarMenu: scopeNavbarSelectors([
    "#hamburger-button-tooltip",
    "#navbar-menu-button",
    "rpl-tooltip:has(#navbar-menu-button)",
  ]),
  hideNavbarSearch: scopeNavbarSelectors([
    'faceplate-loader[name^="SearchInputDesktop_"]',
    "search-dynamic-id-cache-controller",
    "reddit-search-large",
    "reddit-search-small",
  ]),
  hideNavbarChat: scopeNavbarSelectors([
    '[data-part="chat"]',
    "reddit-chat-header-button",
    "#header-action-item-chat-button",
  ]),
  hideNavbarNotifications: scopeNavbarSelectors([
    '[data-part="inbox"]',
    "#notifications-inbox-button",
  ]),
  hideNavbarProfile: scopeNavbarSelectors([
    "div:has(> rpl-dropdown #expand-user-drawer-button)",
    "rpl-dropdown:has(#expand-user-drawer-button)",
    "#expand-user-drawer-button",
  ]),
  hideNavbarOthers: scopeNavbarSelectors([
    '[data-part]:not([data-part="chat"]):not([data-part="inbox"]):not([data-part="menu"]):not([data-part="search"]):not([data-part="profile"]):not([data-part="logo"]):not(:has(#reddit-logo)):not(:has(#navbar-menu-button)):not(:has(reddit-search-large)):not(:has(reddit-search-small)):not(:has(#expand-user-drawer-button))',
  ]),
});
const NAVBAR_LOGO_SELECTOR = scopeNavbarSelectors([
  "#reddit-logo",
  "a:has(#reddit-logo)",
  '[data-part="logo"]',
  'a:has([data-part="logo"])',
]);
const LEFT_SIDEBAR_SELECTOR = [
  "#left-sidebar-container",
  "#left-sidebar",
].join(", ");
const MAIN_PAGE_LINK_SELECTORS = Object.freeze({
  blockHomepage: [
    'a[href="/" i]',
    'a[href^="/?" i]',
    'a[href="https://www.reddit.com/" i]',
    'a[href^="https://www.reddit.com/?" i]',
    ...FrontFilter.LISTING_SORTS.flatMap((sort) => [
      `a[href="/${sort}" i]`,
      `a[href^="/${sort}/" i]`,
      `a[href^="/${sort}?" i]`,
      `a[href="https://www.reddit.com/${sort}" i]`,
      `a[href^="https://www.reddit.com/${sort}/" i]`,
      `a[href^="https://www.reddit.com/${sort}?" i]`,
    ]),
  ],
  blockPopular: [
    'a[href="/r/popular" i]',
    'a[href^="/r/popular/" i]',
    'a[href^="/r/popular?" i]',
    'a[href="https://www.reddit.com/r/popular" i]',
    'a[href^="https://www.reddit.com/r/popular/" i]',
    'a[href^="https://www.reddit.com/r/popular?" i]',
  ],
  blockExplore: [
    'a[href="/explore" i]',
    'a[href^="/explore/" i]',
    'a[href^="/explore?" i]',
    'a[href="https://www.reddit.com/explore" i]',
    'a[href^="https://www.reddit.com/explore/" i]',
    'a[href^="https://www.reddit.com/explore?" i]',
  ],
  blockNews: [
    'a[href="/news" i]',
    'a[href^="/news/" i]',
    'a[href^="/news?" i]',
    'a[href="https://www.reddit.com/news" i]',
    'a[href^="https://www.reddit.com/news/" i]',
    'a[href^="https://www.reddit.com/news?" i]',
  ],
});
const MAIN_PAGE_SETTING_KEYS = Object.freeze(Object.keys(MAIN_PAGE_LINK_SELECTORS));
// These structural identifiers are stable across Reddit locales. Include the
// async placeholders so a hidden section cannot flash while it is loading.
const LEFT_SIDEBAR_SECTION_SELECTORS = Object.freeze({
  hideLeftSidebarGames: [
    '#left-sidebar faceplate-loader[name^="LeftNavGamesSection_"]',
    '#left-sidebar faceplate-tracker[noun="games_drawer"]',
  ].join(", "),
  hideLeftSidebarCustomFeeds: [
    '#left-sidebar faceplate-loader[name^="LeftNavMultiredditsSection_"]',
    '#left-sidebar faceplate-expandable-section-helper:has(> details > summary[aria-controls="multireddits_section"])',
  ].join(", "),
  hideLeftSidebarRecent: [
    '#left-sidebar faceplate-loader[name^="LeftNavRecentSection_"]',
    "#left-sidebar #recent-communities-section",
  ].join(", "),
  hideLeftSidebarCommunities: [
    '#left-sidebar faceplate-loader[name^="LeftNavCommunitiesSection_"]',
    '#left-sidebar faceplate-expandable-section-helper:has(> details > summary[aria-controls="communities_section"])',
  ].join(", "),
  hideLeftSidebarResources: [
    '#left-sidebar faceplate-loader[name^="LeftNavResourcesSection_"]',
    '#left-sidebar faceplate-expandable-section-helper:has(faceplate-tracker[noun="resources_menu"])',
  ].join(", "),
});
// Match component names and internal identifiers, never translated labels or text.
const RIGHT_SIDEBAR_SELECTOR = [
  "#right-sidebar-container",
  "#right-sidebar",
  ".right-sidebar",
  '[data-testid="right-sidebar"]',
  '[data-testid="right-sidebar-container"]',
  ".side",
  "pdp-right-rail",
  "aside:has(> pdp-right-rail)",
].join(", ");
const POPULAR_COMMUNITIES_SELECTOR = [
  '[data-testid*="popular-communities" i]',
  "popular-communities",
  "shreddit-popular-communities",
  "#right-sidebar-container",
  '[data-testid*="right-sidebar" i]',
  "aside",
].join(", ");

function createFilterIndex(settings) {
  return {
    allowedSubreddits: new Set(settings.allowedSubreddits),
    blockedAllSubreddits: settings.blockedSubreddits.filter(
      (entry) => entry.mode === "all",
    ),
    blockedFrontSubreddits: settings.blockedSubreddits,
    blockedKeywords: settings.blockedTitleKeywords.map((keyword) =>
      keyword.toLowerCase()
    ),
  };
}

function setConfig(settings) {
  config = settings;
  filterIndex = createFilterIndex(settings);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  setConfig(settingsStore.applyChanges(changes));
  if (configLoaded) feedLimiter.update();

  void checkCurrentPage({ force: true });
  void filterPosts();
});

async function loadConfig() {
  if (!configLoaded) {
    const loadedConfig = await settingsStore.load();
    if (!configLoaded) {
      setConfig(loadedConfig);
      configLoaded = true;
      feedLimiter.update();
    }
  }
  return config;
}

async function checkCurrentPage({ force = false } = {}) {
  await loadConfig();

  const currentUrl = window.location.href;
  const urlChanged = currentUrl !== lastCheckedUrl;
  if (!force && !urlChanged) return;
  lastCheckedUrl = currentUrl;
  if (urlChanged) feedLimiter.update();
  const path = window.location.pathname;
  const route = FrontFilter.getBlockedRoute(path, config);
  if (route) {
    redirectToBlock(route, currentUrl);
  }
}

function redirectToBlock(route, returnUrl) {
  window.location.replace(
    chrome.runtime.getURL("blocked/index.html") + FrontFilter.blockedRouteToQuery(route, returnUrl)
  );
}

function getPostSubredditNames(postElement) {
  const names = new Set();
  const attributeNames = [
    "subreddit-name",
    "subreddit-prefixed-name",
    "data-subreddit",
    "data-subreddit-prefixed",
  ];

  for (const attributeName of attributeNames) {
    const name = FrontFilter.normalizeSubredditName(postElement.getAttribute(attributeName));
    if (name) names.add(name);
  }

  if (names.size > 0) return names;

  for (const link of postElement.querySelectorAll('a[href*="/r/"]')) {
    const nestedPost = link.closest(POST_ROOT_SELECTOR);
    if (nestedPost && nestedPost !== postElement) continue;

    try {
      const href = link.getAttribute("href");
      const url = FrontFilter.getRedditUrl(href, window.location.origin);
      const subreddit = url && FrontFilter.getSubredditPath(url.pathname);
      if (subreddit) names.add(subreddit.name);
    } catch {
      // Ignore malformed links injected by page content.
    }
  }

  return names;
}

function isSubredditNameBlocked(subredditName) {
  const normalizedName = FrontFilter.normalizeSubredditName(subredditName);
  if (!normalizedName || filterIndex.allowedSubreddits.has(normalizedName)) return false;

  for (const entry of filterIndex.blockedAllSubreddits) {
    if (FrontFilter.matchesSubredditPattern(entry.name, normalizedName)) {
      return true;
    }
  }

  return false;
}

function containsBlockedSubreddit(subredditNames) {
  return Array.from(subredditNames).some(isSubredditNameBlocked);
}

function getPostTitle(postElement) {
  for (const attributeName of ["post-title", "data-title"]) {
    const title = postElement.getAttribute(attributeName)?.trim();
    if (title) return title;
  }

  for (const titleElement of postElement.querySelectorAll(FrontFilter.POST_SELECTORS.title)) {
    const nestedPost = titleElement.closest?.(POST_ROOT_SELECTOR);
    if (nestedPost && nestedPost !== postElement) continue;

    const title = titleElement.textContent?.trim();
    if (title) return title;
  }

  return "";
}

function getPostBodyTexts(postElement) {
  const texts = new Set();
  for (const attributeName of ["post-body", "data-post-body"]) {
    const text = postElement.getAttribute(attributeName)?.trim();
    if (text) texts.add(text);
  }

  for (const bodyElement of postElement.querySelectorAll(FrontFilter.POST_SELECTORS.body)) {
    if (bodyElement.closest?.(COMMENT_LAYOUT_SELECTOR)) continue;
    const nestedPost = bodyElement.closest?.(POST_ROOT_SELECTOR);
    if (nestedPost && nestedPost !== postElement) continue;

    const text = bodyElement.textContent?.trim();
    if (text) texts.add(text);
  }

  return texts;
}

function containsBlockedPostText(title, bodyTexts = []) {
  return [title, ...bodyTexts].some((text) => {
    if (typeof text !== "string" || !text) return false;
    const normalizedText = text.trim().replace(/\s+/g, " ").toLowerCase();
    return filterIndex.blockedKeywords.some((keyword) =>
      normalizedText.includes(keyword)
    );
  });
}

function isPostTextBlocked(postElement) {
  return containsBlockedPostText(getPostTitle(postElement), getPostBodyTexts(postElement));
}

function getPostPermalink(link) {
  const url = FrontFilter.getRedditUrl(link.getAttribute("href"), window.location.origin);
  if (!url) return null;

  const subreddit = FrontFilter.getSubredditPath(url.pathname);
  if (!subreddit || !/^comments\/[^/]+(?:\/|$)/i.test(subreddit.rest)) return null;

  return { subreddit: subreddit.name, pathname: url.pathname.toLowerCase() };
}

function getLinkedPostContainer(link) {
  if (link.closest(COMMENT_LAYOUT_SELECTOR)) return null;

  const knownContainer = link.closest(POST_ROOT_SELECTOR) || link.closest(POST_SELECTOR);
  if (knownContainer) return knownContainer;

  let container = link;
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = container.parentElement;
    if (!parent || parent.matches("main, body, html")) break;

    const postPaths = new Set();
    for (const postLink of parent.querySelectorAll(POST_PERMALINK_SELECTOR)) {
      const permalink = getPostPermalink(postLink);
      if (permalink) postPaths.add(permalink.pathname);
      if (postPaths.size > 1) break;
    }

    if (postPaths.size > 1) break;
    container = parent;
  }

  return container;
}

function collectPostCandidates() {
  const candidates = new Map();

  document.querySelectorAll(POST_SELECTOR).forEach((post) => {
    candidates.set(post, getPostSubredditNames(post));
  });

  document.querySelectorAll(POST_PERMALINK_SELECTOR).forEach((link) => {
    const permalink = getPostPermalink(link);
    if (!permalink) return;

    const post = getLinkedPostContainer(link);
    if (!post) return;

    if (!candidates.has(post)) candidates.set(post, new Set());
    candidates.get(post).add(permalink.subreddit);
  });

  return candidates;
}

async function filterPosts() {
  await loadConfig();
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", () => void filterPosts(), { once: true });
    return;
  }
  ensureHiddenStyle();

  if (!observer) {
    observer = new MutationObserver(() => {
      void checkCurrentPage();
      if (needsDynamicContentProcessing()) scheduleContentProcessing();
    });
  }
  configureContentObserver();

  processFilteredContent();
}

function needsDynamicContentProcessing() {
  return filterIndex.blockedAllSubreddits.length > 0
    || filterIndex.blockedKeywords.length > 0
    || config.blockSubHome
    || filterIndex.blockedFrontSubreddits.length > 0
    || config.hideComments
    || config.disableAutoplay
    || MAIN_PAGE_SETTING_KEYS.some((setting) => config[setting]);
}

function configureContentObserver() {
  const observePostAttributes = filterIndex.blockedAllSubreddits.length > 0
    || filterIndex.blockedKeywords.length > 0;
  const observeCommunityAttributes = config.blockSubHome
    || filterIndex.blockedFrontSubreddits.length > 0;
  const observeAttributes = observePostAttributes
    || observeCommunityAttributes
    || config.disableAutoplay;
  const observeCharacterData = filterIndex.blockedKeywords.length > 0;
  const signature = `${observeAttributes}:${observeCharacterData}`;
  if (signature === observerOptionsSignature) return;

  const options = { childList: true, subtree: true };
  if (observeAttributes) {
    options.attributes = true;
    options.attributeFilter = [
      "class",
      "subreddit-name",
      "subreddit-prefixed-name",
      "data-subreddit",
      "data-subreddit-prefixed",
      "href",
      "post-title",
      "data-title",
      "post-body",
      "data-post-body",
      ...AUTOPLAY_ATTRIBUTE_NAMES,
    ];
  }
  if (observeCharacterData) options.characterData = true;

  observer.observe(document.body, options);
  observerOptionsSignature = signature;
}

function ensureHiddenStyle() {
  // CSS rules also cover elements inserted later, without additional DOM scans.
  const commentSelector = config.hideComments
    ? COMMENT_VISIBILITY_SELECTOR
    : (config.hideCommentReplies ? COMMENT_REPLY_SELECTOR : "");
  const leftSidebarSectionRules = Object.entries(LEFT_SIDEBAR_SECTION_SELECTORS)
    .filter(([setting]) => config[setting])
    .map(([, selector]) => `\n${selector} { display: none !important; }`)
    .join("");
  const navbarSectionRules = Object.entries(NAVBAR_SECTION_SELECTORS)
    .filter(([setting]) => config[setting])
    .map(([, selector]) => `\n${selector} { display: none !important; }`)
    .join("");
  const navbarLogoRule = config.blockHomepage
    ? `\n${NAVBAR_LOGO_SELECTOR} { display: none !important; }`
    : "";
  const mainPageLinkRule = createMainPageLinkRule(
    "#left-sidebar left-nav-top-section",
  );
  const styleText = HIDDEN_STYLE_TEXT + (commentSelector
    ? `\n${commentSelector} { display: none !important; }`
    : "") + (config.hideSuggestedCommunities
    ? `\n${SUGGESTED_COMMUNITIES_SELECTOR} { display: none !important; }`
    : "") + (config.hideNavbar
    ? `\n${NAVBAR_SELECTOR} { display: none !important; }\n${NAVBAR_LAYOUT_STYLE}`
    : "") + navbarSectionRules + navbarLogoRule + (config.hideLeftSidebar
    ? `\n${LEFT_SIDEBAR_SELECTOR} { display: none !important; }`
    : "") + leftSidebarSectionRules + mainPageLinkRule + (config.hideRelatedPosts
    ? `\n${RIGHT_SIDEBAR_SELECTOR} { display: none !important; }`
    : "");
  const existingStyle = document.getElementById(HIDDEN_STYLE_ID);
  if (existingStyle) {
    if (existingStyle.textContent !== styleText) existingStyle.textContent = styleText;
    return;
  }

  const style = document.createElement("style");
  style.id = HIDDEN_STYLE_ID;
  style.textContent = styleText;
  document.documentElement.appendChild(style);
}

function createMainPageLinkRule(scope = "") {
  const linkSelectors = Object.entries(MAIN_PAGE_LINK_SELECTORS)
    .filter(([setting]) => config[setting])
    .flatMap(([, selectors]) => selectors);
  if (linkSelectors.length === 0) return "";

  const prefix = scope ? `${scope} ` : "";
  const links = linkSelectors.map((selector) => `${prefix}${selector}`);
  const listItems = `${prefix}li:has(:is(${linkSelectors.join(", ")}))`;
  return `\n${listItems}, ${links.join(", ")} { display: none !important; }`;
}

function scheduleContentProcessing() {
  if (processingScheduled) return;
  processingScheduled = true;

  requestAnimationFrame(() => {
    processingScheduled = false;
    processFilteredContent();
  });
}

function processFilteredContent() {
  const shouldFilterPosts = config.blockedTitleKeywords.length > 0
    || config.blockedSubreddits.some((entry) => entry.mode === "all");
  const shouldFilterCommunities = config.blockSubHome
    || config.blockedSubreddits.length > 0;

  if (shouldFilterPosts) {
    processPostElements();
  } else if (postFilteringActive) {
    clearBlockedElements("post");
  }

  if (shouldFilterCommunities) {
    processPopularCommunities();
  } else if (communityFilteringActive) {
    clearBlockedElements("community");
  }

  if (config.hideComments || commentActionsHidden) {
    syncShadowCommentActions();
  }
  if (config.disableAutoplay || videoAutoplayDisabled) {
    syncVideoAutoplay();
  }
  const shouldHideMainPageLinks = MAIN_PAGE_SETTING_KEYS.some((setting) => config[setting]);
  if (shouldHideMainPageLinks || mainPageLinksHidden) {
    syncShadowMainPageLinks();
  }

  postFilteringActive = shouldFilterPosts;
  communityFilteringActive = shouldFilterCommunities;
  commentActionsHidden = config.hideComments;
  videoAutoplayDisabled = config.disableAutoplay;
  mainPageLinksHidden = shouldHideMainPageLinks;
}

function syncShadowMainPageLinks() {
  syncShadowRootStyles(
    "left-nav-top-section",
    MAIN_PAGE_LINK_STYLE_ID,
    createMainPageLinkRule(),
  );
}

function syncShadowRootStyles(hostSelector, styleId, styleText) {
  document.querySelectorAll(hostSelector).forEach((host) => {
    const shadowRoot = host.shadowRoot;
    if (!shadowRoot) return;

    let style = shadowRoot.querySelector(`#${styleId}`);
    if (!style && styleText) {
      style = document.createElement("style");
      style.id = styleId;
      shadowRoot.appendChild(style);
    }
    if (style) style.textContent = styleText;
  });
}

function monitorCustomElement(elementName, shouldSync, sync) {
  const definition = globalThis.customElements?.whenDefined?.(elementName);
  if (!definition) return;

  void definition.then(() => {
    requestAnimationFrame(() => {
      if (shouldSync()) sync();
    });
  });
}

function setupMainPageLinkMonitor() {
  monitorCustomElement(
    "left-nav-top-section",
    () => mainPageLinksHidden,
    syncShadowMainPageLinks,
  );
}

function syncShadowCommentActions() {
  // The modern feed action row lives inside each shreddit-post shadow root,
  // beyond the reach of the document-level stylesheet.
  syncShadowRootStyles(
    "shreddit-post",
    COMMENT_ACTION_STYLE_ID,
    config.hideComments ? COMMENT_ACTION_STYLE_TEXT : "",
  );
}

function setupCommentActionMonitor() {
  monitorCustomElement("shreddit-post", () => config.hideComments, syncShadowCommentActions);
}

function getSavedAutoplayAttributes(element) {
  return new Set(
    (element.getAttribute(AUTOPLAY_STATE_ATTRIBUTE) || "")
      .split(",")
      .filter(Boolean),
  );
}

function isVideoElement(element) {
  return element.localName === "video" || element.tagName === "VIDEO";
}

function disableElementAutoplay(element, forcePause = false) {
  const alreadyManaged = element.hasAttribute(AUTOPLAY_STATE_ATTRIBUTE);
  const savedAttributes = getSavedAutoplayAttributes(element);
  let autoplaySignalFound = false;

  for (const attribute of AUTOPLAY_ATTRIBUTE_NAMES) {
    if (!element.hasAttribute(attribute)) continue;
    savedAttributes.add(attribute);
    element.removeAttribute(attribute);
    autoplaySignalFound = true;
  }

  if (!alreadyManaged || autoplaySignalFound) {
    element.setAttribute(
      AUTOPLAY_STATE_ATTRIBUTE,
      Array.from(savedAttributes).join(","),
    );
  }

  const shouldPause = forcePause || !alreadyManaged || autoplaySignalFound;
  if (isVideoElement(element)) {
    element.autoplay = false;
    if (shouldPause && element.paused === false) {
      try {
        element.pause();
      } catch {
        // The attributes still prevent future automatic playback.
      }
    }
    return;
  }

  element.shadowRoot?.querySelectorAll("video").forEach((video) => {
    disableElementAutoplay(video, shouldPause);
  });
}

function restoreElementAutoplay(element) {
  if (element.hasAttribute(AUTOPLAY_STATE_ATTRIBUTE)) {
    const savedAttributes = getSavedAutoplayAttributes(element);
    element.removeAttribute(AUTOPLAY_STATE_ATTRIBUTE);
    for (const attribute of savedAttributes) {
      element.setAttribute(attribute, "");
    }
    if (isVideoElement(element)) {
      element.autoplay = savedAttributes.has("autoplay");
    }
  }

  if (!isVideoElement(element)) {
    element.shadowRoot?.querySelectorAll("video").forEach(restoreElementAutoplay);
  }
}

function syncVideoAutoplay() {
  const updateAutoplay = config.disableAutoplay
    ? disableElementAutoplay
    : restoreElementAutoplay;
  document.querySelectorAll("shreddit-player, video").forEach((element) => {
    updateAutoplay(element);
  });
}

function setupVideoAutoplayMonitor() {
  monitorCustomElement("shreddit-player", () => config.disableAutoplay, syncVideoAutoplay);
}

function processPostElements() {
  reconcileCandidateElements(
    "post",
    collectPostCandidates(),
    (subredditNames, element) =>
      containsBlockedSubreddit(subredditNames) || isPostTextBlocked(element),
  );
}

function setElementBlocked(element, blocked, type) {
  const { datasetKey } = HIDDEN_ELEMENT_TYPES[type];
  if (blocked) {
    element.dataset[datasetKey] = "true";
  } else if (element.dataset[datasetKey] === "true") {
    delete element.dataset[datasetKey];
  }
}

function clearBlockedElements(type) {
  clearStaleBlockedElements(type, new Set());
}

function clearStaleBlockedElements(type, currentElements) {
  const { datasetKey, selector } = HIDDEN_ELEMENT_TYPES[type];
  document.querySelectorAll(selector).forEach((element) => {
    if (!currentElements.has(element)) delete element.dataset[datasetKey];
  });
}

function reconcileCandidateElements(type, candidates, isBlocked) {
  clearStaleBlockedElements(type, new Set(candidates.keys()));
  candidates.forEach((subredditNames, element) => {
    setElementBlocked(element, isBlocked(subredditNames, element), type);
  });
}

function isSubredditFrontBlocked(subredditName) {
  const normalizedName = FrontFilter.normalizeSubredditName(subredditName);
  if (!normalizedName || filterIndex.allowedSubreddits.has(normalizedName)) return false;
  if (config.blockSubHome) return true;

  return filterIndex.blockedFrontSubreddits.some((entry) =>
    FrontFilter.matchesSubredditPattern(entry.name, normalizedName)
  );
}

function getPopularCommunityPanels() {
  const panels = new Set();

  document.querySelectorAll(POPULAR_COMMUNITIES_SELECTOR).forEach((panel) => {
    const subredditNames = new Set();
    for (const link of panel.querySelectorAll('a[href*="/r/"]')) {
      const subreddit = getCommunitySubreddit(link);
      if (subreddit) subredditNames.add(subreddit.name);
      if (subredditNames.size > 1) {
        panels.add(panel);
        break;
      }
    }
  });

  return panels;
}

function getCommunitySubreddit(link) {
  const url = FrontFilter.getRedditUrl(link.getAttribute("href"), window.location.origin);
  if (!url) return null;

  const subreddit = FrontFilter.getSubredditPath(url.pathname);
  return subreddit && subreddit.rest === "" ? subreddit : null;
}

function getCommunityListItem(link, panel) {
  const listItem = link.closest('li, [role="listitem"]');
  if (listItem && panel.contains(listItem)) return listItem;

  const semanticItem = link.closest(
    '[data-testid*="community" i], [data-testid*="subreddit" i]'
  );
  if (semanticItem && panel.contains(semanticItem)) return semanticItem;

  let item = link;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = item.parentElement;
    if (!parent || parent === panel) break;

    const subredditNames = new Set();
    for (const communityLink of parent.querySelectorAll('a[href*="/r/"]')) {
      const subreddit = getCommunitySubreddit(communityLink);
      if (subreddit) subredditNames.add(subreddit.name);
      if (subredditNames.size > 1) break;
    }

    if (subredditNames.size > 1) break;
    item = parent;
  }

  return item;
}

function collectCommunityCandidates() {
  const candidates = new Map();

  getPopularCommunityPanels().forEach((panel) => {
    panel.querySelectorAll('a[href*="/r/"]').forEach((link) => {
      const subreddit = getCommunitySubreddit(link);
      if (!subreddit) return;

      const item = getCommunityListItem(link, panel);
      if (!candidates.has(item)) candidates.set(item, new Set());
      candidates.get(item).add(subreddit.name);
    });
  });

  return candidates;
}

function processPopularCommunities() {
  reconcileCandidateElements(
    "community",
    collectCommunityCandidates(),
    (subredditNames) => Array.from(subredditNames).some(isSubredditFrontBlocked),
  );
}

function setupUrlChangeMonitor() {
  setInterval(() => void checkCurrentPage(), 1000);
  window.addEventListener("popstate", () => void checkCurrentPage());
}

void checkCurrentPage();
void filterPosts();
setupCommentActionMonitor();
setupVideoAutoplayMonitor();
setupMainPageLinkMonitor();
setupUrlChangeMonitor();
