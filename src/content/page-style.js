/**
 * The CSS rules that hide parts of Reddit for the current settings. CSS
 * also covers elements Reddit adds later, so these features need no page
 * scans. Each selector group gets a rule of its own: a selector the browser
 * rejects cannot disable the others.
 */
FrontFilter.pageStyle = (() => {
  const SELECTORS = FrontFilter.SELECTORS;
  const HOME_FEED_ATTRIBUTE = "data-frontfilter-home-feed";
  // Elements that post, community and comment filters mark as hidden.
  const markers = Object.freeze(Object.fromEntries(
    ["post", "community", "comment"].map((type) => [type, Object.freeze({
      datasetKey: `frontfilter${type[0].toUpperCase()}${type.slice(1)}Hidden`,
      selector: `[data-frontfilter-${type}-hidden="true"]`,
    })]),
  ));

  const hide = (selector) => `${selector} { display: none !important; }`;

  // One rule per selector of each enabled setting.
  function settingRules(settings, selectorsBySetting) {
    return Object.entries(selectorsBySetting)
      .filter(([setting]) => settings[setting])
      .flatMap(([, selectors]) => [].concat(selectors).map(hide));
  }

  // Links to blocked main pages, and the list items that hold them.
  function mainPageLinkRule(settings, scope = "") {
    const links = Object.entries(SELECTORS.mainPageLinks)
      .filter(([setting]) => settings[setting])
      .flatMap(([, selectors]) => selectors);
    if (links.length === 0) return [];
    const prefix = scope ? `${scope} ` : "";
    return [hide([
      `${prefix}li:has(:is(${links.join(", ")}))`,
      ...links.map((link) => `${prefix}${link}`),
    ].join(", "))];
  }

  // The rules for the page itself.
  function pageRules(settings) {
    const markedPost = markers.post.selector;
    const markedArticle = `article:has(> shreddit-post${markedPost})`;
    const comments = settings.hideComments
      ? SELECTORS.comment.layoutsAndActions
      : (settings.hideCommentReplies ? SELECTORS.comment.replies : "");
    const navbar = SELECTORS.navbar;
    return [
      // Elements marked by filters take their article wrapper and trailing
      // feed divider. Those selectors get rules of their own, so :has()
      // support cannot affect the base rule.
      hide(Object.values(markers).map(({ selector }) => selector).join(", ")),
      hide(markedArticle),
      hide(`shreddit-feed :is(${markedPost}, ${markedArticle}) + hr`),
      ...(comments ? [hide(comments)] : []),
      ...(settings.hideSuggestedCommunities ? [hide(SELECTORS.suggestedCommunities)] : []),
      ...(settings.hideAds ? SELECTORS.ads.map(hide) : []),
      // Other feeds, such as Popular, consist of recommendations by design.
      ...settingRules(settings, {
        hideSuggestedPosts: SELECTORS.suggestedPosts.map((selector) =>
          `html[${HOME_FEED_ATTRIBUTE}] ${selector}`),
      }),
      ...settingRules(settings, SELECTORS.socialSignals),
      ...(settings.hideNavbar ? [
        hide(navbar.root),
        `${navbar.layoutRoots} { ${
          navbar.layoutVariables.map((variable) => `${variable}: 0px !important;`).join(" ")
        } }`,
      ] : []),
      ...settingRules(settings, navbar.sections),
      ...(settings.blockHomepage ? [hide(navbar.logo)] : []),
      ...(settings.hideLeftSidebar ? [hide(SELECTORS.leftSidebar.root)] : []),
      ...settingRules(settings, SELECTORS.leftSidebar.sections),
      ...mainPageLinkRule(settings, SELECTORS.leftSidebar.topSectionInPage),
      ...(settings.hideRelatedPosts ? [hide(SELECTORS.rightSidebar)] : []),
    ].join("\n");
  }

  // Rules for shadow roots, which the page's rules cannot reach.
  function commentActionRules(settings) {
    return settings.hideComments ? hide(SELECTORS.comment.actions) : "";
  }

  function shadowSignalRules(settings) {
    return settingRules(settings, SELECTORS.shadowSignals).join("\n");
  }

  function hasShadowSignals(settings) {
    return Object.keys(SELECTORS.shadowSignals).some((setting) => settings[setting]);
  }

  function mainPageLinkRules(settings) {
    return mainPageLinkRule(settings).join("\n");
  }

  function blocksMainPageLinks(settings) {
    return Object.keys(SELECTORS.mainPageLinks).some((setting) => settings[setting]);
  }

  return Object.freeze({
    HOME_FEED_ATTRIBUTE,
    markers,
    pageRules,
    commentActionRules,
    shadowSignalRules,
    hasShadowSignals,
    mainPageLinkRules,
    blocksMainPageLinks,
  });
})();
