/**
 * Page-world adapter for Reddit's feed continuation element, the loader of
 * a thread's next top-level comments, and video players.
 *
 * Content scripts cannot call page-defined custom-element methods in Chrome's
 * isolated world. This bridge uses fixed DOM events to invoke the native feed
 * loader, release native loads suppressed by the finite-feed gate, load the
 * comments the comment limit's next group lacks, and ask players whose
 * autoplay was restored to try it again. No extension APIs, settings, or
 * data enter the page world.
 */
(() => {
  "use strict";

  const FEED = "shreddit-feed";
  const LOADER = 'faceplate-partial[slot="load-after"]';
  const GATE_ATTRIBUTE = "data-frontfilter-feed-gate";
  const READY_ATTRIBUTE = "data-frontfilter-feed-bridge";
  const REQUEST_ATTRIBUTE = "data-frontfilter-load-request";
  const ERROR_ATTRIBUTE = "data-frontfilter-load-error";
  const READY_EVENT = "frontfilter-feed-bridge-ready";
  const REQUEST_EVENT = "frontfilter-feed-load-request";
  const ERROR_EVENT = "frontfilter-feed-load-error";
  const RELEASE_EVENT = "frontfilter-feed-load-release";
  const COMMENT_TREE = "shreddit-comment-tree";
  const COMMENT = "shreddit-comment";
  const COMMENT_LOADER = 'faceplate-partial[src*="/more-comments/"]';
  const COMMENT_LOAD_EVENT = "frontfilter-comments-load-request";
  const PLAYER = "shreddit-player";
  const AUTOPLAY_RESTORED_EVENT = "frontfilter-autoplay-restored";
  const suppressed = new Set();
  let originalLoad = null;

  function isFeedLoader(element) {
    return element instanceof Element
      && element.matches(LOADER)
      && element.closest(FEED);
  }

  function invoke(loader) {
    return Reflect.apply(originalLoad, loader, []);
  }

  function reportError(loader, token) {
    if (loader.getAttribute(REQUEST_ATTRIBUTE) !== token) return;
    loader.setAttribute(ERROR_ATTRIBUTE, token);
    loader.dispatchEvent(new Event(ERROR_EVENT));
  }

  function install() {
    const prototype = customElements.get("faceplate-partial")?.prototype;
    if (!prototype || typeof prototype.loadContent !== "function" || originalLoad) return;

    originalLoad = prototype.loadContent;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "loadContent");
    const guardedLoad = function (...args) {
      if (document.documentElement?.hasAttribute(GATE_ATTRIBUTE) && isFeedLoader(this)) {
        suppressed.add(this);
        return Promise.resolve();
      }
      return Reflect.apply(originalLoad, this, args);
    };

    try {
      Object.defineProperty(prototype, "loadContent", {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? false,
        writable: descriptor?.writable ?? true,
        value: guardedLoad,
      });
    } catch (error) {
      console.error("FrontFilter could not control feed loading:", error);
      originalLoad = null;
      return;
    }

    document.documentElement?.setAttribute(READY_ATTRIBUTE, "");
    document.dispatchEvent(new Event(READY_EVENT));
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const loader = event.target;
    if (!originalLoad || !isFeedLoader(loader)) return;
    const token = loader.getAttribute(REQUEST_ATTRIBUTE);
    if (!token) return;
    suppressed.delete(loader);

    try {
      const result = invoke(loader);
      if (result?.then) Promise.resolve(result).catch(() => reportError(loader, token));
    } catch {
      reportError(loader, token);
    }
  });

  document.addEventListener(RELEASE_EVENT, () => {
    for (const loader of suppressed) {
      if (loader.isConnected) {
        try { Promise.resolve(invoke(loader)).catch(() => {}); } catch { /* Reddit owns native retries. */ }
      }
    }
    suppressed.clear();
  });

  // The loader of a thread's next top-level comments: in its comment tree,
  // outside every comment. Reddit's own button in it loads them the same way.
  document.addEventListener(COMMENT_LOAD_EVENT, (event) => {
    const loader = event.target;
    if (!originalLoad || !(loader instanceof Element) || !loader.matches(COMMENT_LOADER)
      || !loader.closest(COMMENT_TREE) || loader.parentElement?.closest(COMMENT)) return;
    try {
      Promise.resolve(invoke(loader)).catch(() => {});
    } catch {
      // Reddit's own button stays for the reader to try.
    }
  });

  // A player tries autoplay as it scrolls into view, if it is visible
  // enough; a restored one already on screen needs asking again.
  document.addEventListener(AUTOPLAY_RESTORED_EVENT, (event) => {
    const player = event.target;
    if (!(player instanceof Element) || player.localName !== PLAYER) return;
    try {
      player.mediaVisibilityController?.attemptAutoplay?.();
    } catch {
      // Reddit's player keeps its own scroll-based autoplay.
    }
  });

  install();
  customElements.whenDefined("faceplate-partial").then(install);
})();
