/**
 * Optional "Block" buttons next to the subreddit of each feed post and in a
 * subreddit's own header, beside Create Post. They add an ALL rule, which
 * hides the subreddit's posts everywhere, and offer an undo. Settings are
 * written to storage; the usual listeners apply them.
 */
FrontFilter.createQuickBlock = function ({ getSettings, isAllowed }) {
  const BUTTON_CLASS = "frontfilter-block-subreddit";
  const HEADER_BUTTON_CLASS = "frontfilter-block-subreddit--header";
  // Join, notifications and the overflow menu; it names the subreddit and
  // follows Create Post. The navbar's own Create button has no such sibling.
  const HEADER_BUTTONS = "shreddit-subreddit-header-buttons[name]";
  const TOAST_CLASS = "frontfilter-block-toast";
  const TOAST_DURATION = 6000;
  // Blocking the subreddit on screen sends the page straight to the block
  // page, which offers the undo instead of the toast. A one-time token,
  // stored with the rule, limits that offer to this redirect.
  const UNDO_WINDOW = 10000;
  let buttonsShown = false;
  let pendingUndo = null;
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

  function createButton(name, className = BUTTON_CLASS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
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
    updateHeaders(enabled);
    buttonsShown = enabled;
  }

  function updateHeaders(enabled) {
    for (const headerButtons of document.querySelectorAll(HEADER_BUTTONS)) {
      const name = FrontFilter.normalizeSubredditName(headerButtons.getAttribute("name"));
      const previous = headerButtons.previousElementSibling;
      const existing = previous?.classList.contains(BUTTON_CLASS) ? previous : null;
      if (!enabled || !isBlockable(name, "")) {
        existing?.remove();
        continue;
      }
      if (existing?.dataset.subreddit === name) continue;
      existing?.remove();
      headerButtons.before(createButton(name, `${BUTTON_CLASS} ${HEADER_BUTTON_CLASS}`));
    }
  }

  // Returns the undo token for the redirect a block made on this very page
  // causes, and nothing for any later redirect or navigation.
  function takeUndo(name) {
    const pending = pendingUndo;
    pendingUndo = null;
    return pending && pending.name === name && pending.url === window.location.href
      ? pending.token
      : "";
  }

  function createToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }

  async function readBlockedSubreddits() {
    const { blockedSubreddits } = await chrome.storage.local.get("blockedSubreddits");
    return blockedSubreddits;
  }

  async function block(name) {
    try {
      const { entries, added } = FrontFilter.addBlockedSubreddit(await readBlockedSubreddits(), name);
      const pageSubreddit = FrontFilter.getSubredditPath(window.location.pathname)?.name;
      const redirects = added && pageSubreddit === name;
      const token = redirects ? createToken() : "";
      // Set before writing: the storage listener redirects right away.
      pendingUndo = redirects ? { name, token, url: window.location.href } : null;
      if (added) {
        await chrome.storage.local.set({
          blockedSubreddits: entries,
          ...(redirects && {
            [FrontFilter.QUICK_BLOCK_UNDO_KEY]: {
              subreddit: name, token, expires: Date.now() + UNDO_WINDOW,
            },
          }),
        });
      }
      showToast(added ? `r/${name} blocked` : `r/${name} is already blocked`, added ? name : "");
    } catch (error) {
      pendingUndo = null;
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

  return { update, takeUndo };
};
