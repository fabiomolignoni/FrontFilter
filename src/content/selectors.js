/**
 * Reddit's markup as FrontFilter relies on it: component names, attributes,
 * slots and test IDs, never translated text. When Reddit changes, update
 * this file and the fixtures in tests/fixtures (see CONTRIBUTING.md).
 * feed-bridge.js runs in the page and keeps its own copy of the feed names.
 */
FrontFilter.SELECTORS = (() => {
  const join = (selectors) => selectors.join(", ");

  // Posts: modern cards, older layouts and Old Reddit. Fallbacks only
  // locate posts and are never treated as their outer element.
  const POST_ROOTS = join([
    '[data-testid="post-container"]',
    '[data-testid="post"]',
    "[data-post-id]",
    ".Post",
    "shreddit-post",
    ".thing",
    "article",
    '[role="article"]',
    ".post-container",
  ]);
  const POSTS = join([POST_ROOTS, '[data-click-id="body"]', "[data-ks-id]"]);
  const POST_PERMALINK = 'a[href*="/comments/"]';

  const COMMENT_LAYOUTS = join([
    "shreddit-comment",
    "shreddit-comment-tree",
    '[data-testid="comment"]',
    '[data-testid="comment-tree"]',
    ".Comment",
    ".comment",
  ]);
  const COMMENT_ACTIONS = join([
    '[data-action-bar-action="comments"]',
    '[data-post-click-location="comments-button"]',
    '[name="comments-action-button"]',
    '[data-click-id="comments"]',
    "a.comments",
  ]);

  // Promoted cards match the scroll limit's ad classification, so hidden
  // ads never count toward the limit either way.
  const PROMOTED_ATTRIBUTES = Object.freeze([
    "is-promoted",
    "promoted",
    "data-promoted",
    "data-shreddit-promoted",
  ]);
  const PROMOTED_POSTS = join([
    "shreddit-ad-post",
    '[data-testid="ad-container"]',
    ...PROMOTED_ATTRIBUTES.map((name) =>
      `shreddit-post[${name}]:not([${name}="false" i]):not([${name}="0"])`
    ),
  ]);
  const PROMOTED_ARTICLES = `article:has(> :is(${PROMOTED_POSTS}))`;

  // Reddit marks every recommended Home post with the reason it was picked,
  // including ones whose "Suggested"/"Because you..." label is hidden. The
  // attribute is language-independent; posts from joined communities lack it.
  const SUGGESTED_POSTS = 'shreddit-post[recommendation-source]:not([recommendation-source=""])';
  const SUGGESTED_ARTICLES = `article:has(> ${SUGGESTED_POSTS})`;

  const NAVBARS = [
    "#header",
    "#shreddit-header",
    "reddit-header-large",
    "reddit-header-small",
    "shreddit-app > header",
    'header[role="banner"]',
  ];
  const NAVBAR_SCOPES = [...NAVBARS, "nav.h-header-large"];
  const inNavbar = (selectors) =>
    join(NAVBAR_SCOPES.flatMap((scope) => selectors.map((selector) => `${scope} ${selector}`)));

  // Links to a main page, by path or full URL, with optional sorts and query.
  function linksTo(path) {
    return ["", "https://www.reddit.com"].flatMap((origin) => [
      `a[href="${origin}${path}" i]`,
      `a[href^="${origin}${path}/" i]`,
      `a[href^="${origin}${path}?" i]`,
    ]);
  }

  return Object.freeze({
    subredditLink: 'a[href*="/r/"]',

    post: Object.freeze({
      roots: POST_ROOTS,
      any: POSTS,
      // Comments share some post markers, such as role="article" on their
      // <details> and Old Reddit's .thing; comment filters handle them.
      candidates: `:is(${POSTS}):not(:is(${COMMENT_LAYOUTS}), :is(${COMMENT_LAYOUTS}) *)`,
      permalink: POST_PERMALINK,
      // Comment permalinks also contain /comments/ and comment pages hold
      // one per comment: exclude them in the selector engine.
      permalinkOutsideComments: `${POST_PERMALINK}:not(:is(${COMMENT_LAYOUTS}) *)`,
      subredditAttributes: Object.freeze([
        "subreddit-name",
        "subreddit-prefixed-name",
        "data-subreddit",
        "data-subreddit-prefixed",
      ]),
      titleAttributes: Object.freeze(["post-title", "data-title"]),
      title: join([
        '[slot="title"]',
        '[data-testid="post-title"]',
        '[data-testid="post-title-text"]',
        '[data-adclicklocation="title"]',
        'a[id^="post-title"]',
        "a.title",
        'h1[id^="post-title"]',
        "h2",
        "h3",
      ]),
      bodyAttributes: Object.freeze(["post-body", "data-post-body"]),
      body: join([
        '[slot="text-body"]',
        '[data-post-click-location="text-body"]',
        '[data-testid="post-content"]',
        '[data-testid="post-body"]',
        '[data-click-id="text"]',
        "shreddit-post-text-body",
        ".usertext-body .md",
      ]),
      flair: "shreddit-post-flair, .linkflairlabel",
      promotedAttributes: PROMOTED_ATTRIBUTES,
      adCards: 'shreddit-ad-post, [data-testid="ad-container"]',
      adMarkers: 'shreddit-ad-post, [data-testid="promoted-label"]',
      recommendationAttribute: "recommendation-source",
    }),

    comment: Object.freeze({
      layouts: COMMENT_LAYOUTS,
      actions: COMMENT_ACTIONS,
      layoutsAndActions: join([COMMENT_LAYOUTS, COMMENT_ACTIONS]),
      replies: join([
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
      ]),
      // Changes inside these regions cannot add or alter posts.
      regions: "shreddit-comment-tree, shreddit-comment, .commentarea",
      modern: "shreddit-comment",
      modernBody: '[slot="comment"]',
      oldClassName: "thing comment",
      oldBody: ":scope > .entry .usertext-body",
      // The modern feed action row lives in each post's shadow root.
      actionShadowHost: "shreddit-post",
    }),

    // Component names and tracking attributes follow EasyList and AdGuard's
    // Reddit rules. Each gets a CSS rule of its own, so one the browser
    // rejects cannot disable the others.
    ads: Object.freeze([
      PROMOTED_POSTS,
      PROMOTED_ARTICLES,
      // Feed items are followed by a divider; drop it to avoid a double line.
      `shreddit-feed :is(${PROMOTED_POSTS}, ${PROMOTED_ARTICLES}) + hr`,
      "shreddit-comments-page-ad",
      "shreddit-comment-tree-ad",
      'shreddit-async-loader[bundlename="sidebar_ad"]',
      // Old Reddit adds 1px promoted placeholders that must stay in place.
      '.promotedlink:not([style^="height: 1px;"])',
      `[data-faceplate-tracking-context*='"promoted":true']`,
      'div[data-before-content="advertisement"]',
    ]),

    suggestedPosts: Object.freeze([
      SUGGESTED_POSTS,
      SUGGESTED_ARTICLES,
      `:is(${SUGGESTED_POSTS}, ${SUGGESTED_ARTICLES}) + hr`,
    ].map((selector) => `shreddit-feed ${selector}`)),
    suggestedCommunities: "in-feed-community-recommendations",

    // Identifiers come from Reddit's component markup (slots, tracking nouns
    // and test IDs). Subreddit icons are not user avatars.
    socialSignals: Object.freeze({
      hideVotes: Object.freeze([
        // Modern vote controls render in shadow roots; see shadowSignals.
        // Old Reddit keeps arrows and score in the middle column, and
        // repeats comment scores in the tagline.
        ".thing div.midcol",
        ".comment p.tagline span.score",
      ]),
      hideKarma: Object.freeze([
        // Profile cards wrap the number in a paragraph; user hover cards do not.
        'div:has(> p > [data-testid="karma-number"])',
        'div:has(> [data-testid="karma-number"])',
        '[data-testid="karma-number"]',
        '[noun="karma_help"]',
        "#header-bottom-right .user span",
      ]),
      hideAwards: Object.freeze(["award-button"]),
      hideAvatars: Object.freeze([
        'shreddit-comment [noun="comment_author_avatar"]',
        '[noun="user_profile"] [avatar]',
        'faceplate-hovercard[data-id="user-hover-card"] [slot="content"] [avatar]',
      ]),
      hideUsernames: Object.freeze([
        // Feed posts show the author's avatar beside the name, in its slot.
        'shreddit-post [slot="authorName"] [data-testid="nameplate"]',
        'shreddit-comment [noun="comment_author"]',
        ".entry .tagline .author",
      ]),
    }),
    // Vote buttons, scores and post awards render inside these components'
    // shadow roots. The whole vote group goes, so no empty pill is left,
    // unless its wrapper also holds other actions; the individual controls
    // are then hidden on their own.
    shadowSignalHosts: Object.freeze(["shreddit-post", "shreddit-comment-action-row"]),
    shadowSignals: Object.freeze({
      hideVotes: Object.freeze([
        ':has(> button[upvote]):not(:has(slot, award-button, [data-post-click-location="comments-button"], [name="comments-action-button"]))',
        ".rpl-vote-button-group",
        "button[upvote]",
        "button[downvote]",
        "button[upvote] ~ span:has(faceplate-number)",
      ]),
      hideAwards: Object.freeze(["award-button"]),
    }),

    navbar: Object.freeze({
      root: join(NAVBARS),
      sections: Object.freeze({
        hideNavbarMenu: inNavbar([
          "#hamburger-button-tooltip",
          "#navbar-menu-button",
          "rpl-tooltip:has(#navbar-menu-button)",
        ]),
        hideNavbarSearch: inNavbar([
          'faceplate-loader[name^="SearchInputDesktop_"]',
          "search-dynamic-id-cache-controller",
          "reddit-search-large",
          "reddit-search-small",
        ]),
        hideNavbarChat: inNavbar([
          '[data-part="chat"]',
          "reddit-chat-header-button",
          "#header-action-item-chat-button",
        ]),
        hideNavbarNotifications: inNavbar([
          '[data-part="inbox"]',
          "#notifications-inbox-button",
        ]),
        hideNavbarProfile: inNavbar([
          "div:has(> rpl-dropdown #expand-user-drawer-button)",
          "rpl-dropdown:has(#expand-user-drawer-button)",
          "#expand-user-drawer-button",
        ]),
        hideNavbarOthers: inNavbar([
          '[data-part]:not([data-part="chat"]):not([data-part="inbox"]):not([data-part="menu"]):not([data-part="search"]):not([data-part="profile"]):not([data-part="logo"]):not(:has(#reddit-logo)):not(:has(#navbar-menu-button)):not(:has(reddit-search-large)):not(:has(reddit-search-small)):not(:has(#expand-user-drawer-button))',
        ]),
      }),
      logo: inNavbar([
        "#reddit-logo",
        "a:has(#reddit-logo)",
        '[data-part="logo"]',
        'a:has([data-part="logo"])',
      ]),
      // Shreddit reserves space for its fixed navbar separately from the
      // header itself; resetting both variables at their roots collapses
      // padding and sticky offsets.
      layoutVariables: Object.freeze(["--shreddit-header-height", "--header-height"]),
      layoutRoots: ":root, body, shreddit-app",
    }),

    // These structural identifiers are stable across Reddit locales. The
    // async placeholders are included so a hidden section cannot flash
    // while it is loading.
    leftSidebar: Object.freeze({
      root: join(["#left-sidebar-container", "#left-sidebar"]),
      sections: Object.freeze({
        hideLeftSidebarGames: join([
          '#left-sidebar faceplate-loader[name^="LeftNavGamesSection_"]',
          '#left-sidebar faceplate-tracker[noun="games_drawer"]',
        ]),
        hideLeftSidebarCustomFeeds: join([
          '#left-sidebar faceplate-loader[name^="LeftNavMultiredditsSection_"]',
          '#left-sidebar faceplate-expandable-section-helper:has(> details > summary[aria-controls="multireddits_section"])',
        ]),
        hideLeftSidebarRecent: join([
          '#left-sidebar faceplate-loader[name^="LeftNavRecentSection_"]',
          "#left-sidebar #recent-communities-section",
        ]),
        hideLeftSidebarCommunities: join([
          '#left-sidebar faceplate-loader[name^="LeftNavCommunitiesSection_"]',
          '#left-sidebar faceplate-expandable-section-helper:has(> details > summary[aria-controls="communities_section"])',
        ]),
        hideLeftSidebarResources: join([
          '#left-sidebar faceplate-loader[name^="LeftNavResourcesSection_"]',
          '#left-sidebar faceplate-expandable-section-helper:has(faceplate-tracker[noun="resources_menu"])',
        ]),
      }),
      // Its links to the main pages render in this component's shadow root.
      topSection: "left-nav-top-section",
      topSectionInPage: "#left-sidebar left-nav-top-section",
    }),

    mainPageLinks: Object.freeze({
      blockHomepage: Object.freeze([
        'a[href="/" i]',
        'a[href^="/?" i]',
        'a[href="https://www.reddit.com/" i]',
        'a[href^="https://www.reddit.com/?" i]',
        ...FrontFilter.LISTING_SORTS.flatMap((sort) => linksTo(`/${sort}`)),
      ]),
      blockPopular: Object.freeze(linksTo("/r/popular")),
      blockExplore: Object.freeze(linksTo("/explore")),
      blockNews: Object.freeze(linksTo("/news")),
    }),

    rightSidebar: join([
      "#right-sidebar-container",
      "#right-sidebar",
      ".right-sidebar",
      '[data-testid="right-sidebar"]',
      '[data-testid="right-sidebar-container"]',
      ".side",
      "pdp-right-rail",
      "aside:has(> pdp-right-rail)",
    ]),
    // Panels listing communities; a panel needs links to two subreddits.
    communityPanels: join([
      '[data-testid*="popular-communities" i]',
      "popular-communities",
      "shreddit-popular-communities",
      "#right-sidebar-container",
      '[data-testid*="right-sidebar" i]',
      "aside",
    ]),
    communityListItems: 'li, [role="listitem"]',
    communityItems: '[data-testid*="community" i], [data-testid*="subreddit" i]',

    autoplay: Object.freeze({
      media: "shreddit-player, video",
      player: "shreddit-player",
      attributes: Object.freeze(["autoplay", "autoplay-pref", "muted-autoplay-fallback"]),
    }),

    feed: Object.freeze({
      feed: "shreddit-feed",
      mainFeed: "main shreddit-feed",
      loader: 'faceplate-partial[slot="load-after"]',
      cards: 'shreddit-post, shreddit-ad-post, [data-testid="ad-container"]',
      posts: "shreddit-feed shreddit-post",
      creditBar: ':scope > [slot="credit-bar"]',
      // Join, notifications and the overflow menu, after Create Post; it
      // names the subreddit. The navbar's own Create button has no such
      // sibling.
      subredditHeaderButtons: "shreddit-subreddit-header-buttons[name]",
    }),
  });
})();
