/**
 * Modern Reddit feed adapter. Uses the page's own continuation component so
 * sorting, credentials and personalized feed cursors stay owned by Reddit.
 */
FrontFilter.createFeedLimiter = function ({ getSettings, isBlocked }) {
  const SELECTORS = FrontFilter.SELECTORS;
  const POSTS = FrontFilter.posts;
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
    ...SELECTORS.post.promotedAttributes,
    ...SELECTORS.post.titleAttributes,
    ...SELECTORS.post.bodyAttributes,
    SELECTORS.post.recommendationAttribute,
  ];
  // While a session limits a feed, it reads each card once and again after
  // the card's attributes or text change. Otherwise only added and removed
  // elements matter: feeds, loaders and cards.
  const SESSION_CHANGES = {
    childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ATTRIBUTES,
  };
  const STRUCTURE_CHANGES = { childList: true, subtree: true };
  const GATE_ATTRIBUTE = "data-frontfilter-feed-gate";
  const VISIBLE_ATTRIBUTE = "data-frontfilter-limit-visible";
  const HIDDEN_ATTRIBUTE = "data-frontfilter-limit-hidden";
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
  let ready = false;
  let loadsHeld = false;
  let session = null;
  let guard = null;
  let bridgeReady = false;
  let navigation = null;
  let requestSequence = 0;

  function enabled() {
    return FrontFilter.isFeedPath(window.location.pathname)
      && (!ready || getSettings().limitInfiniteScroll);
  }

  function setAttribute(element, name, active) {
    if (active) {
      if (!element.hasAttribute(name)) element.setAttribute(name, "");
    } else if (element.hasAttribute(name)) element.removeAttribute(name);
  }

  function updateGate() {
    const gated = enabled();
    if (document.documentElement) setAttribute(document.documentElement, GATE_ATTRIBUTE, gated);
    // Loads the gate held back go ahead once, as it opens.
    if (loadsHeld && !gated) document.dispatchEvent(new Event(RELEASE_EVENT));
    loadsHeld = gated;
  }

  function detectBridge() {
    bridgeReady = !!document.documentElement?.hasAttribute(BRIDGE_ATTRIBUTE);
  }

  function key() {
    const url = new URL(window.location.href);
    // Tracking parameters and anchors don't identify a different feed.
    const params = new URLSearchParams();
    for (const name of ["sort", "t", "f", "feed", "q"]) {
      if (url.searchParams.has(name)) params.set(name, url.searchParams.get(name));
    }
    return `${url.origin}${url.pathname.replace(/\/$/, "")}?${params}`;
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
      title: POSTS.title(post),
      bodyTexts: POSTS.bodyTexts(post),
      recommended: POSTS.isRecommended(post),
      flair: POSTS.flair(post),
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

  // Forgets the cards a change happened in, so they are read again.
  function forgetCard(cards, target) {
    const element = target.closest ? target : target.parentElement;
    let card = element?.closest(CARD);
    while (card) {
      cards.delete(card);
      card = card.parentElement?.closest(CARD);
    }
  }

  function setVisible(element, value) {
    setAttribute(element, VISIBLE_ATTRIBUTE, value);
    setAttribute(element, HIDDEN_ATTRIBUTE, !value);
  }

  // Removes the markers from a feed's elements, except those to keep.
  function clearMarkers(feed, keep = new Set()) {
    for (const element of feed.querySelectorAll(`[${VISIBLE_ATTRIBUTE}], [${HIDDEN_ATTRIBUTE}]`)) {
      if (keep.has(element)) continue;
      element.removeAttribute(VISIBLE_ATTRIBUTE);
      element.removeAttribute(HIDDEN_ATTRIBUTE);
    }
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
      setVisible(row.post, show);
      setVisible(row.element, show);
      const divider = row.element.nextElementSibling;
      if (divider?.matches("hr")) setVisible(divider, show);
    });
    // Clearing stale markers must not reveal newly inserted, unclassified
    // cards: the gate's CSS keeps those hidden.
    clearMarkers(current.feed, new Set(
      rows.flatMap(({ element, post }) => [element, post, element.nextElementSibling]),
    ));
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
    clearMarkers(session.feed);
    session = null;
    observer.observe(document, STRUCTURE_CHANGES);
  }

  function startSession(feed) {
    const config = getSettings();
    const controls = document.createElement("div");
    controls.className = "frontfilter-feed-controls";
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "frontfilter-feed-next";
    button.hidden = true;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "frontfilter-feed-retry";
    retry.textContent = "Retry";
    retry.hidden = true;
    controls.append(status);
    // Fixed mode has no expansion control, regardless of the host page's CSS.
    if (config.scrollMode === "button") controls.append(button);
    controls.append(retry);
    const current = {
      feed, controls, status, button, retry, key: key(),
      signature: `${config.scrollLimit}:${config.scrollMode}`,
      window: FrontFilter.createFeedWindow(config.scrollLimit, config.scrollMode),
      timer: null, loading: null, cancelLoading: null,
      error: "", pages: 0, consumed: new Set(),
      waitingSince: Date.now(), cards: new WeakMap(),
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
      const loader = Array.from(current.feed.querySelectorAll(LOADER)).at(-1);
      if (loader) current.consumed.delete(loader.getAttribute("src"));
      update();
    });
    current.intersection = new IntersectionObserver(() => {
      if (active(current)) update();
    }, { rootMargin: "0px 0px 200px 0px" });
    current.intersection.observe(controls);
    return current;
  }

  function later(current, delay = RETRY_DELAY) {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => { if (active(current)) update(); }, delay);
  }

  function continueFeed(current, rows) {
    if (current.loading || current.error || !current.window.snapshot().pending) return;
    // Only fetch when the reader approaches the currently visible results.
    // Re-evaluate geometry after rendering every response, not just when the
    // observer changes state: filtered-only pages may leave the boundary still.
    const bounds = current.controls.getBoundingClientRect();
    if (document.visibilityState === "hidden" || bounds.top > window.innerHeight + 200
      || bounds.bottom < 0) return;
    if (rows.some((row) => !row.ad && (!row.id || !row.subreddit))) {
      if (Date.now() - current.waitingSince > LOAD_TIMEOUT) {
        current.error = "Some posts could not be identified. Retry loading.";
      } else later(current);
      return;
    }
    const loaders = Array.from(current.feed.querySelectorAll(LOADER))
      .filter((element) => element.closest(FEED) === current.feed);
    const loader = loaders.at(-1);
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
    if (!bridgeReady || !cursor) {
      if (Date.now() - current.waitingSince > LOAD_TIMEOUT) {
        current.error = "This feed could not load more posts. Retry loading.";
      } else later(current);
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
    current.pages += 1;
    current.loading = loader;
    current.waitingSince = Date.now();
    const requestToken = `${Date.now()}-${++requestSequence}`;
    let settled = false;
    const finish = (error, cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(current.timer);
      loader.removeEventListener(ERROR_EVENT, onLoadError);
      if (loader.getAttribute(REQUEST_ATTRIBUTE) === requestToken) {
        loader.removeAttribute(REQUEST_ATTRIBUTE);
      }
      if (loader.getAttribute(ERROR_ATTRIBUTE) === requestToken) {
        loader.removeAttribute(ERROR_ATTRIBUTE);
      }
      current.loading = null;
      current.cancelLoading = null;
      if (cancelled || !active(current)) return;
      if (error) current.error = "Could not load the next group. Retry loading.";
      else current.consumed.add(cursor);
      current.waitingSince = Date.now();
      update();
    };
    const onLoadError = () => {
      if (loader.getAttribute(ERROR_ATTRIBUTE) === requestToken) {
        finish(new Error("native loader rejected"));
      }
    };
    const waitForDOM = () => {
      if (settled) return;
      if (!active(current)) {
        finish(null, true);
        return;
      }
      const changed = !loader.isConnected
        || loader.getAttribute("src") !== cursor
        || Array.from(current.feed.querySelectorAll(LOADER)).at(-1) !== loader;
      if (changed) finish();
      else if (Date.now() - current.waitingSince > LOAD_TIMEOUT) finish(new Error("timeout"));
      else current.timer = setTimeout(waitForDOM, RETRY_DELAY);
    };
    current.cancelLoading = () => finish(null, true);
    loader.addEventListener(ERROR_EVENT, onLoadError);
    loader.setAttribute(REQUEST_ATTRIBUTE, requestToken);
    loader.dispatchEvent(new Event(REQUEST_EVENT, { bubbles: true, composed: true }));
    // Native implementations may return void. DOM/cursor progress is required
    // even when the page-world promise resolves without delivering results.
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
      const controls = document.createElement("div");
      controls.className = "frontfilter-feed-controls frontfilter-feed-paused";
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      status.textContent = `The last ${EMPTY_PAGE_LIMIT} pages had no posts left after filtering.`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Load more";
      button.addEventListener("click", () => {
        if (guard === current) resumeGuard(current);
      });
      controls.append(status, button);
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
    const feed = FrontFilter.isFeedPath(window.location.pathname)
      ? document.querySelector(MAIN_FEED) || document.querySelector(FEED)
      : null;
    if (guard && (guard.feed !== feed || guard.key !== key())) stopGuard();
    if (!feed) return;
    if (!guard) {
      guard = {
        feed, key: key(), loader: undefined, seen: new Set(),
        emptyPages: 0, paused: false, timer: null, controls: null,
      };
    }
    const current = guard;
    const loader = Array.from(feed.querySelectorAll(LOADER))
      .filter((element) => element.closest(FEED) === feed).at(-1) || null;
    // Each new loader marks a completed page. While paused, re-check on any
    // update so settings changes can resume loading.
    if (loader === current.loader && !current.paused) return;
    current.loader = loader;
    clearTimeout(current.timer);
    // Page filters classify new cards on the next frame; measure afterwards.
    current.timer = setTimeout(() => evaluateGuard(current), RETRY_DELAY);
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
    const feed = document.querySelector(MAIN_FEED) || document.querySelector(FEED);
    const config = getSettings();
    if (session && session.key !== key() && session.feed === feed) {
      // The URL can change before React replaces/repopulates the old feed.
      // Do not seed a new result ledger with cards from the previous route.
      navigation = { feed, rows: collect(feed, { read: identifyCard }) };
      stopSession();
    }
    if (navigation) {
      const rows = feed ? collect(feed, { read: identifyCard }) : [];
      if (feed === navigation.feed && rows.length === navigation.rows.length
        && rows.every((row, index) => row.post === navigation.rows[index].post
          && row.id === navigation.rows[index].id)) return;
      navigation = null;
    }
    if (session && (session.feed !== feed || session.key !== key()
      || session.signature !== `${config.scrollLimit}:${config.scrollMode}`)) stopSession();
    if (!feed) return;
    if (!session) session = startSession(feed);
    const current = session;
    const rows = collect(feed, { cards: current.cards });
    const records = new Map();
    for (const {
      id, subreddit, title, bodyTexts, ad, recommended, flair,
    } of rows) {
      // A partially hydrated card may precede complete cards. Wait for its
      // identity before admitting later results, preserving feed order.
      if (!ad && (!id || !subreddit)) break;
      // A promoted copy must not override the organic card with the same ID.
      if (id && (!records.has(id) || !ad)) {
        records.set(id, {
          id, subreddit, title, bodyTexts, ad, recommended, flair,
        });
      }
    }
    const visibleBefore = current.window.snapshot().allowed.size;
    const state = current.window.update(records.values(), (record) => !record.ad && !!record.subreddit && !isBlocked(record));
    if (state.allowed.size > visibleBefore) current.pages = 0;
    if (!state.pending) current.error = "";
    render(current, rows);
    // The controls mark the end of the visible posts, where continueFeed
    // measures how close the reader is; loading then changes what they say.
    renderControls(current);
    continueFeed(current, rows);
    renderControls(current);
  }

  updateGate();
  detectBridge();
  document.addEventListener(READY_EVENT, () => {
    bridgeReady = true;
    update();
  });
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
