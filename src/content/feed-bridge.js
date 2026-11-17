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
 *
 * Reddit starts a feed's next page in two ways, both through its loader's
 * load(): its feed, once the loader is within two windows of view, and its
 * posts, once one of the last of a page is seen. Other loaders, and earlier
 * versions of the feed, load through loadContent(). The gate holds back
 * both methods, wherever Reddit's classes define them.
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
  // The methods that start a load. The first one found loads what the
  // limits ask for: it works on every loader, where load() only does on
  // those that load on request.
  const LOAD_METHODS = ["loadContent", "load"];
  // Reddit's loader reports a load that failed with this event, and
  // resolves; earlier versions rejected.
  const NATIVE_ERROR_EVENT = "faceplate-error";
  const suppressed = new Set();
  let originalLoad = null;

  // Holds a load back until the gate opens. Loaders of feeds the page has
  // left are let go: they would keep those feeds in memory.
  function suppress(loader) {
    for (const other of suppressed) {
      if (!other.isConnected) suppressed.delete(other);
    }
    suppressed.add(loader);
  }

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

  // The class of the loader, or one it extends, that defines a method.
  function findOwner(prototype, name) {
    let owner = prototype;
    while (owner && owner !== HTMLElement.prototype && !Object.hasOwn(owner, name)) {
      owner = Object.getPrototypeOf(owner);
    }
    return owner && owner !== HTMLElement.prototype && typeof owner[name] === "function" ? owner : null;
  }

  // Replaces a method that starts a load with one the gate holds back for
  // feed loaders, and returns the original. Other elements that share the
  // method load as before.
  function guard(owner, name) {
    const original = owner[name];
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, {
      configurable: descriptor.configurable ?? true,
      enumerable: descriptor.enumerable ?? false,
      writable: descriptor.writable ?? true,
      value(...args) {
        if (document.documentElement?.hasAttribute(GATE_ATTRIBUTE) && isFeedLoader(this)) {
          suppress(this);
          return Promise.resolve();
        }
        return Reflect.apply(original, this, args);
      },
    });
    return original;
  }

  function install() {
    const prototype = customElements.get("faceplate-partial")?.prototype;
    if (!prototype || originalLoad) return;

    const originals = [];
    for (const name of LOAD_METHODS) {
      const owner = findOwner(prototype, name);
      if (!owner) continue;
      try {
        originals.push(guard(owner, name));
      } catch (error) {
        console.error(`FrontFilter could not control Reddit's ${name}:`, error);
      }
    }
    // Without any of them, the limits let Reddit load by itself.
    if (originals.length === 0) return;
    [originalLoad] = originals;

    document.documentElement?.setAttribute(READY_ATTRIBUTE, "");
    document.dispatchEvent(new Event(READY_EVENT));
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const loader = event.target;
    if (!originalLoad || !isFeedLoader(loader)) return;
    const token = loader.getAttribute(REQUEST_ATTRIBUTE);
    if (!token) return;
    suppressed.delete(loader);

    const fail = () => reportError(loader, token);
    loader.addEventListener(NATIVE_ERROR_EVENT, fail, { once: true });
    try {
      const result = invoke(loader);
      if (result?.then) Promise.resolve(result).catch(fail);
    } catch {
      fail();
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
