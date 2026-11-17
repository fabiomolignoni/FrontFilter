/**
 * Compiles FrontFilter settings into Manifest V3 declarative navigation rules.
 * The content script uses the same route model for client-side navigation.
 */
FrontFilter.NAVIGATION_RULE_ID_START = 1000;
FrontFilter.NAVIGATION_RULE_ID_END = 1000000;
FrontFilter.NAVIGATION_RULE_LIMIT = 1000;
// Of the rules that match an address, the one with the highest priority
// applies. Blocked main pages and users' profiles outrank the exceptions,
// which outrank what they are exceptions to: the block of every subreddit's
// front page, and the subreddit rules.
FrontFilter.NAVIGATION_RULE_PRIORITIES = Object.freeze({
  page: 30,
  user: 30,
  exception: 25,
  subredditFronts: 20,
  subreddit: 10,
});

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
  const PRIORITY = FrontFilter.NAVIGATION_RULE_PRIORITIES;
  // A website chosen in the settings, which gets none of the blocked address.
  const redirectUrl = FrontFilter.getBlockRedirectUrl(config);
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
      redirect: redirectUrl ? { url: redirectUrl } : {
        // The original request is kept in the fragment. It remains local to
        // the extension page and can contain its own query string safely.
        regexSubstitution: `${blockPageUrl}${FrontFilter.blockPageQuery(route)}#\\0`,
      },
    }, priority);
  }

  for (const route of FrontFilter.PAGE_ROUTES) {
    if (config[route.key]) addRedirect(`${reddit}${route.path}${query}`, route, PRIORITY.page);
  }

  // A subreddit name or pattern as a regular expression for its path.
  // Names hold no regular expression syntax but the wildcard's *, which
  // alone stands for every subreddit: /r/ itself names none.
  function subredditPath(pattern) {
    return pattern === "*" ? "/r/[a-z0-9_]+" : `/r/${pattern.split("*").join("[a-z0-9_]*")}`;
  }

  // Exceptions apply only to the global subreddit-front rule and user-defined
  // subreddit patterns below, and only those that rules could block take a
  // rule: an exact name a rule matches, or any pattern while there are rules.
  const isBlocked = FrontFilter.createSubredditMatcher(
    config.blockedSubreddits.map(({ name }) => name),
  );
  const relevantExceptions = config.allowedSubreddits.filter((name) =>
    config.blockSubHome
    || (name.includes("*") ? config.blockedSubreddits.length > 0 : isBlocked(name))
  );
  for (const name of relevantExceptions) {
    addRule(
      `${reddit}${subredditPath(name)}(/.*)?${query}`,
      { type: "allow" },
      PRIORITY.exception,
    );
  }

  const frontSuffix = `(/(${FrontFilter.LISTING_SORTS.join("|")})(/.*)?)?/*${query}`;
  if (config.blockSubHome) {
    addRedirect(
      `${reddit}/r/[a-z0-9_]+${frontSuffix}`,
      FrontFilter.SUBREDDIT_FRONTS_ROUTE,
      PRIORITY.subredditFronts,
    );
  }

  for (const entry of config.blockedSubreddits) {
    const suffix = entry.mode === "all" ? `(/.*)?${query}` : frontSuffix;
    if (!addRedirect(
      `${reddit}${subredditPath(entry.name)}${suffix}`,
      { type: "subreddit", filter: entry.name },
      PRIORITY.subreddit,
    )) break;
  }

  // A blocked user's profile, also reached through its subreddit, r/u_name.
  // Like page blocks, these outrank subreddit exceptions. Usernames hold no
  // regular expression syntax.
  for (const user of config.blockedUsers) {
    if (!addRedirect(
      `${reddit}/(u/|user/|r/u_)${user}(/.*)?${query}`,
      { type: "user", user },
      PRIORITY.user,
    )) break;
  }

  return rules;
};
