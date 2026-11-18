/**
 * Modern Reddit feed adapter. Uses the page's own continuation component so
 * sorting, credentials and personalized feed cursors stay owned by Reddit.
 *
 * Reddit changes its pages without notice, so the limit falls back rather
 * than leave a feed empty: posts Reddit no longer identifies count as the
 * page shows them, and without the page's bridge (feed-bridge.js) Reddit
 * loads the next page by itself, while the limit wants more posts.
 */
FrontFilter.createFeedLimiter = function ({ getSettings, isBlocked }) {
  const SELECTORS = FrontFilter.SELECTORS;
  const POSTS = FrontFilter.posts;
  const VIEW = FrontFilter.limitView;
  const FEED = SELECTORS.feed.feed;
  const MAIN_FEED = SELECTORS.feed.mainFeed;
  const LOADER = SELECTORS.feed.loader;
  const CARD = SELECTORS.feed.cards;
  const BRIDGE_ATTRIBUTE = "data-frontfilter-feed-bridge";
  const REQUEST_ATTRIBUTE = "data-frontfilter-load-request";
  const ERROR_ATTRIBUTE = "data-frontfilter-load-error";
  const READY_EVENT = "frontfilter-feed-bridge-ready";
  const REQUEST_EVENT = "frontfilter-feed-load-request";
  const ERROR_EVENT = "frontfilter-feed-load-error";
  const RELEASE_EVENT = "frontfilter-feed-load-release";
  // Changes to these attributes can alter a card's classification.
  const ATTRIBUTES = [
    "id", "post-id", "permalink", "src", "loading", "class", "href", "data-testid",
    ...SELECTORS.post.subredditAttributes,
    SELECTORS.post.crosspostSourceAttribute,
    ...SELECTORS.post.promotedAttributes,
    ...SELECTORS.post.titleAttributes,
    ...SELECTORS.post.bodyAttributes,
    ...SELECTORS.post.authorAttributes,
    SELECTORS.post.recommendationAttribute,
    ...SELECTORS.nsfw.postAttributes,
    ...SELECTORS.spoilers.postAttributes,
  ];
  // While a session limits a feed, it reads each card once and again after
  // the card's attributes or text change, and sees Home's tabs switch the
  // feed. Otherwise only added and removed elements matter: feeds, loaders
  // and cards.
  const SESSION_CHANGES = {
    childList: true, subtree: true, attributes: true, characterData: true,
    attributeFilter: [...ATTRIBUTES, SELECTORS.feedTabs.selectedAttribute],
  };
  const STRUCTURE_CHANGES = { childList: true, subtree: true };
  const GATE_ATTRIBUTE = "data-frontfilter-feed-gate";
  const PAUSE_ATTRIBUTE = "data-frontfilter-feed-paused";
  // Reddit loads the next page whenever its loader is within two screens of
  // the viewport. When filters hide whole pages the loader never moves, so
  // Reddit would keep fetching invisible pages. Loading stops after this
  // many pages without a newly visible post, with or without a limit.
  const EMPTY_PAGE_LIMIT = 3;
  // How long a page may take to load, or its cards to be identified.
  const LOAD_TIMEOUT = 10000;
  // How long an empty feed may take to render its first cards.
  const SETTLE_DELAY = 500;
  const RETRY_DELAY = 100;
  // The next page loads once the end of the posts shown is this near the
  // bottom of the window, in pixels.
  const LOAD_MARGIN = 200;
  let ready = false;
  let loadsHeld = false;
  let session = null;
  let guard = null;
  let bridgeReady = false;
  // Whether the bridge was waited for in vain: Reddit then loads by itself.
  let bridgeMissing = false;
  let navigation = null;
  let requestSequence = 0;
  // Whether Reddit's cards went without an identity for too long, and the
  // names the limit then gives those that have none.
  let lenient = false;
  const unnamedCards = new WeakMap();
  let unnamedSequence = 0;
  // Only changes in the feed being limited or guarded matter, until it is
  // gone or the page has moved on.
  const observer = new MutationObserver((mutations) => {
    const changes = mutations.filter((mutation) => !POSTS.isUnreadTextChange(mutation));
    if (session) changes.forEach(({ target }) => forgetCard(session.cards, target));
    const watched = session || guard;
    if (watched && watched.key === key() && watched.feed.isConnected
      && !changes.some(({ target }) => watched.feed.contains(target))) return;
    update();
  });

  function enabled() {
    return FrontFilter.isFeedPath(window.location.pathname)
      && (!ready || Boolean(getSettings().limitInfiniteScroll));
  }

  function updateGate() {
    const gated = enabled();
    document.documentElement?.toggleAttribute(GATE_ATTRIBUTE, gated);
    // Loads the gate held back go ahead once, as it opens.
    if (loadsHeld && !gated) document.dispatchEvent(new Event(RELEASE_EVENT));
    loadsHeld = gated;
  }

  function detectBridge() {
    bridgeReady = Boolean(document.documentElement?.hasAttribute(BRIDGE_ATTRIBUTE));
    if (bridgeReady) bridgeMissing = false;
  }

  function key() {
    const url = new URL(window.location.href);
    // Tracking parameters and anchors don't identify a different feed.
    const params = new URLSearchParams();
    for (const name of ["sort", "t", "f", "feed", "q"]) {
      if (url.searchParams.has(name)) params.set(name, url.searchParams.get(name));
    }
    // Home's tabs switch its feed at the same address (feed-tabs.js).
    const tab = FrontFilter.feedTabs.selected();
    return `${url.origin}${url.pathname.replace(/\/$/, "")}?${params}${tab ? `#${tab}` : ""}`;
  }

  // A session limits a feed with the settings it started with.
  function signature(config) {
    return `${config.scrollLimit}:${config.scrollMode}`;
  }

  function findFeed() {
    return document.querySelector(MAIN_FEED) || document.querySelector(FEED);
  }

  // The loader of the feed's next page, which Reddit replaces with that
  // page and the loader of the one after.
  function lastLoader(feed) {
    return Array.from(feed.querySelectorAll(LOADER))
      .filter((element) => element.closest(FEED) === feed).at(-1) || null;
  }

  // A card's identity: its post ID and subreddit, and whether it is an ad.
  function identifyCard(post) {
    const permalink = post.getAttribute("permalink")
      || post.querySelector(SELECTORS.post.permalink)?.getAttribute("href");
    const url = FrontFilter.getRedditUrl(permalink, window.location.origin);
    const path = url && FrontFilter.getSubredditPath(url.pathname);
    const permalinkId = path?.rest.match(/^comments\/([a-z0-9]+)/i)?.[1];
    const id = [post.getAttribute("id"), post.getAttribute("post-id")]
      .find((value) => /^t3_[a-z0-9]+$/i.test(value || ""))?.toLowerCase()
      || (permalinkId ? `t3_${permalinkId.toLowerCase()}` : "");
    const [subreddit = path?.name || ""] = POSTS.subreddits(post);
    return { id, subreddit, ad: POSTS.isAd(post) };
  }

  // Reads a card as the page filters do (posts.js), plus its identity.
  function readCard(post) {
    return {
      ...identifyCard(post),
      crosspostedFrom: POSTS.crosspostedFrom(post),
      title: POSTS.title(post),
      bodyTexts: POSTS.bodyTexts(post),
      recommended: POSTS.isRecommended(post),
      nsfw: POSTS.isNsfw(post),
      spoiler: POSTS.isSpoiler(post),
      flair: POSTS.flair(post),
      author: POSTS.author(post),
    };
  }

  // The feed's cards in order, each read by read. With a cache, cards read
  // before are reused.
  function collect(feed, { cards = null, read = readCard } = {}) {
    const rows = [];
    for (const post of feed.querySelectorAll(CARD)) {
      if (post.closest(FEED) !== feed || post.parentElement?.closest(CARD)) continue;
      const article = post.closest("article");
      const element = article && feed.contains(article) ? article : post;
      const card = cards?.get(post) || read(post);
      cards?.set(post, card);
      rows.push({ post, element, ...card });
    }
    return rows;
  }

  // Whether Reddit has not said yet which post a card shows.
  function isUnidentified(card) {
    return !card.ad && (!card.id || !card.subreddit);
  }

  // Names the cards Reddit gave no ID, each as a post of its own, once the
  // limit has stopped waiting for their identity. A name stays with its
  // card, so a card named late is not counted twice.
  function nameUnidentified(rows) {
    for (const row of rows) {
      if (row.ad) continue;
      if (!row.id && !unnamedCards.has(row.post)) {
        unnamedCards.set(row.post, `unnamed_${++unnamedSequence}`);
      }
      row.id = unnamedCards.get(row.post) || row.id;
    }
  }

  // Forgets the cards a change happened in, so they are read again.
  function forgetCard(cards, target) {
    for (const card of POSTS.enclosing(target, CARD)) cards.delete(card);
  }

  function render(current, rows) {
    const state = current.window.snapshot();
    const seen = new Set();
    let lastVisible = -1;
    rows.forEach((row, index) => {
      if (!row.ad && state.allowed.has(row.id) && !seen.has(row.id)) lastVisible = index;
      if (!row.ad && row.id) seen.add(row.id);
    });
    seen.clear();
    rows.forEach((row, index) => {
      const show = row.ad ? index < lastVisible
        : state.allowed.has(row.id) && !seen.has(row.id);
      if (!row.ad && row.id) seen.add(row.id);
      VIEW.setVisible(row.post, show);
      VIEW.setVisible(row.element, show);
      const divider = row.element.nextElementSibling;
      if (divider?.matches("hr")) VIEW.setVisible(divider, show);
    });
    // Clearing stale markers must not reveal newly inserted, unclassified
    // cards: the gate's CSS keeps those hidden.
    const marked = new Set(rows.flatMap(({ element, post }) => [element, post, element.nextElementSibling]));
    if (bridgeMissing) marked.add(lastLoader(current.feed));
    VIEW.clearMarkers(current.feed, marked);
  }

  function renderControls(current) {
    const state = current.window.snapshot();
    const { status, button, retry } = current;
    let message;
    let label = `Show next ${getSettings().scrollLimit}`;
    if (current.error) {
      message = current.error;
    } else if (state.pending) {
      message = `${state.allowed.size} / ${state.target} posts`;
      if (current.loading) message += " · Loading…";
    } else if (state.ended && state.available <= state.allowed.size) {
      message = `End of feed · ${state.allowed.size} posts shown`;
    } else {
      message = `${state.allowed.size} posts shown`;
      if (getSettings().scrollMode === "fixed") message += " · Limit reached";
      if (state.ended) label = `Show remaining ${state.available - state.allowed.size}`;
    }
    if (status.textContent !== message) status.textContent = message;
    if (button.textContent !== label) button.textContent = label;
    button.hidden = !state.canAdvance || !!current.error;
    button.disabled = !state.canAdvance;
    retry.hidden = !current.error;
    // Keep the control outside the feed's rendering ownership.
    if (current.feed.nextElementSibling !== current.controls) {
      current.feed.after(current.controls);
    }
  }

  function active(current) {
    return session === current && enabled() && current.key === key() && current.feed.isConnected;
  }

  function stopSession() {
    if (!session) return;
    clearTimeout(session.timer);
    session.cancelLoading?.();
    session.intersection.disconnect();
    session.controls.remove();
    VIEW.clearMarkers(session.feed);
    session = null;
    observer.observe(document, STRUCTURE_CHANGES);
  }

  function startSession(feed) {
    const config = getSettings();
    const { controls, status } = VIEW.createControls();
    const button = VIEW.createButton({ className: "frontfilter-feed-next", hidden: true });
    const retry = VIEW.createButton({ className: "frontfilter-feed-retry", text: "Retry", hidden: true });
    // Fixed mode has no expansion control, regardless of the host page's CSS.
    if (config.scrollMode === "button") controls.append(button);
    controls.append(retry);
    const current = {
      feed, controls, status, button, retry, key: key(),
      signature: signature(config),
      window: FrontFilter.createFeedWindow(config.scrollLimit, config.scrollMode),
      timer: null, loading: null, cancelLoading: null,
      error: "", pages: 0, consumed: new Set(),
      waitingSince: Date.now(), cards: new WeakMap(),
      // Without the bridge: the loader Reddit may load by itself, and the
      // address of the last page it was let to.
      nativeLoader: null, nativeCursor: "",
    };
    observer.observe(document, SESSION_CHANGES);
    button.addEventListener("click", () => {
      if (!active(current) || button.disabled) return;
      if (!current.window.next()) return;
      current.pages = 0;
      update();
    });
    retry.addEventListener("click", () => {
      if (!active(current) || !current.error) return;
      current.error = "";
      current.pages = 0;
      current.waitingSince = Date.now();
      const loader = lastLoader(current.feed);
      if (loader) current.consumed.delete(loader.getAttribute("src"));
      update();
    });
    current.intersection = new IntersectionObserver(() => {
      if (active(current)) update();
    }, { rootMargin: `0px 0px ${LOAD_MARGIN}px 0px` });
    current.intersection.observe(controls);
    return current;
  }

  function later(current, delay = RETRY_DELAY) {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => { if (active(current)) update(); }, delay);
  }

  // Checks again shortly, or gives up once the wait has lasted too long.
  function waitOrFail(current, error) {
    if (Date.now() - current.waitingSince > LOAD_TIMEOUT) current.error = error;
    else later(current);
  }

  // Loads the feed's next page while the limit wants more posts and the
  // reader is near the end of those shown.
  function continueFeed(current, rows) {
    if (current.loading || current.error || !current.window.snapshot().pending) return;
    // Only fetch when the reader approaches the currently visible results.
    // Re-evaluate geometry after rendering every response, not just when the
    // observer changes state: filtered-only pages may leave the boundary still.
    const bounds = current.controls.getBoundingClientRect();
    if (document.visibilityState === "hidden" || bounds.top > window.innerHeight + LOAD_MARGIN
      || bounds.bottom < 0) return;
    if (!lenient && rows.some(isUnidentified)) {
      // Cards may get their identity late. Should Reddit give none, as
      // after a change of its markup, the limit counts them as they are.
      if (Date.now() - current.waitingSince > LOAD_TIMEOUT) {
        lenient = true;
        console.warn("FrontFilter could not identify Reddit's posts: its scroll limit counts them as shown.");
      }
      later(current);
      return;
    }
    const loader = lastLoader(current.feed);
    if (!loader) {
      // Wait for the initial render / final continuation to settle.
      if (document.readyState === "loading" || Date.now() - current.waitingSince < SETTLE_DELAY) {
        later(current);
      } else if (rows.length) {
        current.window.end();
      } else {
        current.error = "No feed results are available. Retry loading.";
      }
      return;
    }
    const cursor = loader.getAttribute("src");
    if (!cursor) {
      waitOrFail(current, "This feed could not load more posts. Retry loading.");
      return;
    }
    if (!bridgeReady) {
      // The bridge installs once Reddit defines its loader.
      if (!bridgeMissing && Date.now() - current.waitingSince <= LOAD_TIMEOUT) {
        later(current);
        return;
      }
      if (!bridgeMissing) {
        bridgeMissing = true;
        console.warn("FrontFilter could not reach Reddit's feed loader: Reddit loads the feed by itself.");
      }
      loadNatively(current, loader, cursor);
      return;
    }
    if (current.consumed.has(cursor)) {
      current.error = "Reddit did not advance the feed. Retry loading.";
      return;
    }
    if (current.pages >= EMPTY_PAGE_LIMIT) {
      current.error = "No matching posts found in the last pages. Retry to continue.";
      return;
    }
    requestPage(current, loader, cursor);
  }

  // Without the bridge, the limit cannot ask for the next page: Reddit
  // loads it by itself while its loader shows near the window. The loader
  // then shows only while the limit wants more posts, and each loader shown
  // counts as a page.
  function loadNatively(current, loader, cursor) {
    if (current.nativeCursor !== cursor) {
      if (current.pages >= EMPTY_PAGE_LIMIT) {
        current.error = "No matching posts found in the last pages. Retry to continue.";
        return;
      }
      current.nativeCursor = cursor;
      current.pages += 1;
    }
    current.nativeLoader = loader;
  }

  // Shows Reddit's loader while the limit lets Reddit load by itself, and
  // hides it otherwise.
  function showNativeLoader(current) {
    if (!bridgeMissing) return;
    const loader = lastLoader(current.feed);
    if (loader) VIEW.setVisible(loader, loader === current.nativeLoader);
  }

  // Has the page load the feed's next page (feed-bridge.js), and updates
  // the feed once Reddit has moved its loader on, or could not.
  function requestPage(current, loader, cursor) {
    current.pages += 1;
    current.loading = loader;
    current.waitingSince = Date.now();
    const requestToken = `${Date.now()}-${++requestSequence}`;
    let settled = false;

    // The outcome is "loaded", "failed" or "cancelled".
    function finish(outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(current.timer);
      loader.removeEventListener(ERROR_EVENT, onLoadError);
      for (const attribute of [REQUEST_ATTRIBUTE, ERROR_ATTRIBUTE]) {
        if (loader.getAttribute(attribute) === requestToken) loader.removeAttribute(attribute);
      }
      current.loading = null;
      current.cancelLoading = null;
      if (outcome === "cancelled" || !active(current)) return;
      if (outcome === "failed") current.error = "Could not load the next group. Retry loading.";
      else current.consumed.add(cursor);
      current.waitingSince = Date.now();
      update();
    }

    function onLoadError() {
      if (loader.getAttribute(ERROR_ATTRIBUTE) === requestToken) finish("failed");
    }

    // Native implementations may return void. DOM/cursor progress is required
    // even when the page-world promise resolves without delivering results.
    function waitForDOM() {
      if (settled) return;
      if (!active(current)) {
        finish("cancelled");
        return;
      }
      const changed = !loader.isConnected
        || loader.getAttribute("src") !== cursor
        || lastLoader(current.feed) !== loader;
      if (changed) finish("loaded");
      else if (Date.now() - current.waitingSince > LOAD_TIMEOUT) finish("failed");
      else current.timer = setTimeout(waitForDOM, RETRY_DELAY);
    }

    current.cancelLoading = () => finish("cancelled");
    loader.addEventListener(ERROR_EVENT, onLoadError);
    loader.setAttribute(REQUEST_ATTRIBUTE, requestToken);
    loader.dispatchEvent(new Event(REQUEST_EVENT, { bubbles: true, composed: true }));
    waitForDOM();
  }

  function isShown(element) {
    return element.checkVisibility
      ? element.checkVisibility()
      : element.getClientRects().length > 0;
  }

  function stopGuard() {
    if (!guard) return;
    clearTimeout(guard.timer);
    guard.feed.removeAttribute(PAUSE_ATTRIBUTE);
    guard.controls?.remove();
    guard = null;
  }

  // Identities outlive recycled cards, so removed posts are not re-counted.
  // Only identities matter here: filters have hidden the posts they match.
  function countNewVisiblePosts(current) {
    let added = 0;
    for (const row of collect(current.feed, { read: identifyCard })) {
      const identity = row.id || row.post;
      if (row.ad || current.seen.has(identity) || !isShown(row.post)) continue;
      current.seen.add(identity);
      added += 1;
    }
    return added;
  }

  function pauseGuard(current) {
    current.paused = true;
    current.feed.setAttribute(PAUSE_ATTRIBUTE, "");
    if (!current.controls) {
      const { controls, status } = VIEW.createControls("frontfilter-feed-paused");
      status.textContent = `The last ${EMPTY_PAGE_LIMIT} pages had no posts left after filtering.`;
      const button = VIEW.createButton({ text: "Load more" });
      button.addEventListener("click", () => {
        if (guard === current) resumeGuard(current);
      });
      controls.append(button);
      current.controls = controls;
    }
    current.feed.after(current.controls);
  }

  function resumeGuard(current) {
    current.paused = false;
    current.emptyPages = 0;
    current.feed.removeAttribute(PAUSE_ATTRIBUTE);
    current.controls?.remove();
  }

  function evaluateGuard(current) {
    if (guard !== current || !current.feed.isConnected) return;
    const added = countNewVisiblePosts(current);
    if (current.paused) {
      // A settings change can reveal posts that filters were hiding.
      if (added > 0) resumeGuard(current);
      return;
    }
    current.emptyPages = added > 0 ? 0 : current.emptyPages + 1;
    if (current.emptyPages >= EMPTY_PAGE_LIMIT) pauseGuard(current);
  }

  function guardNativeFeed() {
    const feed = FrontFilter.isFeedPath(window.location.pathname) ? findFeed() : null;
    if (guard && (guard.feed !== feed || guard.key !== key())) stopGuard();
    if (!feed) return;
    if (!guard) {
      guard = {
        feed, key: key(), loader: undefined, seen: new Set(),
        emptyPages: 0, paused: false, timer: null, controls: null,
      };
    }
    const current = guard;
    const loader = lastLoader(feed);
    // Each new loader marks a completed page. While paused, re-check on any
    // update so settings changes can resume loading.
    if (loader === current.loader && !current.paused) return;
    current.loader = loader;
    clearTimeout(current.timer);
    // Page filters classify new cards on the next frame; measure afterwards.
    current.timer = setTimeout(() => evaluateGuard(current), RETRY_DELAY);
  }

  // The feed's cards, as they show the feed of a key.
  function recordFeed(feed, from) {
    navigation = { feed, from, rows: collect(feed, { read: identifyCard }) };
  }

  // Whether the feed still shows the cards of the page before this one.
  // The URL can change before Reddit replaces or repopulates the old feed,
  // whose cards must not seed the results of the new page; so can Home's
  // tabs.
  function awaitsNavigation(feed) {
    if (session && session.key !== key() && session.feed === feed) {
      recordFeed(feed, session.key);
      stopSession();
    }
    if (!navigation) return false;
    const rows = feed ? collect(feed, { read: identifyCard }) : [];
    const unchanged = key() !== navigation.from
      && feed === navigation.feed && rows.length === navigation.rows.length
      && rows.every((row, index) => row.post === navigation.rows[index].post
        && row.id === navigation.rows[index].id);
    if (!unchanged) navigation = null;
    return unchanged;
  }

  // Gives the session's window the cards identified so far, in feed order.
  function admit(current, rows) {
    const records = new Map();
    for (const { post, element, ...record } of rows) {
      // A partially hydrated card may precede complete cards. Wait for its
      // identity before admitting later results, preserving feed order.
      if (!lenient && isUnidentified(record)) break;
      // A promoted copy must not override the organic card with the same ID.
      if (record.id && (!records.has(record.id) || !record.ad)) records.set(record.id, record);
    }
    const visibleBefore = current.window.snapshot().allowed.size;
    const state = current.window.update(
      records.values(),
      (record) => !record.ad && (lenient || Boolean(record.subreddit)) && !isBlocked(record),
    );
    if (state.allowed.size > visibleBefore) current.pages = 0;
    if (!state.pending) current.error = "";
  }

  function update() {
    updateGate();
    detectBridge();
    if (!ready) return;
    if (!enabled()) {
      navigation = null;
      stopSession();
      guardNativeFeed();
      return;
    }
    stopGuard();
    const feed = findFeed();
    if (awaitsNavigation(feed)) return;
    // Following is about to replace For You, whose posts stay until Reddit
    // has replaced them: they must not seed the limit's results either.
    if (feed && FrontFilter.feedTabs.opensFollowing(getSettings())) {
      stopSession();
      recordFeed(feed, key());
      return;
    }
    if (session && (session.feed !== feed || session.key !== key()
      || session.signature !== signature(getSettings()))) stopSession();
    if (!feed) return;
    session ??= startSession(feed);
    const current = session;
    const rows = collect(feed, { cards: current.cards });
    if (lenient) nameUnidentified(rows);
    admit(current, rows);
    render(current, rows);
    // The controls mark the end of the visible posts, where continueFeed
    // measures how close the reader is; loading then changes what they say.
    renderControls(current);
    current.nativeLoader = null;
    continueFeed(current, rows);
    showNativeLoader(current);
    renderControls(current);
  }

  updateGate();
  detectBridge();
  document.addEventListener(READY_EVENT, update);
  observer.observe(document, STRUCTURE_CHANGES);
  document.addEventListener("visibilitychange", update);
  // Settings apply once loaded: until then, the gate keeps feeds hidden.
  return {
    update() {
      ready = true;
      update();
    },
  };
};
