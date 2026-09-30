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
    // Keep the legacy storage key for the right sidebar toggle and older exports.
    hideRelatedPosts: false,
    limitInfiniteScroll: false,
    scrollLimit: 25,
    scrollMode: "fixed",
    theme: "system",
  });
  const STORAGE_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
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
  const FRONT_PAGE_PATTERN = new RegExp(`^/(?:${LISTING_SORT_PATTERN})?/?$`, "i");
  const FEED_PAGE_PATTERN = new RegExp(
    `^/r/[^/]+(?:/(?:${LISTING_SORT_PATTERN}))?/?$`,
    "i",
  );
  const PAGE_RULES = [
    {
      key: "blockHomepage",
      page: "homepage",
      filter: "Homepage",
      pattern: FRONT_PAGE_PATTERN,
    },
    { key: "blockPopular", page: "popular", filter: "r/popular", pattern: /^\/r\/popular(?:\/.*)?$/i },
    { key: "blockExplore", page: "explore", filter: "Explore", pattern: /^\/explore(?:\/.*)?$/i },
    { key: "blockNews", page: "news", filter: "News", pattern: /^\/news(?:\/.*)?$/i },
  ];

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

  function matchesSubredditPattern(pattern, subredditName) {
    const normalizedPattern = normalizeSubredditName(pattern);
    const normalizedSubreddit = normalizeSubredditName(subredditName);
    if (!normalizedPattern || !normalizedSubreddit) return false;
    if (normalizedPattern === normalizedSubreddit) return true;
    if (!normalizedPattern.includes("*")) return false;

    const regexSource = normalizedPattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${regexSource}$`, "i").test(normalizedSubreddit);
  }

  function normalizeMode(mode) {
    return mode === "all" ? "all" : "home";
  }

  function normalizeTheme(theme) {
    return theme === "dark" || theme === "light" ? theme : "system";
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

  function normalizeBlockedSubreddits(entries = []) {
    if (!Array.isArray(entries)) return [];

    const deduped = new Map();
    for (const entry of entries) {
      const normalized = normalizeBlockedEntry(entry);
      if (!normalized) continue;
      deduped.set(`${normalized.name}:${normalized.mode}`, normalized);
    }
    return Array.from(deduped.values());
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

  function textMatchesKeywords(text, keywords = []) {
    if (typeof text !== "string" || !text) return false;
    const normalizedText = text.trim().replace(/\s+/g, " ").toLowerCase();
    return normalizeTitleKeywords(keywords).some((keyword) =>
      normalizedText.includes(keyword.toLowerCase())
    );
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
    };
    for (const key of STORAGE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (key === "blockedSubreddits") {
        settings[key] = normalizeBlockedSubreddits(source[key]);
      } else if (key === "allowedSubreddits") {
        settings[key] = normalizeAllowedSubreddits(source[key]);
      } else if (key === "blockedTitleKeywords") {
        settings[key] = normalizeTitleKeywords(source[key]);
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
    if (settings.hideComments) settings.hideCommentReplies = true;
    if (settings.hideNavbar) {
      settings.hideNavbarMenu = true;
      settings.hideNavbarSearch = true;
      settings.hideNavbarChat = true;
      settings.hideNavbarNotifications = true;
      settings.hideNavbarProfile = true;
      settings.hideNavbarOthers = true;
    }
    if (settings.hideLeftSidebar) {
      settings.hideLeftSidebarGames = true;
      settings.hideLeftSidebarCustomFeeds = true;
      settings.hideLeftSidebarRecent = true;
      settings.hideLeftSidebarCommunities = true;
      settings.hideLeftSidebarResources = true;
    }
    return settings;
  }

  function applyStorageChanges(settings, changes = {}) {
    const source = changes && typeof changes === "object" ? changes : {};
    const updates = {};
    for (const key of STORAGE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        updates[key] = source[key]?.newValue;
      }
    }
    return coerceSettings({ ...coerceSettings(settings), ...updates });
  }

  function createSettingsStore(storageArea, { onLoadError } = {}) {
    let settings = coerceSettings();
    let loaded = false;
    let loadPromise = null;
    let pendingChanges = {};

    function applyChanges(changes) {
      if (!loaded) {
        pendingChanges = { ...pendingChanges, ...changes };
      }
      settings = applyStorageChanges(settings, changes);
      return settings;
    }

    function load() {
      if (loaded) return Promise.resolve(settings);

      if (!loadPromise) {
        loadPromise = storageArea
          .get(STORAGE_KEYS)
          .then((storedSettings) => {
            settings = applyStorageChanges(
              coerceSettings(storedSettings),
              pendingChanges,
            );
          })
          .catch((error) => {
            settings = coerceSettings(settings);
            onLoadError?.(error);
          })
          .then(() => {
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

    for (const rule of PAGE_RULES) {
      if (config[rule.key] && rule.pattern.test(pathname)) {
        return { type: "page", page: rule.page, filter: rule.filter };
      }
    }

    if (!subreddit) return null;
    if (isSubredditAllowed(subreddit.name, config.allowedSubreddits)) return null;

    const subredditFront = isSubredditFrontPath(pathname);
    if (config.blockSubHome && subredditFront) {
      return {
        type: "page",
        page: "subhome",
        subreddit: subreddit.name,
        filter: "All Sub Fronts",
      };
    }

    for (const entry of config.blockedSubreddits) {
      if (!matchesSubredditPattern(entry.name, subreddit.name)) continue;
      if (entry.mode === "all" || (entry.mode === "home" && subredditFront)) {
        return { type: "subreddit", subreddit: subreddit.name, filter: entry.name };
      }
    }

    return null;
  }

  function isFeedPath(pathname) {
    return FRONT_PAGE_PATTERN.test(pathname) || FEED_PAGE_PATTERN.test(pathname);
  }

  function blockedRouteToQuery(route, returnUrl = "") {
    if (!route) return "";

    const params = new URLSearchParams();
    if (route.type === "page") {
      params.set("page", route.page);
    } else {
      params.set("subreddit", route.subreddit);
    }

    if (returnUrl) params.set("returnUrl", returnUrl);
    if (route.filter) params.set("filter", route.filter);
    return `?${params.toString()}`;
  }

  return {
    STORAGE_KEYS,
    NAVIGATION_STORAGE_KEYS,
    LISTING_SORTS,
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
    normalizeSubredditName,
    normalizeTitleKeywords,
    normalizeTheme,
    textMatchesKeywords,
    blockedRouteToQuery,
    isFeedPath,
  };
})();
