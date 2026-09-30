/**
 * Optional "Block" button next to the subreddit of each feed post. It adds
 * an ALL rule, which hides the subreddit's posts everywhere, and offers an
 * undo. Settings are written to storage; the usual listeners apply them.
 */
FrontFilter.createQuickBlock = function ({ getSettings, isAllowed }) {
  const BUTTON_CLASS = "frontfilter-block-subreddit";
  const TOAST_CLASS = "frontfilter-block-toast";
  const TOAST_DURATION = 6000;
  let buttonsShown = false;
  let toast = null;
  let toastTimer = null;

  function getPostSubreddit(post) {
    return FrontFilter.normalizeSubredditName(
      post.getAttribute("subreddit-name") || post.getAttribute("subreddit-prefixed-name"),
    );
  }

  // A subreddit's own feed only holds its posts, profile posts have no
  // subreddit to block, and allowed subreddits override block rules.
  function isBlockable(name, pageSubreddit) {
    return Boolean(name) && !name.startsWith("u_") && name !== pageSubreddit && !isAllowed(name);
  }

  function createButton(name) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.dataset.subreddit = name;
    button.textContent = "Block";
    button.title = `Hide r/${name} everywhere with FrontFilter`;
    button.setAttribute("aria-label", `Block r/${name} with FrontFilter`);
    button.addEventListener("click", (event) => {
      // The whole card is a link to the post.
      event.preventDefault();
      event.stopPropagation();
      void block(name);
    });
    return button;
  }

  function update() {
    const enabled = getSettings().showBlockSubredditButton;
    if (!enabled && !buttonsShown) return;
    const pageSubreddit = FrontFilter.getSubredditPath(window.location.pathname)?.name || "";
    for (const post of document.querySelectorAll("shreddit-feed shreddit-post")) {
      const creditBar = post.querySelector(':scope > [slot="credit-bar"]');
      const existing = creditBar?.querySelector(`.${BUTTON_CLASS}`);
      const name = getPostSubreddit(post);
      if (!enabled || !creditBar || !isBlockable(name, pageSubreddit)) {
        existing?.remove();
        continue;
      }
      if (existing?.dataset.subreddit === name) continue;
      existing?.remove();
      // Next to Join and the overflow menu, which Reddit keeps above the
      // card's full-size post link.
      const actions = creditBar.children.length > 1 ? creditBar.lastElementChild : creditBar;
      actions.prepend(createButton(name));
    }
    buttonsShown = enabled;
  }

  async function readBlockedSubreddits() {
    const { blockedSubreddits } = await chrome.storage.local.get("blockedSubreddits");
    return blockedSubreddits;
  }

  async function block(name) {
    try {
      const { entries, added } = FrontFilter.addBlockedSubreddit(await readBlockedSubreddits(), name);
      if (added) await chrome.storage.local.set({ blockedSubreddits: entries });
      showToast(added ? `r/${name} blocked` : `r/${name} is already blocked`, added ? name : "");
    } catch (error) {
      showToast(`Could not block r/${name}: ${error.message}`);
    }
  }

  async function undo(name) {
    try {
      const entries = FrontFilter.removeBlockedSubreddit(await readBlockedSubreddits(), name);
      await chrome.storage.local.set({ blockedSubreddits: entries });
      showToast(`r/${name} unblocked`);
    } catch (error) {
      showToast(`Could not unblock r/${name}: ${error.message}`);
    }
  }

  function showToast(message, undoName = "") {
    clearTimeout(toastTimer);
    toast?.remove();
    toast = document.createElement("div");
    toast.className = TOAST_CLASS;
    toast.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(text);
    if (undoName) {
      const undoButton = document.createElement("button");
      undoButton.type = "button";
      undoButton.textContent = "Undo";
      undoButton.addEventListener("click", () => void undo(undoName));
      toast.append(undoButton);
    }
    (document.body || document.documentElement).append(toast);
    const current = toast;
    toastTimer = setTimeout(() => {
      current.remove();
      if (toast === current) toast = null;
    }, TOAST_DURATION);
  }

  return { update };
};
