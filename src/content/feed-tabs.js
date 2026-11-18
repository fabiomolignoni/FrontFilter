/**
 * Home's feeds, For You and Following, which Reddit shows as tabs above
 * Home's feed. A tab switches the feed in place, at the same address:
 * Reddit reloads the feed's posts once the tab is selected. While For You
 * is blocked, page rules hide its tab and its posts (page-style.js), and
 * this opens Following, with a click on its tab, as a reader would.
 */
FrontFilter.feedTabs = (() => {
  const SELECTORS = FrontFilter.SELECTORS;
  const TABS = SELECTORS.feedTabs;
  const SELECTED = `${TABS.tabs} ${TABS.selected}`;
  const SELECTED_FOR_YOU = `${TABS.tab(TABS.forYou)}[${TABS.selectedAttribute}]`;

  // The token of the feed Home's tabs have selected, such as "for-you",
  // or "" on a page without them.
  function selected() {
    return document.querySelector(SELECTED)?.getAttribute(TABS.tokenAttribute) || "";
  }

  // Whether Home shows For You while it is blocked: Following is about to
  // replace it.
  function opensFollowing(settings) {
    return Boolean(settings.blockForYou) && selected() === TABS.forYou;
  }

  // The feed that the tabs switch, which they name with a selector.
  function feedOf(tabs) {
    try {
      return document.querySelector(tabs.getAttribute(TABS.feedAttribute) || SELECTORS.feed.mainFeed);
    } catch {
      return null;
    }
  }

  // Selects Following wherever For You is selected. Reddit's tabs, and its
  // feed, take the click only once Reddit has defined them: until then,
  // the page's next change, or the next check, tries again.
  function openFollowing() {
    for (const tabs of document.querySelectorAll(TABS.tabs)) {
      if (!tabs.querySelector(SELECTED_FOR_YOU)) continue;
      const following = tabs.querySelector(TABS.tab(TABS.following));
      const feed = feedOf(tabs);
      if (!following || following.closest(":not(:defined)") || !feed?.matches(":defined")) continue;
      following.click();
    }
  }

  return Object.freeze({ selected, opensFollowing, openFollowing });
})();
