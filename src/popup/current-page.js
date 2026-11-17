/**
 * The settings page's card for the Reddit page open in the current tab
 * (popup.js): its name, what filters hide on it, and for a subreddit, what
 * the rules do to it, with buttons that block or allow it.
 *
 * In a tab of its own, the settings page is the current tab: the card then
 * shows the subreddit the page was opened for, if any.
 */
FrontFilter.createCurrentPageCard = function ({
  standalone, openedFor, subredditList, blocksSubredditFronts,
  isLocked, isDisabled, showToast, flushPendingSave,
}) {
  const { ALLOW } = FrontFilter.entryList;
  const byId = (id) => document.getElementById(id);
  const card = {
    element: byId("current-page"),
    prefix: byId("current-page-prefix"),
    name: byId("current-page-name"),
    status: byId("current-page-status"),
    countsText: byId("current-page-hidden"),
    actions: byId("current-page-actions"),
    block: byId("add-current-subreddit"),
    allow: byId("add-current-allowed-subreddit"),
  };
  // The count keeps up with the page while the popup is open, as Reddit
  // loads posts and settings change, for as long as the page answers.
  const COUNTS_REFRESH = 1000;
  const numberFormat = new Intl.NumberFormat();
  // The page's tab, and its subreddit, if it is one.
  let tabId = null;
  let subreddit = "";
  // What filters hide on the page, as it last said, or null until it does.
  let counts = null;

  // The current tab and its address, if it shows Reddit: browsers give
  // only the URLs of tabs FrontFilter can access, Reddit's.
  async function findCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = FrontFilter.getRedditUrl(tab?.url);
    return url ? { id: tab.id, url } : null;
  }

  // The subreddit this page was opened for, or that the current tab shows.
  async function findCurrentSubreddit() {
    if (openedFor) return openedFor;
    const tab = await findCurrentTab();
    return (tab && FrontFilter.getSubredditPath(tab.url.pathname)?.name) || "";
  }

  // Adds a rule for the current subreddit, in the mode given, and returns
  // whether a subreddit was found to add.
  async function addCurrentSubreddit(mode, message) {
    try {
      const name = await findCurrentSubreddit();
      if (name) {
        subredditList.add(name, { moveFocus: false, mode });
        // While locked, an exception may wait, which its save tells.
        if (mode !== ALLOW || !isLocked()) showToast(message(name), "success");
        return true;
      }
      showToast("No subreddit found on current tab", "error");
    } catch {
      showToast("Could not access current tab", "error");
    }
    return false;
  }

  // What the page's content script answers when asked what filters hide
  // on it. It answers nothing where it cannot count every post, as in Old
  // Reddit or search results. The question fails where no content script
  // listens: on a page loaded before FrontFilter was installed, updated or
  // reloaded, as browsers add none to pages already open.
  function askPage() {
    return chrome.tabs.sendMessage(tabId, { action: "countHidden" });
  }

  async function pageListens() {
    try {
      await askPage();
      return true;
    } catch {
      return false;
    }
  }

  // Blocking the subreddit in front sends its page to the block page. Its
  // content script does so once the rule is saved; a page without one is
  // reloaded, once the navigation rules block it, which also gives it one.
  async function blockCurrentSubreddit() {
    const blockedTab = tabId;
    const listens = blockedTab === null || await pageListens();
    const added = await addCurrentSubreddit(
      "all", (name) => `r/${name} blocked everywhere`,
    );
    if (!added || listens) return;
    try {
      await flushPendingSave();
    } catch {
      // The rule was not saved, and the save says so.
      return;
    }
    try {
      // Without the rules, the reloaded page's content script blocks it.
      await FrontFilter.askBackground({ action: "syncNavigationRules" }).catch(() => undefined);
      await chrome.tabs.reload(blockedTab);
    } catch (error) {
      console.error("Could not reload the blocked page:", error);
    }
  }

  // What the rules do to a subreddit: one an exception allows stays open,
  // and an exact name or a pattern may block it everywhere or on its front
  // page.
  function describeSubreddit(name) {
    const { blockedSubreddits, allowedSubreddits } = subredditList.stored();
    const exceptions = allowedSubreddits
      .filter((pattern) => FrontFilter.matchesSubredditPattern(pattern, name));
    if (exceptions.length > 0) {
      const by = exceptions.includes(name) ? "" : ` by ${exceptions[0]}`;
      return { text: `Allowed${by}, so it stays open`, allowed: true };
    }
    const rules = blockedSubreddits
      .filter((rule) => FrontFilter.matchesSubredditPattern(rule.name, name));
    const rule = rules.find((other) => other.mode === "all") || rules[0];
    const by = rule && rule.name !== name ? ` by ${rule.name}` : "";
    if (rule?.mode === "all") return { text: `Blocked everywhere${by}`, everywhere: true };
    if (rule) return { text: `Front page blocked${by}` };
    if (blocksSubredditFronts()) return { text: "Front page blocked, like every subreddit's" };
    return { text: "Not blocked" };
  }

  // A Reddit page other than a subreddit, by the name the settings and
  // statistics give it, and the prefix of a profile.
  function nameOfPage(pathname) {
    const user = FrontFilter.getProfileUser(pathname);
    if (user) return { prefix: "u/", name: `u/${user}` };
    const route = FrontFilter.getPageRoute(pathname);
    return { prefix: "", name: route ? FrontFilter.stats.describeTarget(`page:${route.page}`) : "Reddit" };
  }

  // What filters hide on the page, as the card says it.
  function describeCounts({ posts, comments }) {
    const formatNumber = (count) => numberFormat.format(count);
    const parts = [
      posts > 0 && `${formatNumber(posts)} ${posts === 1 ? "post" : "posts"}`,
      comments > 0 && `${formatNumber(comments)} ${comments === 1 ? "comment" : "comments"}`,
    ].filter(Boolean);
    return parts.length > 0 ? `${parts.join(" and ")} hidden on this page` : "Nothing hidden on this page";
  }

  // The card shows on a subreddit, and on any other Reddit page that says
  // what filters hide on it. A subreddit's buttons are off where they
  // would change nothing: an allowed subreddit stays open whatever blocks it.
  function update() {
    card.element.hidden = !subreddit && !counts;
    card.countsText.hidden = !counts;
    if (counts) card.countsText.textContent = describeCounts(counts);
    card.status.hidden = !subreddit;
    card.actions.hidden = !subreddit;
    if (!subreddit) return;
    const state = describeSubreddit(subreddit);
    card.status.textContent = state.text;
    card.block.disabled = isDisabled() || Boolean(state.everywhere || state.allowed);
    card.allow.disabled = isDisabled() || Boolean(state.allowed);
  }

  async function readCounts() {
    try {
      const answer = await askPage();
      const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
      if (!isCount(answer?.posts) || !isCount(answer?.comments)) return null;
      return { posts: answer.posts, comments: answer.comments };
    } catch {
      return null;
    }
  }

  async function refreshCounts() {
    const read = await readCounts();
    if (JSON.stringify(read) !== JSON.stringify(counts)) {
      counts = read;
      update();
    }
    if (read) setTimeout(refreshCounts, COUNTS_REFRESH);
  }

  async function show() {
    let tab = null;
    try {
      // In a tab of its own, the current tab is this page.
      if (!standalone) tab = await findCurrentTab();
    } catch {
      // Without the tab, the card shows nothing of it.
    }
    subreddit = openedFor || (tab && FrontFilter.getSubredditPath(tab.url.pathname)?.name) || "";
    tabId = tab?.id ?? null;
    let page = { prefix: "", name: "" };
    if (subreddit) page = { prefix: "r/", name: `r/${subreddit}` };
    else if (tab) page = nameOfPage(tab.url.pathname);
    const { prefix, name } = page;
    card.prefix.textContent = prefix;
    card.name.textContent = name;
    // A long name is cut short on screen, and whole here.
    card.name.setAttribute("title", name);
    card.block.setAttribute("aria-label", `Block ${name}`);
    card.allow.setAttribute("aria-label", `Allow ${name}`);
    update();
    if (tab) await refreshCounts();
  }

  card.block.addEventListener("click", blockCurrentSubreddit);
  card.allow.addEventListener("click", () => addCurrentSubreddit(
    ALLOW, (name) => `r/${name} allowed`,
  ));

  return {
    show,
    // Call when the rules, the settings or the page's controls change.
    update,
    subreddit: () => subreddit,
  };
};
