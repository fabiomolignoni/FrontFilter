/**
 * Compiles FrontFilter settings into Manifest V3 declarative navigation rules.
 * The content script uses the same route model for client-side navigation.
 */
FrontFilter.NAVIGATION_RULE_ID_START = 1000;
FrontFilter.NAVIGATION_RULE_ID_END = 1000000;
FrontFilter.NAVIGATION_RULE_LIMIT = 1000;

FrontFilter.isNavigationRuleId = function (id) {
  return Number.isInteger(id)
    && id >= FrontFilter.NAVIGATION_RULE_ID_START
    && id < FrontFilter.NAVIGATION_RULE_ID_END;
};

FrontFilter.createNavigationRules = function (settings, blockPageUrl) {
  if (typeof blockPageUrl !== "string" || !blockPageUrl) {
    throw new TypeError("A block page URL is required");
  }

  const config = FrontFilter.coerceSettings(settings);
  const rules = [];
  const reddit = "^https?://([^/]+\\.)?reddit\\.com(:[0-9]+)?";
  const query = "(\\?.*)?$";
  let nextId = FrontFilter.NAVIGATION_RULE_ID_START;

  function addRule(regexFilter, action, priority) {
    if (rules.length >= FrontFilter.NAVIGATION_RULE_LIMIT) return false;
    if (nextId >= FrontFilter.NAVIGATION_RULE_ID_END) {
      throw new RangeError("Too many navigation rules");
    }

    rules.push({
      id: nextId,
      priority,
      action,
      condition: {
        regexFilter,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ["main_frame"],
      },
    });
    nextId += 1;
    return true;
  }

  function addRedirect(regexFilter, route, priority) {
    return addRule(regexFilter, {
      type: "redirect",
      redirect: {
        // The original request is kept in the fragment. It remains local to
        // the extension page and can contain its own query string safely.
        regexSubstitution: `${blockPageUrl}${FrontFilter.blockPageQuery(route)}#\\0`,
      },
    }, priority);
  }

  for (const route of FrontFilter.PAGE_ROUTES) {
    if (config[route.key]) addRedirect(`${reddit}${route.path}${query}`, route, 30);
  }

  // Global page blocks outrank exceptions. Exceptions apply only to the global
  // subreddit-front rule and user-defined subreddit patterns below.
  const isBlocked = FrontFilter.createSubredditMatcher(
    config.blockedSubreddits.map(({ name }) => name),
  );
  const relevantExceptions = config.allowedSubreddits.filter((name) =>
    config.blockSubHome || isBlocked(name)
  );
  for (const name of relevantExceptions) {
    addRule(
      `${reddit}/r/${name}(/.*)?${query}`,
      { type: "allow" },
      25,
    );
  }

  const frontSuffix = `(/(${FrontFilter.LISTING_SORTS.join("|")})(/.*)?)?/*${query}`;
  if (config.blockSubHome) {
    addRedirect(`${reddit}/r/[a-z0-9_]+${frontSuffix}`, FrontFilter.SUBREDDIT_FRONTS_ROUTE, 20);
  }

  for (const entry of config.blockedSubreddits) {
    const subredditPattern = entry.name
      .split("*")
      .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
      .join("[a-z0-9_]*");
    const suffix = entry.mode === "all" ? `(/.*)?${query}` : frontSuffix;
    if (!addRedirect(
      `${reddit}/r/${subredditPattern}${suffix}`,
      { type: "subreddit", filter: entry.name },
      10,
    )) break;
  }

  return rules;
};
