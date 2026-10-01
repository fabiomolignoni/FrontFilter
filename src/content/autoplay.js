/**
 * Turns Reddit's video autoplay off and back on. The autoplay attributes
 * removed from each element are remembered on it, so turning the setting
 * off restores exactly what Reddit had set.
 */
FrontFilter.syncVideoAutoplay = (() => {
  const { media, attributes } = FrontFilter.SELECTORS.autoplay;
  const STATE_ATTRIBUTE = "data-frontfilter-autoplay-state";

  function savedAttributes(element) {
    return new Set((element.getAttribute(STATE_ATTRIBUTE) || "").split(",").filter(Boolean));
  }

  function isVideo(element) {
    return element.localName === "video" || element.tagName === "VIDEO";
  }

  function disable(element, forcePause = false) {
    const alreadyManaged = element.hasAttribute(STATE_ATTRIBUTE);
    const saved = savedAttributes(element);
    let autoplaySignalFound = false;

    for (const attribute of attributes) {
      if (!element.hasAttribute(attribute)) continue;
      saved.add(attribute);
      element.removeAttribute(attribute);
      autoplaySignalFound = true;
    }

    if (!alreadyManaged || autoplaySignalFound) {
      element.setAttribute(STATE_ATTRIBUTE, Array.from(saved).join(","));
    }

    // Stop automatic playback, but never a video the reader started later.
    const shouldPause = forcePause || !alreadyManaged || autoplaySignalFound;
    if (isVideo(element)) {
      element.autoplay = false;
      if (shouldPause && element.paused === false) {
        try {
          element.pause();
        } catch {
          // The attributes still prevent future automatic playback.
        }
      }
      return;
    }

    element.shadowRoot?.querySelectorAll("video").forEach((video) => {
      disable(video, shouldPause);
    });
  }

  function restore(element) {
    if (element.hasAttribute(STATE_ATTRIBUTE)) {
      const saved = savedAttributes(element);
      element.removeAttribute(STATE_ATTRIBUTE);
      for (const attribute of saved) {
        element.setAttribute(attribute, "");
      }
      if (isVideo(element)) {
        element.autoplay = saved.has("autoplay");
      }
    }

    if (!isVideo(element)) {
      element.shadowRoot?.querySelectorAll("video").forEach(restore);
    }
  }

  return function syncVideoAutoplay(disabled) {
    const update = disabled ? disable : restore;
    document.querySelectorAll(media).forEach((element) => update(element));
  };
})();
