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
// The features the last pass applied, so that switching one off undoes it.
let appliedFeatures = {};
// Increases with each settings change, which outdates every verdict.
let filterVersion = 0;
// Reading every post's text again on each page change is most of the work
// on long feeds. A known post's verdict holds until the settings, its
// subreddits or the post itself change (see forgetChangedPost).
const postVerdicts = new WeakMap();
// Comment text is read and matched once per comment and settings version,
// and again once the comment changes (see forgetChangedComment); the map
// records the version each comment was last marked for.
const commentFilterResults = new WeakMap();
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

// What filters match against, and which of them scan the page, for the
// current settings.
function createFilterIndex(settings) {
  const blocked = settings.blockedSubreddits.map(({ name }) => name);
  const blockedAll = settings.blockedSubreddits
    .filter(({ mode }) => mode === "all")
    .map(({ name }) => name);
  const hasKeywords = settings.blockedTitleKeywords.length > 0;
  // Comments already hidden by the comments switch need no text matching.
  const filtersComments = hasKeywords && !settings.hideComments;
  return {
    allowedSubreddits: new Set(settings.allowedSubreddits),
    // ALL rules hide a subreddit's posts; any rule blocks its front page.
    blocksAllSubreddits: blockedAll.length > 0,
    matchesBlockedAll: FrontFilter.createSubredditMatcher(blockedAll),
    matchesBlockedFront: settings.blockSubHome
      ? () => true
      : FrontFilter.createSubredditMatcher(blocked),
    blockedFlairs: settings.blockedFlairs,
    hasKeywords,
    matchesKeywords: FrontFilter.createKeywordMatcher(settings.blockedTitleKeywords),
    filtersPosts: blockedAll.length > 0 || hasKeywords || settings.blockedFlairs.length > 0,
    filtersComments,
    // The text whose changes filters read.
    readText: filtersComments
      ? `${SELECTORS.post.text}, ${SELECTORS.comment.bodies}`
      : SELECTORS.post.text,
    // Community panels hide subreddits whose front page is blocked.
    filtersCommunities: settings.blockSubHome || settings.blockedSubreddits.length > 0,
  };
}

function setConfig(settings) {
  config = settings;
  filterIndex = createFilterIndex(settings);
  filterVersion += 1;
}

chrome.storage.onChanged.addListener((changes, area) => {
  // Other stored values, such as the block page's undo marker, change no
  // setting.
  if (area !== "local" || !FrontFilter.STORAGE_KEYS.some((key) => Object.hasOwn(changes, key))) {
    return;
  }
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

// The same block page URL as navigation rules use, the blocked URL last.
function redirectToBlock(route, returnUrl) {
  // Only the redirect caused by a one-click block of this subreddit carries
  // its undo token; the block page checks it against storage.
  const undoToken = route.type === "subreddit" ? quickBlock.takeUndo(route.subreddit) : "";
  window.location.replace(
    chrome.runtime.getURL("blocked/index.html") + FrontFilter.blockPageQuery(route)
    + (undoToken ? `&undo=${encodeURIComponent(undoToken)}` : "") + `#${returnUrl}`
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
  return filterIndex.matchesBlockedAll(normalizedName);
}

function isSubredditFrontBlocked(subredditName) {
  const normalizedName = FrontFilter.normalizeSubredditName(subredditName);
  if (!normalizedName || filterIndex.allowedSubreddits.has(normalizedName)) return false;
  return filterIndex.matchesBlockedFront(normalizedName);
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

// Known post elements, and in other layouts the containers of permalinks,
// with the subreddits they are from. Permalinks name the subreddit only of
// posts that do not name it: a post is not from the subreddits of the
// threads it links to.
function collectPostCandidates(knownPosts) {
  const candidates = new Map();
  for (const post of knownPosts) candidates.set(post, getPostSubredditNames(post));

  for (const link of document.querySelectorAll(SELECTORS.post.permalinkOutsideComments)) {
    const knownPost = link.closest(SELECTORS.post.roots) || link.closest(SELECTORS.post.any);
    if (candidates.get(knownPost)?.size > 0) continue;

    const permalink = getPostPermalink(link);
    if (!permalink) continue;

    const post = getLinkedPostContainer(link);
    if (!post) continue;

    if (!candidates.has(post)) candidates.set(post, new Set());
    candidates.get(post).add(permalink.subreddit);
  }

  return candidates;
}

// Only known posts keep their verdicts: changes are traced to them.
function judgePost(subredditNames, post, known) {
  const names = Array.from(subredditNames).join(" ");
  const cached = known && postVerdicts.get(post);
  if (cached && cached.version === filterVersion && cached.names === names) return cached.blocked;

  const blocked = isPostBlocked(subredditNames, post);
  if (known) postVerdicts.set(post, { version: filterVersion, names, blocked });
  return blocked;
}

function processPostElements() {
  const knownPosts = new Set(document.querySelectorAll(SELECTORS.post.candidates));
  reconcileCandidateElements(
    "post",
    collectPostCandidates(knownPosts),
    (subredditNames, post) => judgePost(subredditNames, post, knownPosts.has(post)),
  );
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
      if (commentFilterResults.get(comment) === filterVersion) continue;
      const text = getCommentText(comment);
      // A comment inserted before its body is checked again on a later pass.
      if (text === null) continue;
      setElementBlocked(comment, containsBlockedText([text]), "comment");
      commentFilterResults.set(comment, filterVersion);
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
    () => PAGE_STYLE.blocksMainPageLinks(config),
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
      if (window.location.href !== lastCheckedUrl) void checkCurrentPage();
      if (!needsDynamicContentProcessing()) return;
      const changes = mutations.filter(affectsFilters);
      if (changes.length === 0) return;
      changes.forEach(forgetChangedPost);
      if (filterIndex.filtersComments) changes.forEach(forgetChangedComment);
      if (!pageChangedOutsideComments) {
        pageChangedOutsideComments = changes.some(isOutsideComments);
      }
      scheduleContentProcessing();
    });
  }
  configureContentObserver();

  processFilteredContent();
}

// Page rules are CSS and cover new elements by themselves; these features
// must act on the elements Reddit adds.
function needsDynamicContentProcessing() {
  return filterIndex.filtersPosts
    || filterIndex.filtersComments
    || filterIndex.filtersCommunities
    || config.hideComments
    || config.disableAutoplay
    || config.showBlockSubredditButton
    || PAGE_STYLE.hasShadowSignals(config)
    || PAGE_STYLE.blocksMainPageLinks(config);
}

// Attribute and text changes only matter to filters that read them.
function configureContentObserver() {
  const observeAttributes = filterIndex.blocksAllSubreddits
    || filterIndex.hasKeywords
    || filterIndex.filtersCommunities
    || config.disableAutoplay;
  const observeCharacterData = filterIndex.hasKeywords || filterIndex.blockedFlairs.length > 0;
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

// Classes matter only on posts, which they mark in older layouts:
// elsewhere, such as in menus, they change all the time.
function affectsFilters(mutation) {
  if (POSTS.isUnreadTextChange(mutation, filterIndex.readText)) return false;
  if (mutation.attributeName === "class") return Boolean(mutation.target.closest(SELECTORS.post.any));
  return true;
}

// Forgets the verdicts of the posts a change happened in.
function forgetChangedPost({ target }) {
  const element = target.closest ? target : target.parentElement;
  let post = element?.closest(SELECTORS.post.any);
  while (post) {
    postVerdicts.delete(post);
    post = post.parentElement?.closest(SELECTORS.post.any);
  }
}

// Forgets the verdict of the comment a change happened in: its text may
// have been arriving still when it was read, or it may have been edited.
// A comment reads only its own text, so its replies keep theirs.
function forgetChangedComment({ target }) {
  const element = target.closest ? target : target.parentElement;
  const comment = element?.closest(SELECTORS.comment.filtered);
  if (comment) commentFilterResults.delete(comment);
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
  const features = {
    posts: filterIndex.filtersPosts,
    communities: filterIndex.filtersCommunities,
    comments: filterIndex.filtersComments,
    commentActions: config.hideComments,
    autoplay: config.disableAutoplay,
    mainPageLinks: PAGE_STYLE.blocksMainPageLinks(config),
    shadowSignals: PAGE_STYLE.hasShadowSignals(config),
  };
  const isOrWas = (feature) => features[feature] || appliedFeatures[feature];

  if (features.posts) {
    if (outsideComments) processPostElements();
  } else if (appliedFeatures.posts) {
    clearStaleBlockedElements("post");
  }

  if (features.communities) {
    if (outsideComments) processCommunityPanels();
  } else if (appliedFeatures.communities) {
    clearStaleBlockedElements("community");
  }

  if (features.comments) {
    processComments();
  } else if (appliedFeatures.comments) {
    clearStaleBlockedElements("comment");
  }

  if (outsideComments) quickBlock.update();

  if (isOrWas("commentActions")) syncShadowCommentActions();
  if (isOrWas("autoplay")) syncVideoAutoplay();
  if (isOrWas("mainPageLinks")) syncShadowMainPageLinks();
  if (isOrWas("shadowSignals")) syncShadowSocialSignals();

  appliedFeatures = features;
}

void checkCurrentPage();
void filterPosts();
setupCustomElementMonitors();
setupUrlChangeMonitor();
