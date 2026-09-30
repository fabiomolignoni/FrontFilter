/**
 * Modern Reddit feed adapter. Uses the page's own continuation component so
 * sorting, credentials and personalized feed cursors stay owned by Reddit.
 */
FrontFilter.createFeedLimiter = function ({ getSettings, isBlocked }) {
  const FEED = "shreddit-feed";
  const LOADER = 'faceplate-partial[slot="load-after"]';
  const CARD = 'shreddit-post, shreddit-ad-post, [data-testid="ad-container"]';
  const BRIDGE_ATTRIBUTE = "data-frontfilter-feed-bridge";
  const REQUEST_ATTRIBUTE = "data-frontfilter-load-request";
  const ERROR_ATTRIBUTE = "data-frontfilter-load-error";
  const READY_EVENT = "frontfilter-feed-bridge-ready";
  const REQUEST_EVENT = "frontfilter-feed-load-request";
  const ERROR_EVENT = "frontfilter-feed-load-error";
  const RELEASE_EVENT = "frontfilter-feed-load-release";
  const ATTRIBUTES = [
    "id", "post-id", "subreddit-name", "subreddit-prefixed-name", "permalink",
    "data-subreddit", "data-subreddit-prefixed", "is-promoted", "promoted",
    "data-promoted", "data-shreddit-promoted",
    "src", "loading", "class", "href", "data-testid", "post-title", "data-title",
    "post-body", "data-post-body",
  ];
  let ready = false;
  let session = null;
  let bridgeReady = false;
  let disposed = false;
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
    if (document.documentElement) {
      setAttribute(document.documentElement, "data-frontfilter-feed-gate", enabled());
    }
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

  function flag(post, names) {
    return names.some((name) => post.hasAttribute(name)
      && !["false", "0"].includes(post.getAttribute(name).toLowerCase()));
  }

  function readCard(post) {
    const permalink = post.getAttribute("permalink")
      || post.querySelector('a[href*="/comments/"]')?.getAttribute("href");
    const url = FrontFilter.getRedditUrl(permalink, window.location.origin);
    const path = url && FrontFilter.getSubredditPath(url.pathname);
    const permalinkId = path?.rest.match(/^comments\/([a-z0-9]+)/i)?.[1];
    const id = [post.getAttribute("id"), post.getAttribute("post-id")]
      .find((value) => /^t3_[a-z0-9]+$/i.test(value || ""))?.toLowerCase()
      || (permalinkId ? `t3_${permalinkId.toLowerCase()}` : "");
    const subreddit = FrontFilter.normalizeSubredditName(
      post.getAttribute("subreddit-name") || post.getAttribute("subreddit-prefixed-name")
      || post.getAttribute("data-subreddit") || post.getAttribute("data-subreddit-prefixed")
      || path?.name,
    );
    const ad = post.matches('shreddit-ad-post, [data-testid="ad-container"]')
      || flag(post, ["is-promoted", "promoted", "data-promoted", "data-shreddit-promoted"])
      || !!post.querySelector('shreddit-ad-post, [data-testid="promoted-label"]');
    const title = post.getAttribute("post-title")?.trim()
      || post.getAttribute("data-title")?.trim()
      || post.querySelector(FrontFilter.POST_SELECTORS.title)?.textContent?.trim()
      || "";
    const bodyTexts = new Set();
    for (const attributeName of ["post-body", "data-post-body"]) {
      const text = post.getAttribute(attributeName)?.trim();
      if (text) bodyTexts.add(text);
    }
    for (const bodyElement of post.querySelectorAll(FrontFilter.POST_SELECTORS.body)) {
      const nestedPost = bodyElement.closest?.(CARD);
      if (nestedPost && nestedPost !== post) continue;
      const text = bodyElement.textContent?.trim();
      if (text) bodyTexts.add(text);
    }
    return { id, subreddit, title, bodyTexts: Array.from(bodyTexts), ad };
  }

  function collect(feed) {
    const rows = [];
    for (const post of feed.querySelectorAll(CARD)) {
      if (post.closest(FEED) !== feed || post.parentElement?.closest(CARD)) continue;
      const article = post.closest("article");
      const element = article && feed.contains(article) ? article : post;
      rows.push({ post, element, ...readCard(post) });
    }
    return rows;
  }

  function setVisible(element, value) {
    setAttribute(element, "data-frontfilter-limit-visible", value);
    setAttribute(element, "data-frontfilter-limit-hidden", !value);
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
    // Clearing stale markers must not reveal newly inserted, unclassified cards.
    const elements = new Set(rows.flatMap(({ element, post }) => [element, post, element.nextElementSibling]));
    current.feed.querySelectorAll("[data-frontfilter-limit-visible], [data-frontfilter-limit-hidden]")
      .forEach((element) => {
        if (!elements.has(element)) {
          element.removeAttribute("data-frontfilter-limit-visible");
          element.removeAttribute("data-frontfilter-limit-hidden");
        }
      });
    renderControls(current);
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
    session.feed.querySelectorAll("[data-frontfilter-limit-hidden], [data-frontfilter-limit-visible]")
      .forEach((element) => {
        element.removeAttribute("data-frontfilter-limit-hidden");
        element.removeAttribute("data-frontfilter-limit-visible");
      });
    session = null;
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
      waitingSince: Date.now(),
    };
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

  function later(current, delay = 100) {
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
      if (Date.now() - current.waitingSince > 10000) {
        current.error = "Some posts could not be identified. Retry loading.";
      } else later(current);
      return;
    }
    const loaders = Array.from(current.feed.querySelectorAll(LOADER))
      .filter((element) => element.closest(FEED) === current.feed);
    const loader = loaders.at(-1);
    if (!loader) {
      // Wait for the initial render / final continuation to settle.
      if (document.readyState === "loading" || Date.now() - current.waitingSince < 500) {
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
      if (Date.now() - current.waitingSince > 10000) {
        current.error = "This feed could not load more posts. Retry loading.";
      } else later(current);
      return;
    }
    if (current.consumed.has(cursor)) {
      current.error = "Reddit did not advance the feed. Retry loading.";
      return;
    }
    if (current.pages >= 3) {
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
      else if (Date.now() - current.waitingSince > 10000) finish(new Error("timeout"));
      else current.timer = setTimeout(waitForDOM, 100);
    };
    current.cancelLoading = () => finish(null, true);
    loader.addEventListener(ERROR_EVENT, onLoadError);
    loader.setAttribute(REQUEST_ATTRIBUTE, requestToken);
    loader.dispatchEvent(new Event(REQUEST_EVENT, { bubbles: true, composed: true }));
    // Native implementations may return void. DOM/cursor progress is required
    // even when the page-world promise resolves without delivering results.
    waitForDOM();
  }

  function update() {
    if (disposed) return;
    updateGate();
    detectBridge();
    if (!ready) return;
    if (!enabled()) {
      navigation = null;
      stopSession();
      document.dispatchEvent(new Event(RELEASE_EVENT));
      return;
    }
    const feed = document.querySelector(`main ${FEED}`) || document.querySelector(FEED);
    const config = getSettings();
    if (session && session.key !== key() && session.feed === feed) {
      // The URL can change before React replaces/repopulates the old feed.
      // Do not seed a new result ledger with cards from the previous route.
      navigation = { feed, rows: collect(feed) };
      stopSession();
    }
    if (navigation) {
      const rows = feed ? collect(feed) : [];
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
    const rows = collect(feed);
    const records = new Map();
    for (const { id, subreddit, title, bodyTexts, ad } of rows) {
      // A partially hydrated card may precede complete cards. Wait for its
      // identity before admitting later results, preserving feed order.
      if (!ad && (!id || !subreddit)) break;
      // A promoted copy must not override the organic card with the same ID.
      if (id && (!records.has(id) || !ad)) {
        records.set(id, { id, subreddit, title, bodyTexts, ad });
      }
    }
    const visibleBefore = current.window.snapshot().allowed.size;
    const state = current.window.update(records.values(), (record) => !record.ad && !!record.subreddit && !isBlocked(record));
    if (state.allowed.size > visibleBefore) current.pages = 0;
    if (!state.pending) current.error = "";
    render(current, rows);
    continueFeed(current, rows);
    renderControls(current);
  }

  updateGate();
  detectBridge();
  const onBridgeReady = () => {
    bridgeReady = true;
    if (!disposed) update();
  };
  document.addEventListener(READY_EVENT, onBridgeReady);
  const observer = new MutationObserver((mutations) => {
    if (!session || session.key !== key() || !session.feed.isConnected
      || mutations.some(({ target }) => session.feed.contains(target))) update();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    attributeFilter: ATTRIBUTES,
  });
  document.addEventListener("visibilitychange", update);
  return {
    update() { ready = true; update(); },
    destroy() {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      document.removeEventListener(READY_EVENT, onBridgeReady);
      stopSession();
      document.documentElement?.removeAttribute("data-frontfilter-feed-gate");
      document.dispatchEvent(new Event(RELEASE_EVENT));
    },
  };
};
