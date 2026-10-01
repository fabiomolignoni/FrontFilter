/**
 * FrontFilter - Shared helpers
 */

var FrontFilter = (() => {
  const DEFAULT_SETTINGS = Object.freeze({
    blockedSubreddits: Object.freeze([]),
    allowedSubreddits: Object.freeze([]),
    // Keep the original key so existing title-filter settings and backups now
    // apply to both post titles and text previews without a migration.
    blockedTitleKeywords: Object.freeze([]),
    blockedFlairs: Object.freeze([]),
    blockHomepage: false,
    blockPopular: false,
    blockExplore: false,
    blockNews: false,
    blockSubHome: false,
    hideComments: false,
    hideCommentReplies: false,
    disableAutoplay: false,
    hideSuggestedCommunities: false,
    hideSuggestedPosts: false,
    hideAds: false,
    hideSocialSignals: false,
    hideVotes: false,
    hideKarma: false,
    hideAwards: false,
    hideAvatars: false,
    hideUsernames: false,
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
    // Keep the legacy storage key for the right sidebar toggle and older exports.
    hideRelatedPosts: false,
    showBlockSubredditButton: false,
    limitInfiniteScroll: false,
    scrollLimit: 25,
    scrollMode: "fixed",
    theme: "system",
  });
  const STORAGE_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
  // Switches that imply their sections: while one is on, so are they.
  const SETTING_GROUPS = Object.freeze({
    hideComments: Object.freeze(["hideCommentReplies"]),
    hideNavbar: Object.freeze([
      "hideNavbarMenu",
      "hideNavbarSearch",
      "hideNavbarChat",
      "hideNavbarNotifications",
      "hideNavbarProfile",
      "hideNavbarOthers",
    ]),
    hideSocialSignals: Object.freeze([
      "hideVotes",
      "hideKarma",
      "hideAwards",
      "hideAvatars",
      "hideUsernames",
    ]),
    hideLeftSidebar: Object.freeze([
      "hideLeftSidebarGames",
      "hideLeftSidebarCustomFeeds",
      "hideLeftSidebarRecent",
      "hideLeftSidebarCommunities",
      "hideLeftSidebarResources",
    ]),
  });
  // A one-time marker, not a setting: it lets the block page offer to undo
  // a one-click block only on the redirect that block caused.
  const QUICK_BLOCK_UNDO_KEY = "quickBlockUndo";
  const NAVIGATION_STORAGE_KEYS = Object.freeze([
    "blockedSubreddits",
    "allowedSubreddits",
    "blockHomepage",
    "blockPopular",
    "blockExplore",
    "blockNews",
    "blockSubHome",
  ]);

  const LISTING_SORTS = Object.freeze([
    "best",
    "hot",
    "new",
    "top",
    "rising",
    "controversial",
  ]);
  const LISTING_SORT_PATTERN = LISTING_SORTS.join("|");
  // Main pages that settings can block. Each path is a regular expression
  // source that both the content script and declarativeNetRequest rules use.
  const PAGE_ROUTES = Object.freeze([
    { key: "blockHomepage", page: "homepage", filter: "Homepage", path: `(/(${LISTING_SORT_PATTERN}))?/?` },
    { key: "blockPopular", page: "popular", filter: "r/popular", path: "/r/popular(/.*)?" },
    { key: "blockExplore", page: "explore", filter: "Explore", path: "/explore(/.*)?" },
    { key: "blockNews", page: "news", filter: "News", path: "/news(/.*)?" },
  ].map((route) => Object.freeze({ type: "page", ...route })));
  const SUBREDDIT_FRONTS_ROUTE = Object.freeze({
    type: "page", page: "subhome", filter: "All Sub Fronts",
  });
  const PAGE_PATTERNS = new Map(PAGE_ROUTES.map((route) =>
    [route, new RegExp(`^${route.path}$`, "i")]
  ));
  const FRONT_PAGE_PATTERN = PAGE_PATTERNS.get(PAGE_ROUTES[0]);
  const FEED_PAGE_PATTERN = new RegExp(
    `^/r/[^/]+(?:/(?:${LISTING_SORT_PATTERN}))?/?$`,
    "i",
  );

  const SUBREDDIT_SORTS = new Set(LISTING_SORTS);
  const REDDIT_HOST_PATTERN = /(^|\.)reddit\.com$/i;

  function getRedditUrl(value, baseUrl) {
    if (typeof value !== "string" && !(value instanceof URL)) return null;

    try {
      const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
      const isWebUrl = url.protocol === "http:" || url.protocol === "https:";
      return isWebUrl && REDDIT_HOST_PATTERN.test(url.hostname) ? url : null;
    } catch {
      return null;
    }
  }

  function normalizeSubredditName(value) {
    if (typeof value !== "string") return "";

    let name = value.trim().toLowerCase();
    if (!name) return "";

    let cameFromRedditUrl = false;
    try {
      const looksLikeUrl = /^https?:\/\//i.test(name);
      const looksLikeRedditHost = /^(?:[\w-]+\.)?reddit\.com(?:\/|$)/i.test(name);
      if (looksLikeUrl || looksLikeRedditHost) {
        const url = getRedditUrl(looksLikeUrl ? name : `https://${name}`);
        if (!url) return "";

        name = url.pathname;
        cameFromRedditUrl = true;
      }
    } catch {
      return "";
    }

    name = name.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");

    const pattern = cameFromRedditUrl
      ? /^r\/([a-z0-9_*]+)(?:\/.*)?$/i
      : /^(?:r\/)?([a-z0-9_*]+)(?:\/.*)?$/i;
    const subredditPathMatch = name.match(pattern);
    if (!subredditPathMatch) return "";

    const normalized = subredditPathMatch[1].replace(/\*+/g, "*");
    return /[a-z0-9_]/.test(normalized) ? normalized : "";
  }

  // Filters match every post on each page update; compile each pattern once.
  const wildcardPatterns = new Map();
  function getWildcardPattern(pattern) {
    let regex = wildcardPatterns.get(pattern);
    if (!regex) {
      const regexSource = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      regex = new RegExp(`^${regexSource}$`, "i");
      if (wildcardPatterns.size > 1000) wildcardPatterns.clear();
      wildcardPatterns.set(pattern, regex);
    }
    return regex;
  }

  function matchesSubredditPattern(pattern, subredditName) {
    const normalizedPattern = normalizeSubredditName(pattern);
    const normalizedSubreddit = normalizeSubredditName(subredditName);
    if (!normalizedPattern || !normalizedSubreddit) return false;
    if (normalizedPattern === normalizedSubreddit) return true;
    if (!normalizedPattern.includes("*")) return false;
    return getWildcardPattern(normalizedPattern).test(normalizedSubreddit);
  }

  function normalizeMode(mode) {
    return mode === "all" ? "all" : "home";
  }

  function normalizeTheme(theme) {
    return theme === "dark" || theme === "light" ? theme : "system";
  }

  // For extension pages. The cached mode lets theme-bootstrap.js apply it
  // before the next page renders; that script keeps its own copy of the key.
  function applyTheme(theme) {
    const normalizedTheme = normalizeTheme(theme);
    document.documentElement.setAttribute("data-theme", normalizedTheme);
    try {
      globalThis.localStorage?.setItem("frontfilter-theme", normalizedTheme);
    } catch {
      // The theme still works for this page if local storage is unavailable.
    }
    return normalizedTheme;
  }

  function normalizeBlockedEntry(entry) {
    if (typeof entry === "string") {
      const name = normalizeSubredditName(entry);
      return name ? { name, mode: "home" } : null;
    }

    if (!entry || typeof entry !== "object") return null;
    const name = normalizeSubredditName(entry.name);
    return name ? { name, mode: normalizeMode(entry.mode) } : null;
  }

  // One rule per subreddit: a repeated name keeps its first position, and
  // ALL, which blocks more, wins over HOME.
  function normalizeBlockedSubreddits(entries = []) {
    if (!Array.isArray(entries)) return [];

    const byName = new Map();
    for (const entry of entries) {
      const normalized = normalizeBlockedEntry(entry);
      if (!normalized) continue;
      const existing = byName.get(normalized.name);
      if (!existing) {
        byName.set(normalized.name, normalized);
      } else if (normalized.mode === "all") {
        existing.mode = "all";
      }
    }
    return Array.from(byName.values());
  }

  // One-click blocks use ALL mode, the only mode that hides a subreddit's
  // posts from feeds, and turn a HOME rule for the same name into ALL.
  // previousMode is what undoing the block restores.
  function addBlockedSubreddit(entries, name) {
    const normalized = normalizeBlockedSubreddits(entries);
    const subreddit = normalizeSubredditName(name);
    const existing = normalized.find((entry) => entry.name === subreddit);
    if (!subreddit || subreddit.includes("*") || existing?.mode === "all") {
      return { entries: normalized, added: false, previousMode: null };
    }
    const blocked = { name: subreddit, mode: "all" };
    return {
      entries: existing
        ? normalized.map((entry) => (entry === existing ? blocked : entry))
        : [...normalized, blocked],
      added: true,
      previousMode: existing ? existing.mode : null,
    };
  }

  // Undoes a one-click block: removes its ALL rule, or turns it back into
  // the HOME rule it replaced.
  function undoBlockedSubreddit(entries, name, previousMode = null) {
    const subreddit = normalizeSubredditName(name);
    return normalizeBlockedSubreddits(entries).flatMap((entry) => {
      if (entry.name !== subreddit || entry.mode !== "all") return [entry];
      return previousMode === "home" ? [{ name: subreddit, mode: "home" }] : [];
    });
  }

  function normalizeAllowedSubreddits(entries = []) {
    if (!Array.isArray(entries)) return [];

    const deduped = new Set();
    for (const entry of entries) {
      const name = normalizeSubredditName(entry);
      if (name && !name.includes("*")) deduped.add(name);
    }
    return Array.from(deduped);
  }

  function isSubredditAllowed(subredditName, allowedSubreddits = []) {
    const normalizedName = normalizeSubredditName(subredditName);
    return Boolean(normalizedName)
      && normalizeAllowedSubreddits(allowedSubreddits).includes(normalizedName);
  }

  function normalizeTitleKeywords(keywords = []) {
    if (!Array.isArray(keywords)) return [];

    const deduped = new Map();
    for (const keyword of keywords) {
      if (typeof keyword !== "string") continue;
      const normalized = keyword.trim().replace(/\s+/g, " ");
      if (!normalized) continue;

      const comparisonKey = normalized.toLowerCase();
      if (!deduped.has(comparisonKey)) deduped.set(comparisonKey, normalized);
    }
    return Array.from(deduped.values());
  }

  // Flairs are free text chosen by each subreddit: keep their spelling, but
  // compare them case-insensitively and allow * wildcards.
  function normalizeBlockedFlairs(flairs = []) {
    return normalizeTitleKeywords(flairs).filter((flair) => flair.length <= 100);
  }

  function normalizeFlairText(text) {
    return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  }

  function matchesFlairPattern(pattern, flairText) {
    const flair = normalizeFlairText(flairText);
    if (!flair || !pattern) return false;
    if (!pattern.includes("*")) return pattern.toLowerCase() === flair.toLowerCase();
    return getWildcardPattern(pattern).test(flair);
  }

  // Filters test many texts against the same keywords: normalize them once.
  function createKeywordMatcher(keywords = []) {
    const normalizedKeywords = normalizeTitleKeywords(keywords)
      .map((keyword) => keyword.toLowerCase());
    return (text) => {
      if (typeof text !== "string" || !text || normalizedKeywords.length === 0) return false;
      const normalizedText = text.trim().replace(/\s+/g, " ").toLowerCase();
      return normalizedKeywords.some((keyword) => normalizedText.includes(keyword));
    };
  }

  function isValidSettingValue(key, value) {
    if (key === "blockedSubreddits") {
      return Array.isArray(value) && value.every((entry) => {
        if (typeof entry === "string") return normalizeBlockedEntry(entry) !== null;
        return Boolean(entry && typeof entry === "object"
          && normalizeBlockedEntry(entry)
          && (entry.mode === undefined || entry.mode === "home" || entry.mode === "all"));
      });
    }
    if (key === "allowedSubreddits") {
      return Array.isArray(value) && value.every((entry) =>
        typeof entry === "string" && normalizeAllowedSubreddits([entry]).length === 1
      );
    }
    if (key === "blockedTitleKeywords") {
      return Array.isArray(value) && value.every((entry) =>
        typeof entry === "string" && normalizeTitleKeywords([entry]).length === 1
      );
    }
    if (key === "blockedFlairs") {
      return Array.isArray(value) && value.every((entry) =>
        typeof entry === "string" && normalizeBlockedFlairs([entry]).length === 1
      );
    }
    if (key === "scrollLimit") return Number.isSafeInteger(value) && value > 0;
    if (key === "scrollMode") return value === "fixed" || value === "button";
    if (key === "theme") return value === "system" || value === "dark" || value === "light";
    return typeof value === "boolean";
  }

  function getInvalidSettingKeys(values = {}) {
    if (!values || typeof values !== "object" || Array.isArray(values)) return [];
    return STORAGE_KEYS.filter((key) =>
      Object.prototype.hasOwnProperty.call(values, key)
      && !isValidSettingValue(key, values[key])
    );
  }

  function coerceSettings(values = {}) {
    const source = values && typeof values === "object" ? values : {};
    const settings = {
      ...DEFAULT_SETTINGS,
      blockedSubreddits: [],
      allowedSubreddits: [],
      blockedTitleKeywords: [],
      blockedFlairs: [],
    };
    for (const key of STORAGE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (key === "blockedSubreddits") {
        settings[key] = normalizeBlockedSubreddits(source[key]);
      } else if (key === "allowedSubreddits") {
        settings[key] = normalizeAllowedSubreddits(source[key]);
      } else if (key === "blockedTitleKeywords") {
        settings[key] = normalizeTitleKeywords(source[key]);
      } else if (key === "blockedFlairs") {
        settings[key] = normalizeBlockedFlairs(source[key]);
      } else if (key === "scrollLimit") {
        settings[key] = Number.isSafeInteger(source[key]) && source[key] > 0
          ? source[key] : DEFAULT_SETTINGS.scrollLimit;
      } else if (key === "scrollMode") {
        settings[key] = source[key] === "button" ? "button" : "fixed";
      } else if (key === "theme") {
        settings[key] = normalizeTheme(source[key]);
      } else {
        settings[key] = source[key] === true;
      }
    }
    for (const [parent, sections] of Object.entries(SETTING_GROUPS)) {
      if (!settings[parent]) continue;
      for (const section of sections) settings[section] = true;
    }
    return settings;
  }

  // Applies storage.onChanged changes to stored values, which stay raw:
  // settings are derived from them with coerceSettings.
  function applyStorageChanges(storedValues, changes = {}) {
    const source = changes && typeof changes === "object" ? changes : {};
    const values = {};
    for (const key of STORAGE_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(source, key)
        ? source[key]?.newValue
        : storedValues?.[key];
      if (value !== undefined) values[key] = value;
    }
    return values;
  }

  function createSettingsStore(storageArea, { onLoadError } = {}) {
    // Settings come from the stored values every time, so a setting implied
    // by another (replies by all comments) follows it when it changes alone.
    let storedValues = {};
    let settings = coerceSettings();
    let loaded = false;
    let loadPromise = null;
    let pendingChanges = {};

    function applyChanges(changes) {
      if (!loaded) {
        pendingChanges = { ...pendingChanges, ...changes };
      }
      storedValues = applyStorageChanges(storedValues, changes);
      settings = coerceSettings(storedValues);
      return settings;
    }

    function load() {
      if (loaded) return Promise.resolve(settings);

      if (!loadPromise) {
        loadPromise = storageArea
          .get(STORAGE_KEYS)
          .then((stored) => {
            storedValues = applyStorageChanges(
              applyStorageChanges(stored),
              pendingChanges,
            );
          })
          .catch((error) => {
            onLoadError?.(error);
          })
          .then(() => {
            settings = coerceSettings(storedValues);
            loaded = true;
            pendingChanges = {};
            return settings;
          })
          .finally(() => {
            loadPromise = null;
          });
      }

      return loadPromise;
    }

    return Object.freeze({
      applyChanges,
      get: () => settings,
      load,
    });
  }

  function getSubredditPath(pathname) {
    if (typeof pathname !== "string") return null;

    const match = pathname.match(/^\/r\/([^/]+)(?:\/(.*))?$/i);
    if (!match) return null;

    const name = normalizeSubredditName(match[1]);
    if (!name) return null;

    return {
      name,
      rest: (match[2] || "").replace(/\/+$/, "").toLowerCase(),
    };
  }

  function isSubredditFrontPath(pathname) {
    const subreddit = getSubredditPath(pathname);
    if (!subreddit) return false;
    const [firstSegment] = subreddit.rest.split("/");
    return subreddit.rest === "" || SUBREDDIT_SORTS.has(firstSegment);
  }

  function getBlockedRoute(pathname, settings) {
    const config = coerceSettings(settings);
    const subreddit = getSubredditPath(pathname);

    for (const route of PAGE_ROUTES) {
      if (config[route.key] && PAGE_PATTERNS.get(route).test(pathname)) return route;
    }

    if (!subreddit) return null;
    if (isSubredditAllowed(subreddit.name, config.allowedSubreddits)) return null;

    const subredditFront = isSubredditFrontPath(pathname);
    if (config.blockSubHome && subredditFront) return SUBREDDIT_FRONTS_ROUTE;

    for (const entry of config.blockedSubreddits) {
      if (!matchesSubredditPattern(entry.name, subreddit.name)) continue;
      if (entry.mode === "all" || (entry.mode === "home" && subredditFront)) {
        return { type: "subreddit", subreddit: subreddit.name, filter: entry.name };
      }
    }

    return null;
  }

  // The Home feed and its sort views, which mix in recommended posts.
  function isHomeFeedPath(pathname) {
    return FRONT_PAGE_PATTERN.test(pathname);
  }

  function isFeedPath(pathname) {
    return FRONT_PAGE_PATTERN.test(pathname) || FEED_PAGE_PATTERN.test(pathname);
  }

  // The block page's query for a route; the blocked URL always follows in
  // the fragment. Navigation rules cannot name the subreddit a pattern
  // matched, so the page then reads it from that URL.
  function blockPageQuery(route) {
    if (!route) return "";

    const params = new URLSearchParams();
    if (route.type === "page") {
      params.set("page", route.page);
    } else {
      params.set("target", "subreddit");
      if (route.subreddit) params.set("subreddit", route.subreddit);
    }
    if (route.filter) params.set("filter", route.filter);
    return `?${params.toString()}`;
  }

  return {
    STORAGE_KEYS,
    SETTING_GROUPS,
    NAVIGATION_STORAGE_KEYS,
    QUICK_BLOCK_UNDO_KEY,
    LISTING_SORTS,
    PAGE_ROUTES,
    SUBREDDIT_FRONTS_ROUTE,
    DEFAULT_SETTINGS,
    applyStorageChanges,
    createSettingsStore,
    coerceSettings,
    getBlockedRoute,
    getInvalidSettingKeys,
    getSubredditPath,
    getRedditUrl,
    matchesSubredditPattern,
    isSubredditAllowed,
    normalizeAllowedSubreddits,
    normalizeBlockedSubreddits,
    addBlockedSubreddit,
    undoBlockedSubreddit,
    normalizeSubredditName,
    normalizeTitleKeywords,
    normalizeBlockedFlairs,
    normalizeFlairText,
    matchesFlairPattern,
    normalizeTheme,
    applyTheme,
    createKeywordMatcher,
    blockPageQuery,
    isFeedPath,
    isHomeFeedPath,
  };
})();
