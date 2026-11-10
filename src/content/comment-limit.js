/**
 * Comment limit for modern Reddit: a post's page shows as many of its
 * top-level comments as the limit, each with its replies, and then stops,
 * or shows the next group on request. Reddit brings more top-level
 * comments through a loader at the end of the comment tree, by itself as
 * the reader scrolls near it, later from a button in it. While the limit
 * holds comments back, it hides that loader, so Reddit brings no more until
 * they are wanted; a next group that lacks comments has the page load them
 * (feed-bridge.js), as that button would. Comments that filters hide do not
 * count: they are read as page filters read them (posts.js).
 */
FrontFilter.createCommentLimiter = function ({ getSettings, isBlocked }) {
  const COMMENT = FrontFilter.SELECTORS.comment;
  const POSTS = FrontFilter.posts;
  // The comment tree being limited. In it, top-level comments, ad slots
  // and loaders stay hidden until marked visible (feed-limit.css), so none
  // shows before the limit has counted it.
  const LIMIT_ATTRIBUTE = "data-frontfilter-comment-limit";
  const VISIBLE_ATTRIBUTE = "data-frontfilter-limit-visible";
  const HIDDEN_ATTRIBUTE = "data-frontfilter-limit-hidden";
  const LOAD_EVENT = "frontfilter-comments-load-request";
  // What the limit shows or hides, when it is outside every comment.
  const PARTS = [COMMENT.modern, COMMENT.treeAds, COMMENT.moreComments].join(", ");
  // Comments are added, removed and edited, and their authors can be named
  // after they are added.
  const CHANGES = {
    childList: true, subtree: true, attributes: true, characterData: true,
    attributeFilter: [COMMENT.authorAttribute],
  };
  let ready = false;
  let observing = false;
  let limitedTree = null;
  let session = null;

  // Until settings load, comment pages are limited, so that no comment
  // shows only to be hidden once they do.
  function enabled() {
    if (!FrontFilter.isCommentsPath(window.location.pathname)) return false;
    if (!ready) return true;
    const settings = getSettings();
    return settings.limitComments && !settings.hideComments;
  }

  // Only the sort changes which comments come first.
  function key() {
    const url = new URL(window.location.href);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}?sort=${url.searchParams.get("sort") || ""}`;
  }

  function signature(settings) {
    return `${settings.commentLimit}:${settings.commentLimitMode}`;
  }

  function setAttribute(element, name, active) {
    if (active) {
      if (!element.hasAttribute(name)) element.setAttribute(name, "");
    } else if (element.hasAttribute(name)) element.removeAttribute(name);
  }

  function setVisible(element, visible) {
    setAttribute(element, VISIBLE_ATTRIBUTE, visible);
    setAttribute(element, HIDDEN_ATTRIBUTE, !visible);
  }

  function clearMarkers(tree) {
    for (const element of tree.querySelectorAll(`[${VISIBLE_ATTRIBUTE}], [${HIDDEN_ATTRIBUTE}]`)) {
      element.removeAttribute(VISIBLE_ATTRIBUTE);
      element.removeAttribute(HIDDEN_ATTRIBUTE);
    }
  }

  // A comment whose text has not rendered yet is judged by its author
  // until it does.
  function readComment(comment) {
    return {
      author: comment.getAttribute(COMMENT.authorAttribute) || "",
      text: POSTS.commentText(comment) ?? "",
    };
  }

  // The tree's top-level comments, ad slots and loaders, in page order.
  // Comments read before are reused.
  function collect(tree, comments) {
    const rows = [];
    for (const element of tree.querySelectorAll(PARTS)) {
      if (element.parentElement?.closest(COMMENT.modern)) continue;
      if (element.matches(COMMENT.modern)) {
        if (!comments.has(element)) comments.set(element, readComment(element));
        rows.push({ element, type: "comment", ...comments.get(element) });
      } else {
        rows.push({ element, type: element.matches(COMMENT.treeAds) ? "ad" : "loader" });
      }
    }
    return rows;
  }

  // Forgets the comments a change happened in, so they are read again.
  function forgetComment(comments, target) {
    const element = target.closest ? target : target.parentElement;
    let comment = element?.closest(COMMENT.modern);
    while (comment) {
      comments.delete(comment);
      comment = comment.parentElement?.closest(COMMENT.modern);
    }
  }

  function render(current) {
    const rows = collect(current.tree, current.comments);
    let shown = 0;
    let held = 0;
    let lastShown = -1;
    const visible = rows.map((row, index) => {
      if (row.type !== "comment" || isBlocked(row)) return false;
      if (shown < current.target) {
        shown += 1;
        lastShown = index;
        return true;
      }
      held += 1;
      return false;
    });
    const full = shown >= current.target;
    const loader = rows.findLast(({ type }) => type === "loader")?.element || null;
    current.loader = full ? null : loader;
    rows.forEach((row, index) => {
      let show = visible[index];
      // Ad slots go with the comments after them.
      if (row.type === "ad") show = index < lastShown;
      // Reddit loads more comments only while the limit wants them.
      if (row.type === "loader") show = !full;
      setVisible(row.element, show);
    });
    renderControls(current, { shown, held, full, loadable: Boolean(loader) });
  }

  // The controls show only while the limit holds comments back.
  function renderControls(current, { shown, held, full, loadable }) {
    const { tree, controls, status, button, size } = current;
    if (!full || (held === 0 && !loadable)) {
      controls.remove();
      return;
    }
    let message = `${shown} ${shown === 1 ? "comment" : "comments"} shown`;
    if (current.mode === "fixed") message += " · Limit reached";
    const label = !loadable && held <= size ? `Show remaining ${held}` : `Show next ${size}`;
    if (status.textContent !== message) status.textContent = message;
    if (button.textContent !== label) button.textContent = label;
    // Outside the tree, which Reddit renders.
    if (tree.nextElementSibling !== controls) tree.after(controls);
  }

  function startSession(tree) {
    const settings = getSettings();
    const controls = document.createElement("div");
    controls.className = "frontfilter-feed-controls frontfilter-comment-controls";
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "frontfilter-comment-next";
    controls.append(status);
    // Fixed mode has no expansion control.
    if (settings.commentLimitMode === "button") controls.append(button);
    const current = {
      tree, controls, status, button, key: key(), signature: signature(settings),
      size: settings.commentLimit, mode: settings.commentLimitMode,
      target: settings.commentLimit, comments: new WeakMap(),
      // The loader shown while the limit wants more comments.
      loader: null,
    };
    button.addEventListener("click", () => {
      if (session !== current || !enabled() || current.key !== key()) return;
      current.target += current.size;
      update();
      // A loader that loads by itself does so once in view, where the
      // button was; a button in it would need a second click.
      const { loader } = current;
      if (session === current && loader && loader.getAttribute("loading") !== "lazy") {
        loader.dispatchEvent(new Event(LOAD_EVENT, { bubbles: true, composed: true }));
      }
    });
    return current;
  }

  function stopSession() {
    if (!session) return;
    session.controls.remove();
    clearMarkers(session.tree);
    session = null;
  }

  function update() {
    const on = enabled();
    if (on !== observing) {
      if (on) observer.observe(document, CHANGES);
      else observer.disconnect();
      observing = on;
    }
    const tree = on
      ? document.querySelector(COMMENT.mainTree) || document.querySelector(COMMENT.tree)
      : null;
    if (limitedTree !== tree) {
      limitedTree?.removeAttribute(LIMIT_ATTRIBUTE);
      limitedTree = tree;
    }
    if (tree) setAttribute(tree, LIMIT_ATTRIBUTE, true);
    if (session && (session.tree !== tree || session.key !== key()
      || session.signature !== signature(getSettings()))) stopSession();
    if (!ready || !tree) return;
    session ??= startSession(tree);
    render(session);
  }

  // Changes elsewhere in the page matter only until the tree is found, or
  // once it is gone or the page has moved on.
  const observer = new MutationObserver((mutations) => {
    const changes = mutations.filter((mutation) => !POSTS.isUnreadTextChange(mutation, COMMENT.bodies));
    if (changes.length === 0) return;
    if (session) changes.forEach(({ target }) => forgetComment(session.comments, target));
    const tree = session?.tree || limitedTree;
    if (tree?.isConnected && (!session || session.key === key())
      && !changes.some(({ target }) => tree.contains(target))) return;
    update();
  });
  update();

  // Settings apply once loaded.
  return {
    update() {
      ready = true;
      update();
    },
  };
};
