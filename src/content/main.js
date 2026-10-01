/**
 * FrontFilter content script. Page rules hide whole features with CSS
 * (page-style.js); post, comment and community filters mark the elements
 * that match; navigation to a blocked page goes to the block page.
 */

const SELECTORS = FrontFilter.SELECTORS;
const PAGE_STYLE = FrontFilter.pageStyle;
const POSTS = FrontFilter.posts;
const HIDDEN_STYLE_ID = "frontfilter-hidden-style";
const COMMENT_ACTION_STYLE_ID = "frontfilter-comment-actions-style";
const SOCIAL_SIGNAL_STYLE_ID = "frontfilter-social-signals-style";
const MAIN_PAGE_LINK_STYLE_ID = "frontfilter-main-page-links-style";

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
let observerOptionsSignature = "";
let processingScheduled = false;
let pageChangedOutsideComments = false;
// What the last pass applied, so that switching a feature off undoes it.
let postFilteringActive = false;
let commentFilteringActive = false;
let communityFilteringActive = false;
let commentActionsHidden = false;
let videoAutoplayDisabled = false;
let mainPageLinksHidden = false;
let shadowSignalsHidden = false;
// Comment text is read and matched once per comment and settings version;
// the map records the version each comment was last marked for.
const commentFilterResults = new WeakMap();
let commentFilterVersion = 0;
// Live collections of modern and Old Reddit comments, created on first use.
let commentCollections = null;

const feedLimiter = FrontFilter.createFeedLimiter({
  getSettings: () => config,
  isBlocked: ({ subreddit, title, bodyTexts, recommended, flair }) =>
    isSubredditNameBlocked(subreddit)
    || containsBlockedText([title, ...bodyTexts])
    || (recommended && areSuggestedPostsHidden())
    || isFlairBlocked(flair),
});

const quickBlock = FrontFilter.createQuickBlock({
  getSettings: () => config,
  isAllowed: (name) => filterIndex.allowedSubreddits.has(name),
});

function createFilterIndex(settings) {
  return {
    allowedSubreddits: new Set(settings.allowedSubreddits),
    blockedAllSubreddits: settings.blockedSubreddits.filter((entry) => entry.mode === "all"),
    blockedFlairs: settings.blockedFlairs,
    hasKeywords: settings.blockedTitleKeywords.length > 0,
    matchesKeywords: FrontFilter.createKeywordMatcher(settings.blockedTitleKeywords),
  };
}

function setConfig(settings) {
  config = settings;
  filterIndex = createFilterIndex(settings);
  commentFilterVersion += 1;
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

// Navigation

async function checkCurrentPage({ force = false } = {}) {
  await loadConfig();

  const currentUrl = window.location.href;
  const urlChanged = currentUrl !== lastCheckedUrl;
  if (!force && !urlChanged) return;
  lastCheckedUrl = currentUrl;
  syncHomeFeedMarker();
  if (urlChanged) feedLimiter.update();
  const route = FrontFilter.getBlockedRoute(window.location.pathname, config);
  if (route) redirectToBlock(route, currentUrl);
}

function redirectToBlock(route, returnUrl) {
  // Only the redirect caused by a one-click block of this subreddit carries
  // its undo token; the block page checks it against storage.
  const undoToken = route.type === "subreddit" ? quickBlock.takeUndo(route.subreddit) : "";
  window.location.replace(
    chrome.runtime.getURL("blocked/index.html") + FrontFilter.blockedRouteToQuery(route, returnUrl)
    + (undoToken ? `&undo=${encodeURIComponent(undoToken)}` : "")
  );
}

function setupUrlChangeMonitor() {
  setInterval(() => void checkCurrentPage(), 1000);
  window.addEventListener("popstate", () => void checkCurrentPage());
}

function areSuggestedPostsHidden() {
  return config.hideSuggestedPosts && FrontFilter.isHomeFeedPath(window.location.pathname);
}

// Page rules for suggested posts apply under this marker: other feeds, such
// as Popular, consist of recommendations by design.
function syncHomeFeedMarker() {
  const root = document.documentElement;
  if (!root) return;
  const isHomeFeed = FrontFilter.isHomeFeedPath(window.location.pathname);
  if (isHomeFeed !== root.hasAttribute(PAGE_STYLE.HOME_FEED_ATTRIBUTE)) {
    root.toggleAttribute(PAGE_STYLE.HOME_FEED_ATTRIBUTE, isHomeFeed);
  }
}

// Matching

function isSubredditNameBlocked(subredditName) {
  const normalizedName = FrontFilter.normalizeSubredditName(subredditName);
  if (!normalizedName || filterIndex.allowedSubreddits.has(normalizedName)) return false;
  return filterIndex.blockedAllSubreddits.some((entry) =>
    FrontFilter.matchesSubredditPattern(entry.name, normalizedName)
  );
}

function isSubredditFrontBlocked(subredditName) {
  const normalizedName = FrontFilter.normalizeSubredditName(subredditName);
  if (!normalizedName || filterIndex.allowedSubreddits.has(normalizedName)) return false;
  if (config.blockSubHome) return true;
  return config.blockedSubreddits.some((entry) =>
    FrontFilter.matchesSubredditPattern(entry.name, normalizedName)
  );
}

function containsBlockedText(texts) {
  return texts.some(filterIndex.matchesKeywords);
}

function isFlairBlocked(flair) {
  return Boolean(flair) && filterIndex.blockedFlairs.some((pattern) =>
    FrontFilter.matchesFlairPattern(pattern, flair)
  );
}

// Posts

// Subreddits named by a post's attributes or, failing those, by its links.
function getPostSubredditNames(postElement) {
  const names = POSTS.subreddits(postElement);
  if (names.size > 0) return names;

  for (const link of postElement.querySelectorAll(SELECTORS.subredditLink)) {
    const nestedPost = link.closest(SELECTORS.post.roots);
    if (nestedPost && nestedPost !== postElement) continue;
    const url = FrontFilter.getRedditUrl(link.getAttribute("href"), window.location.origin);
    const subreddit = url && FrontFilter.getSubredditPath(url.pathname);
    if (subreddit) names.add(subreddit.name);
  }
  return names;
}

function isPostBlocked(subredditNames, postElement) {
  return Array.from(subredditNames).some(isSubredditNameBlocked)
    || (filterIndex.hasKeywords
      && containsBlockedText([POSTS.title(postElement), ...POSTS.bodyTexts(postElement)]))
    || (filterIndex.blockedFlairs.length > 0 && isFlairBlocked(POSTS.flair(postElement)));
}

function getPostPermalink(link) {
  const url = FrontFilter.getRedditUrl(link.getAttribute("href"), window.location.origin);
  if (!url) return null;

  const subreddit = FrontFilter.getSubredditPath(url.pathname);
  if (!subreddit || !/^comments\/[^/]+(?:\/|$)/i.test(subreddit.rest)) return null;

  return { subreddit: subreddit.name, pathname: url.pathname.toLowerCase() };
}

// For layouts without a known post element: the largest ancestor of a
// permalink that links to no other post.
function getLinkedPostContainer(link) {
  if (link.closest(SELECTORS.comment.layouts)) return null;

  const knownContainer = link.closest(SELECTORS.post.roots) || link.closest(SELECTORS.post.any);
  if (knownContainer) return knownContainer;

  let container = link;
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = container.parentElement;
    if (!parent || parent.matches("main, body, html")) break;

    const postPaths = new Set();
    for (const postLink of parent.querySelectorAll(SELECTORS.post.permalink)) {
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

  document.querySelectorAll(SELECTORS.post.candidates).forEach((post) => {
    candidates.set(post, getPostSubredditNames(post));
  });

  document.querySelectorAll(SELECTORS.post.permalinkOutsideComments).forEach((link) => {
    const permalink = getPostPermalink(link);
    if (!permalink) return;

    const post = getLinkedPostContainer(link);
    if (!post) return;

    if (!candidates.has(post)) candidates.set(post, new Set());
    candidates.get(post).add(permalink.subreddit);
  });

  return candidates;
}

function processPostElements() {
  reconcileCandidateElements("post", collectPostCandidates(), isPostBlocked);
}

// Comments

// Returns null while the comment body has not rendered yet.
function getCommentText(comment) {
  if (comment.localName !== SELECTORS.comment.modern) {
    const body = comment.querySelector(SELECTORS.comment.oldBody);
    return body ? body.textContent : null;
  }
  // Current markup nests the body inside <details>; older markup made it a
  // direct child. In both, a comment's own body precedes its replies, so the
  // first match is its own unless it has none (e.g. deleted comments).
  const body = comment.querySelector(SELECTORS.comment.modernBody);
  if (!body) return null;
  return body.closest(SELECTORS.comment.modern) === comment ? body.textContent : "";
}

// Runs on every processed mutation, so each comment's text is read and
// matched once per settings version; later passes are a WeakMap lookup.
function processComments() {
  // Live collections avoid walking the whole page, unlike querySelectorAll.
  commentCollections ??= [
    document.getElementsByTagName(SELECTORS.comment.modern),
    document.getElementsByClassName(SELECTORS.comment.oldClassName),
  ];
  for (const collection of commentCollections) {
    for (const comment of collection) {
      // Already matched and marked for the current settings.
      if (commentFilterResults.get(comment) === commentFilterVersion) continue;
      const text = getCommentText(comment);
      // A comment inserted before its body is checked again on a later pass.
      if (text === null) continue;
      setElementBlocked(comment, containsBlockedText([text]), "comment");
      commentFilterResults.set(comment, commentFilterVersion);
    }
  }
}

// Community panels

function getCommunitySubreddit(link) {
  const url = FrontFilter.getRedditUrl(link.getAttribute("href"), window.location.origin);
  if (!url) return null;

  const subreddit = FrontFilter.getSubredditPath(url.pathname);
  return subreddit && subreddit.rest === "" ? subreddit : null;
}

// Counts the distinct subreddit front pages an element links to, up to two.
function countLinkedCommunities(element) {
  const names = new Set();
  for (const link of element.querySelectorAll(SELECTORS.subredditLink)) {
    const subreddit = getCommunitySubreddit(link);
    if (subreddit) names.add(subreddit.name);
    if (names.size > 1) break;
  }
  return names.size;
}

// A panel lists communities when it links to more than one.
function getCommunityPanels() {
  return Array.from(document.querySelectorAll(SELECTORS.communityPanels))
    .filter((panel) => countLinkedCommunities(panel) > 1);
}

function getCommunityListItem(link, panel) {
  const listItem = link.closest(SELECTORS.communityListItems);
  if (listItem && panel.contains(listItem)) return listItem;

  const semanticItem = link.closest(SELECTORS.communityItems);
  if (semanticItem && panel.contains(semanticItem)) return semanticItem;

  let item = link;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = item.parentElement;
    if (!parent || parent === panel || countLinkedCommunities(parent) > 1) break;
    item = parent;
  }
  return item;
}

function collectCommunityCandidates() {
  const candidates = new Map();

  for (const panel of getCommunityPanels()) {
    panel.querySelectorAll(SELECTORS.subredditLink).forEach((link) => {
      const subreddit = getCommunitySubreddit(link);
      if (!subreddit) return;

      const item = getCommunityListItem(link, panel);
      if (!candidates.has(item)) candidates.set(item, new Set());
      candidates.get(item).add(subreddit.name);
    });
  }

  return candidates;
}

function processCommunityPanels() {
  reconcileCandidateElements(
    "community",
    collectCommunityCandidates(),
    (subredditNames) => Array.from(subredditNames).some(isSubredditFrontBlocked),
  );
}

// Hidden markers

function setElementBlocked(element, blocked, type) {
  const { datasetKey } = PAGE_STYLE.markers[type];
  // Rewriting an unchanged attribute would still invalidate styles.
  if (blocked) {
    if (element.dataset[datasetKey] !== "true") element.dataset[datasetKey] = "true";
  } else if (element.dataset[datasetKey] === "true") {
    delete element.dataset[datasetKey];
  }
}

function clearStaleBlockedElements(type, currentElements = new Set()) {
  const { datasetKey, selector } = PAGE_STYLE.markers[type];
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

// Page rules

function ensureHiddenStyle() {
  const root = document.documentElement;
  if (!root) return;
  const styleText = PAGE_STYLE.pageRules(config);
  const existingStyle = document.getElementById(HIDDEN_STYLE_ID);
  if (existingStyle) {
    if (existingStyle.textContent !== styleText) existingStyle.textContent = styleText;
    return;
  }

  const style = document.createElement("style");
  style.id = HIDDEN_STYLE_ID;
  style.textContent = styleText;
  root.appendChild(style);
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
    // Rewriting an unchanged stylesheet would re-parse it on every mutation.
    if (style && style.textContent !== styleText) style.textContent = styleText;
  });
}

function syncShadowCommentActions() {
  syncShadowRootStyles(
    SELECTORS.comment.actionShadowHost,
    COMMENT_ACTION_STYLE_ID,
    PAGE_STYLE.commentActionRules(config),
  );
}

function syncShadowSocialSignals() {
  const styleText = PAGE_STYLE.shadowSignalRules(config);
  for (const host of SELECTORS.shadowSignalHosts) {
    syncShadowRootStyles(host, SOCIAL_SIGNAL_STYLE_ID, styleText);
  }
}

function syncShadowMainPageLinks() {
  syncShadowRootStyles(
    SELECTORS.leftSidebar.topSection,
    MAIN_PAGE_LINK_STYLE_ID,
    PAGE_STYLE.mainPageLinkRules(config),
  );
}

function syncVideoAutoplay() {
  FrontFilter.syncVideoAutoplay(config.disableAutoplay);
}

// Shadow roots and players appear once their custom element is defined.
function monitorCustomElement(elementName, shouldSync, sync) {
  const definition = globalThis.customElements?.whenDefined?.(elementName);
  if (!definition) return;

  void definition.then(() => {
    requestAnimationFrame(() => {
      if (shouldSync()) sync();
    });
  });
}

function setupCustomElementMonitors() {
  monitorCustomElement(
    SELECTORS.comment.actionShadowHost,
    () => config.hideComments,
    syncShadowCommentActions,
  );
  monitorCustomElement(
    SELECTORS.autoplay.player,
    () => config.disableAutoplay,
    syncVideoAutoplay,
  );
  monitorCustomElement(
    SELECTORS.leftSidebar.topSection,
    () => mainPageLinksHidden,
    syncShadowMainPageLinks,
  );
  for (const host of SELECTORS.shadowSignalHosts) {
    monitorCustomElement(
      host,
      () => PAGE_STYLE.hasShadowSignals(config),
      syncShadowSocialSignals,
    );
  }
}

// Processing

async function filterPosts() {
  await loadConfig();
  // Page rules need no body: applying them now keeps hidden parts of the
  // page from showing while Reddit's HTML streams in.
  ensureHiddenStyle();
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", () => void filterPosts(), { once: true });
    return;
  }

  if (!observer) {
    observer = new MutationObserver((mutations) => {
      void checkCurrentPage();
      if (!needsDynamicContentProcessing()) return;
      if (!pageChangedOutsideComments) {
        pageChangedOutsideComments = mutations.some(isOutsideComments);
      }
      scheduleContentProcessing();
    });
  }
  configureContentObserver();

  processFilteredContent();
}

function needsDynamicContentProcessing() {
  return filterIndex.blockedAllSubreddits.length > 0
    || filterIndex.hasKeywords
    || filterIndex.blockedFlairs.length > 0
    || config.blockSubHome
    || config.blockedSubreddits.length > 0
    || config.hideComments
    || config.disableAutoplay
    || config.showBlockSubredditButton
    || PAGE_STYLE.hasShadowSignals(config)
    || PAGE_STYLE.blocksMainPageLinks(config);
}

// Attribute and text changes only matter to filters that read them.
function configureContentObserver() {
  const observePostAttributes = filterIndex.blockedAllSubreddits.length > 0
    || filterIndex.hasKeywords;
  const observeCommunityAttributes = config.blockSubHome
    || config.blockedSubreddits.length > 0;
  const observeAttributes = observePostAttributes
    || observeCommunityAttributes
    || config.disableAutoplay;
  const observeCharacterData = filterIndex.hasKeywords;
  const signature = `${observeAttributes}:${observeCharacterData}`;
  if (signature === observerOptionsSignature) return;

  const options = { childList: true, subtree: true };
  if (observeAttributes) {
    options.attributes = true;
    options.attributeFilter = [
      "class",
      "href",
      ...SELECTORS.post.subredditAttributes,
      ...SELECTORS.post.titleAttributes,
      ...SELECTORS.post.bodyAttributes,
      ...SELECTORS.autoplay.attributes,
    ];
  }
  if (observeCharacterData) options.characterData = true;

  observer.observe(document.body, options);
  observerOptionsSignature = signature;
}

function isOutsideComments({ target }) {
  const element = target.closest ? target : target.parentElement;
  return !element?.closest(SELECTORS.comment.regions);
}

function scheduleContentProcessing() {
  if (processingScheduled) return;
  processingScheduled = true;

  requestAnimationFrame(() => {
    processingScheduled = false;
    const outsideComments = pageChangedOutsideComments;
    pageChangedOutsideComments = false;
    processFilteredContent({ outsideComments });
  });
}

// Settings changes and first runs process everything; mutation-driven runs
// skip page-wide post and community scans when only comments changed.
function processFilteredContent({ outsideComments = true } = {}) {
  const shouldFilterPosts = config.blockedTitleKeywords.length > 0
    || config.blockedFlairs.length > 0
    || config.blockedSubreddits.some((entry) => entry.mode === "all");
  // Comments already hidden by the comments switch need no text matching.
  const shouldFilterComments = config.blockedTitleKeywords.length > 0
    && !config.hideComments;
  const shouldFilterCommunities = config.blockSubHome
    || config.blockedSubreddits.length > 0;
  const shouldHideMainPageLinks = PAGE_STYLE.blocksMainPageLinks(config);
  const shouldHideShadowSignals = PAGE_STYLE.hasShadowSignals(config);

  if (shouldFilterPosts) {
    if (outsideComments) processPostElements();
  } else if (postFilteringActive) {
    clearStaleBlockedElements("post");
  }

  if (shouldFilterCommunities) {
    if (outsideComments) processCommunityPanels();
  } else if (communityFilteringActive) {
    clearStaleBlockedElements("community");
  }

  if (shouldFilterComments) {
    processComments();
  } else if (commentFilteringActive) {
    clearStaleBlockedElements("comment");
  }

  if (outsideComments) quickBlock.update();

  if (config.hideComments || commentActionsHidden) syncShadowCommentActions();
  if (config.disableAutoplay || videoAutoplayDisabled) syncVideoAutoplay();
  if (shouldHideMainPageLinks || mainPageLinksHidden) syncShadowMainPageLinks();
  if (shouldHideShadowSignals || shadowSignalsHidden) syncShadowSocialSignals();

  postFilteringActive = shouldFilterPosts;
  communityFilteringActive = shouldFilterCommunities;
  commentFilteringActive = shouldFilterComments;
  commentActionsHidden = config.hideComments;
  videoAutoplayDisabled = config.disableAutoplay;
  mainPageLinksHidden = shouldHideMainPageLinks;
  shadowSignalsHidden = shouldHideShadowSignals;
}

void checkCurrentPage();
void filterPosts();
setupCustomElementMonitors();
setupUrlChangeMonitor();
