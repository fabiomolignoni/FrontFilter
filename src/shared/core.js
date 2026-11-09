/**
 * FrontFilter's settings, filter matching and page routes, shared by the
 * background, the content scripts and the extension pages.
 */

var FrontFilter = (() => {
  const DEFAULT_SETTINGS = Object.freeze({
    blockedSubreddits: Object.freeze([]),
    allowedSubreddits: Object.freeze([]),
    blockedUsers: Object.freeze([]),
    // Keep the original key so existing title-filter settings and backups now
    // apply to both post titles and text previews without a migration.
    blockedTitleKeywords: Object.freeze([]),
    // Keywords that keep a post or comment that keyword filters would hide.
    allowedKeywords: Object.freeze([]),
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
    hideBlockPageSettingsButton: false,
    redirectBlockedPages: false,
    redirectUrl: "",
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
  // Not a setting either: the version of the stored settings' format, also
  // written in exports. Version 2 matches keywords as whole words; earlier
  // settings have no version.
  const SETTINGS_VERSION_KEY = "settingsVersion";
  const SETTINGS_VERSION = 2;
  const NAVIGATION_STORAGE_KEYS = Object.freeze([
    "blockedSubreddits",
    "allowedSubreddits",
    "blockedUsers",
    "blockHomepage",
    "blockPopular",
    "blockExplore",
    "blockNews",
    "blockSubHome",
    "redirectBlockedPages",
    "redirectUrl",
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
    { key: "blockHomepage", page: "homepage", path: `(/(${LISTING_SORT_PATTERN}))?/?` },
    { key: "blockPopular", page: "popular", path: "/r/popular(/.*)?" },
    { key: "blockExplore", page: "explore", path: "/explore(/.*)?" },
    { key: "blockNews", page: "news", path: "/news(/.*)?" },
  ].map((route) => Object.freeze({ type: "page", ...route })));
  const SUBREDDIT_FRONTS_ROUTE = Object.freeze({ type: "page", page: "subhome" });
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

  // A typed subreddit or user as a lowercase path, without its query or
  // fragment, and whether it came from a URL: a Reddit URL gives its path,
  // and any other URL gives null.
  function parseTypedPath(value) {
    if (typeof value !== "string") return null;

    const text = value.trim().toLowerCase();
    const looksLikeUrl = /^https?:\/\//i.test(text);
    if (looksLikeUrl || /^(?:[\w-]+\.)?reddit\.com(?:\/|$)/i.test(text)) {
      const url = getRedditUrl(looksLikeUrl ? text : `https://${text}`);
      return url && { path: url.pathname, fromUrl: true };
    }
    return { path: text.split(/[?#]/, 1)[0], fromUrl: false };
  }

  // A prefix alone, such as r/ or u/, names no subreddit and no user.
  function isPrefixAlone(path) {
    return /^\/*(?:r|u|user)\/+$/i.test(path);
  }

  function normalizeSubredditName(value) {
    const typed = parseTypedPath(value);
    if (!typed?.path || isPrefixAlone(typed.path)) return "";
    const name = typed.path.replace(/^\/+|\/+$/g, "");

    // A path names a subreddit after r/. A bare name is one segment, so a
    // user profile, such as u/name, is not taken for a subreddit named u.
    const subredditPathMatch = name.match(/^r\/([a-z0-9_*]+)(?:\/.*)?$/i)
      || (!typed.fromUrl && name.match(/^([a-z0-9_*]+)$/i));
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

  // Whether a subreddit matches any of many patterns, as with
  // matchesSubredditPattern: the patterns are prepared once, so pages can
  // test every post against them.
  function createSubredditMatcher(patterns = []) {
    const names = new Set();
    const wildcards = [];
    for (const pattern of patterns) {
      const normalized = normalizeSubredditName(pattern);
      if (!normalized) continue;
      names.add(normalized);
      if (normalized.includes("*")) wildcards.push(getWildcardPattern(normalized));
    }
    return (subredditName) => {
      const name = normalizeSubredditName(subredditName);
      return Boolean(name) && (names.has(name) || wildcards.some((regex) => regex.test(name)));
    };
  }

  function normalizeMode(mode) {
    return mode === "all" ? "all" : "home";
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

  // Reddit usernames hold up to 20 letters, digits, _ and -, and compare
  // ignoring case. A name is typed alone, after u/ or user/, or as the URL
  // of a profile.
  function normalizeUserName(value) {
    const typed = parseTypedPath(value);
    if (!typed?.path || isPrefixAlone(typed.path)) return "";
    const path = typed.path.replace(/^\/+|\/+$/g, "");

    const userMatch = path.match(/^(?:u|user)\/+([a-z0-9_-]+)(?:\/.*)?$/)
      || (!typed.fromUrl && path.match(/^([a-z0-9_-]+)$/));
    return userMatch && userMatch[1].length <= 20 ? userMatch[1] : "";
  }

  function normalizeBlockedUsers(entries = []) {
    if (!Array.isArray(entries)) return [];

    const deduped = new Set();
    for (const entry of entries) {
      const name = normalizeUserName(entry);
      if (name) deduped.add(name);
    }
    return Array.from(deduped);
  }

  function isSubredditAllowed(subredditName, allowedSubreddits = []) {
    const normalizedName = normalizeSubredditName(subredditName);
    return Boolean(normalizedName)
      && normalizeAllowedSubreddits(allowedSubreddits).includes(normalizedName);
  }

  // Typed filters and Reddit's markup both vary in their whitespace.
  function normalizeText(text) {
    return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  }

  // Accented letters compare as their base letters, as in browsers' find in
  // page: "perche" finds "Perché". Marks that are letters of their own, such
  // as Japanese dakuten, stay.
  function foldAccents(text) {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
  }

  // Text as keywords compare it: ignoring case, accents and spacing.
  function foldKeywordText(text) {
    return normalizeText(foldAccents(text.toLowerCase()));
  }

  // Keywords match whole words: "ai" finds "AI art" and "(AI)", not "said".
  // Words are letters, digits and the marks that belong to letters, except
  // in scripts written without spaces between words, and in Korean, whose
  // words take particles: there keywords also match inside words.
  const WORD_CHARACTER = "[\\p{L}\\p{N}\\p{M}]";
  const UNSPACED_CHARACTER = `[${[
    "Han", "Hiragana", "Katakana", "Hangul", "Thai", "Lao", "Khmer", "Myanmar",
  ].map((script) => `\\p{scx=${script}}`).join("")}]`;
  const SPACED_WORD_CHARACTER = new RegExp(`^(?!${UNSPACED_CHARACTER})${WORD_CHARACTER}$`, "u");
  const WORD_START = `(?:(?<!${WORD_CHARACTER})|(?<=${UNSPACED_CHARACTER}))`;
  const WORD_END = `(?:(?!${WORD_CHARACTER})|(?=${UNSPACED_CHARACTER}))`;

  function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }

  // A keyword between slashes, such as /colou?r/, is a regular expression.
  function getKeywordRegexSource(keyword) {
    return keyword.length > 2 && keyword.startsWith("/") && keyword.endsWith("/")
      ? keyword.slice(1, -1)
      : null;
  }

  // Settings are checked often: compile each expression once, as null when
  // it is not valid.
  const keywordRegexes = new Map();
  function getKeywordRegex(source) {
    if (!keywordRegexes.has(source)) {
      let regex = null;
      try {
        regex = new RegExp(source, "iu");
      } catch {
        // An invalid expression filters nothing.
      }
      if (keywordRegexes.size > 1000) keywordRegexes.clear();
      keywordRegexes.set(source, regex);
    }
    return keywordRegexes.get(source);
  }

  // Any other keyword: its folded text, and whether its start and its end
  // must each be a word boundary. A * at an end lets the keyword go on
  // inside a word there, as in spoiler* or *ai*; a * elsewhere is text. An
  // edge that is not a letter or digit, as in "50%", needs no boundary.
  function parseWordKeyword(keyword) {
    const text = foldKeywordText(keyword.replace(/^\*+|\*+$/g, ""));
    const characters = Array.from(text);
    return {
      text,
      start: !keyword.startsWith("*") && SPACED_WORD_CHARACTER.test(characters[0] ?? ""),
      end: !keyword.endsWith("*") && SPACED_WORD_CHARACTER.test(characters.at(-1) ?? ""),
    };
  }

  // Keywords that match the same texts are one rule: regular expressions
  // when written alike, other keywords ignoring case, accents, and stars
  // that change nothing. A keyword that cannot match, such as an invalid
  // regular expression or a * alone, has no key.
  function getKeywordKey(keyword) {
    const text = normalizeText(keyword);
    const source = getKeywordRegexSource(text);
    if (source !== null) return getKeywordRegex(source) ? `regex:${text}` : "";
    const word = parseWordKeyword(text);
    return word.text && `text:${Number(word.start)}${Number(word.end)}:${word.text}`;
  }

  // Each text once, by its comparison key: the first spelling stays.
  function normalizeTextList(values, getKey) {
    if (!Array.isArray(values)) return [];

    const deduped = new Map();
    for (const value of values) {
      const normalized = normalizeText(value);
      const comparisonKey = normalized && getKey(normalized);
      if (comparisonKey && !deduped.has(comparisonKey)) deduped.set(comparisonKey, normalized);
    }
    return Array.from(deduped.values());
  }

  function normalizeTitleKeywords(keywords = []) {
    return normalizeTextList(keywords, getKeywordKey);
  }

  // Flairs are free text chosen by each subreddit: keep their spelling, but
  // compare them case-insensitively and allow * wildcards.
  function normalizeBlockedFlairs(flairs = []) {
    return normalizeTextList(flairs, (flair) => flair.toLowerCase())
      .filter((flair) => flair.length <= 100);
  }

  function matchesFlairPattern(pattern, flairText) {
    const flair = normalizeText(flairText);
    if (!flair || !pattern) return false;
    if (!pattern.includes("*")) return pattern.toLowerCase() === flair.toLowerCase();
    return getWildcardPattern(pattern).test(flair);
  }

  // A parsed keyword as a pattern for folded text, or null when neither of
  // its ends needs a word boundary.
  function getWholeWordRegex({ text, start, end }) {
    if (!start && !end) return null;
    return new RegExp(`${start ? WORD_START : ""}${escapeRegex(text)}${end ? WORD_END : ""}`, "u");
  }

  // Filters test many texts against the same keywords: prepare them once.
  // Regular expressions ignore case, and also find accented text when they
  // are written without accents.
  function createKeywordMatcher(keywords = []) {
    const words = [];
    const regexes = [];
    for (const keyword of normalizeTitleKeywords(keywords)) {
      const source = getKeywordRegexSource(keyword);
      if (source !== null) {
        regexes.push(getKeywordRegex(source));
      } else {
        const word = parseWordKeyword(keyword);
        words.push({ text: word.text, wholeWord: getWholeWordRegex(word) });
      }
    }
    if (words.length === 0 && regexes.length === 0) return () => false;

    return (text) => {
      const normalizedText = normalizeText(text);
      if (!normalizedText) return false;
      if (words.length > 0) {
        const foldedText = foldKeywordText(normalizedText);
        // Most texts contain no keyword at all: finding one is much faster
        // than checking word boundaries everywhere.
        const found = words.some((word) => foldedText.includes(word.text)
          && (!word.wholeWord || word.wholeWord.test(foldedText)));
        if (found) return true;
      }
      if (regexes.length === 0) return false;
      const foldedText = foldAccents(normalizedText);
      return regexes.some((regex) => regex.test(normalizedText)
        || (foldedText !== normalizedText && regex.test(foldedText)));
    };
  }

  // A keyword saved before keywords matched whole words, written to match
  // what it matched then: its text anywhere, ignoring case. Stars go on the
  // ends that would now need a word boundary, so ai becomes *ai*. Text that
  // now means more, between slashes or with a * at an end, becomes an
  // expression that finds that text.
  function upgradeLegacyKeyword(keyword) {
    const text = normalizeText(keyword);
    if (!text) return keyword;
    if (getKeywordRegexSource(text) !== null || text.startsWith("*") || text.endsWith("*")) {
      return `/${escapeRegex(text)}/`;
    }
    const { start, end } = parseWordKeyword(text);
    return `${start ? "*" : ""}${text}${end ? "*" : ""}`;
  }

  // Values stored or exported by an earlier version, as values of this one.
  // Those from before keywords matched whole words have no version: their
  // keywords are upgraded to match the same texts.
  function upgradeSettings(values) {
    const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
    const upgraded = { ...source, [SETTINGS_VERSION_KEY]: SETTINGS_VERSION };
    if (!(source[SETTINGS_VERSION_KEY] >= SETTINGS_VERSION)
      && Array.isArray(source.blockedTitleKeywords)) {
      upgraded.blockedTitleKeywords = source.blockedTitleKeywords.map(upgradeLegacyKeyword);
    }
    return upgraded;
  }

  // The website blocked pages can lead to instead of the block page, typed
  // with or without its scheme, such as example.com. Only web addresses are
  // kept: pages go there with location.replace.
  function normalizeRedirectUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";

    const text = value.trim();
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      const isWebUrl = url.protocol === "http:" || url.protocol === "https:";
      return isWebUrl && url.hostname ? url.href : "";
    } catch {
      return "";
    }
  }

  // Each list setting keeps the entries its normalizer accepts.
  const LIST_SETTINGS = Object.freeze({
    blockedSubreddits: normalizeBlockedSubreddits,
    allowedSubreddits: normalizeAllowedSubreddits,
    blockedUsers: normalizeBlockedUsers,
    blockedTitleKeywords: normalizeTitleKeywords,
    allowedKeywords: normalizeTitleKeywords,
    blockedFlairs: normalizeBlockedFlairs,
  });
  const CHOICE_SETTINGS = Object.freeze({
    scrollMode: Object.freeze(["fixed", "button"]),
    theme: Object.freeze(["system", "dark", "light"]),
  });

  // Any other setting is a switch.
  function coerceSetting(key, value) {
    const normalizeList = LIST_SETTINGS[key];
    if (normalizeList) return normalizeList(value);
    const choices = CHOICE_SETTINGS[key];
    if (choices) return choices.includes(value) ? value : DEFAULT_SETTINGS[key];
    if (key === "scrollLimit") {
      return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_SETTINGS.scrollLimit;
    }
    if (key === "redirectUrl") return normalizeRedirectUrl(value);
    return value === true;
  }

  // Imports are validated strictly: a value is valid when coercing it keeps
  // it as it is, a list when coercing keeps each of its entries, and an
  // address when it is empty or a web address.
  function isValidSettingValue(key, value) {
    if (key === "redirectUrl") {
      return typeof value === "string" && (value === "" || Boolean(normalizeRedirectUrl(value)));
    }
    const normalizeList = LIST_SETTINGS[key];
    if (!normalizeList) return coerceSetting(key, value) === value;
    return Array.isArray(value) && value.every((entry) =>
      normalizeList([entry]).length === 1
      && (typeof entry !== "object" || [undefined, "home", "all"].includes(entry.mode))
    );
  }

  function getInvalidSettingKeys(values = {}) {
    if (!values || typeof values !== "object" || Array.isArray(values)) return [];
    return STORAGE_KEYS.filter((key) =>
      Object.hasOwn(values, key) && !isValidSettingValue(key, values[key])
    );
  }

  // Settings for stored or imported values: invalid and missing values take
  // their defaults, and switches that imply their sections turn them on.
  function coerceSettings(values = {}) {
    const source = values && typeof values === "object" ? values : {};
    const settings = {};
    for (const key of STORAGE_KEYS) {
      const value = Object.hasOwn(source, key) ? source[key] : DEFAULT_SETTINGS[key];
      settings[key] = coerceSetting(key, value);
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
      const value = Object.hasOwn(source, key)
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

  // The user a page belongs to: their profile, under /user/ or /u/, or
  // their profile's subreddit, r/u_name.
  function getProfileUser(pathname) {
    if (typeof pathname !== "string") return "";

    const match = pathname.match(/^\/(?:u|user)\/([^/]+)(?:\/.*)?$/i)
      || pathname.match(/^\/r\/u_([^/]+)(?:\/.*)?$/i);
    return match ? normalizeUserName(match[1]) : "";
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

    // Subreddit exceptions do not apply to a blocked user's profile.
    const user = getProfileUser(pathname);
    if (user && config.blockedUsers.includes(user)) return { type: "user", user };

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

  // Where blocked pages go instead of the block page, if the settings choose
  // a website: none when that website is a blocked Reddit page itself, which
  // would only redirect again.
  function getBlockRedirectUrl(settings) {
    const config = coerceSettings(settings);
    if (!config.redirectBlockedPages || !config.redirectUrl) return "";
    const redditUrl = getRedditUrl(config.redirectUrl);
    return redditUrl && getBlockedRoute(redditUrl.pathname, config) ? "" : config.redirectUrl;
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
    } else if (route.type === "user") {
      params.set("target", "user");
      params.set("user", route.user);
    } else {
      params.set("target", "subreddit");
      if (route.subreddit) params.set("subreddit", route.subreddit);
    }
    if (route.filter) params.set("filter", route.filter);
    return `?${params.toString()}`;
  }

  // The settings page in a tab of its own. Its Add current buttons add the
  // subreddit given here, as the tab they would read is the settings page.
  function settingsPagePath(subreddit) {
    const params = new URLSearchParams({ standalone: "true" });
    const [name] = normalizeAllowedSubreddits([subreddit]);
    if (name) params.set("currentSubreddit", name);
    return `popup/index.html?${params.toString()}`;
  }

  return {
    STORAGE_KEYS,
    SETTING_GROUPS,
    NAVIGATION_STORAGE_KEYS,
    QUICK_BLOCK_UNDO_KEY,
    SETTINGS_VERSION_KEY,
    SETTINGS_VERSION,
    LISTING_SORTS,
    PAGE_ROUTES,
    SUBREDDIT_FRONTS_ROUTE,
    DEFAULT_SETTINGS,
    applyStorageChanges,
    createSettingsStore,
    coerceSettings,
    getBlockedRoute,
    getBlockRedirectUrl,
    getInvalidSettingKeys,
    getSubredditPath,
    getProfileUser,
    getRedditUrl,
    matchesSubredditPattern,
    createSubredditMatcher,
    isSubredditAllowed,
    normalizeAllowedSubreddits,
    normalizeBlockedSubreddits,
    addBlockedSubreddit,
    undoBlockedSubreddit,
    normalizeSubredditName,
    normalizeUserName,
    normalizeBlockedUsers,
    normalizeTitleKeywords,
    getKeywordKey,
    upgradeSettings,
    normalizeBlockedFlairs,
    normalizeRedirectUrl,
    normalizeText,
    matchesFlairPattern,
    createKeywordMatcher,
    blockPageQuery,
    settingsPagePath,
    isFeedPath,
    isHomeFeedPath,
  };
})();
