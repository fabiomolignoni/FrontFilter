const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { createDocument, runScripts, settle } = require("./helpers");

// A Home feed with posts from three subreddits and a profile, and a
// subreddit header, in the markup the Block buttons rely on.
const PAGE = `<html><body>
  <shreddit-subreddit-header>
    <shreddit-subreddit-header-buttons name="worldnews"></shreddit-subreddit-header-buttons>
  </shreddit-subreddit-header>
  <shreddit-feed>
    ${["r/news", "r/AllowedSub", "u_someone", "r/firefox"].map((name) => `
      <shreddit-post subreddit-prefixed-name="${name}">
        <div slot="credit-bar"><span>${name}</span><div class="actions"></div></div>
      </shreddit-post>`).join("")}
  </shreddit-feed>
</body></html>`;

function loadQuickBlock({
  blockedSubreddits = [],
  url = "https://www.reddit.com/r/popular/",
  setError = null,
} = {}) {
  const page = createDocument(PAGE);
  const writes = [];
  let stored = { blockedSubreddits };
  const settings = { showBlockSubredditButton: true };
  const location = { href: url, pathname: new URL(url).pathname };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    console,
    crypto,
    clearTimeout,
    setTimeout: () => 0,
    document: page.document,
    window: { location },
    chrome: {
      storage: {
        local: {
          get: async (key) => ({ [key]: stored[key] }),
          async set(values) {
            if (setError) throw setError;
            writes.push(JSON.parse(JSON.stringify(values)));
            stored = { ...stored, ...values };
          },
        },
      },
    },
  });
  runScripts(context, [
    "shared/core.js", "content/selectors.js", "content/posts.js", "content/quick-block.js",
  ]);
  const quickBlock = context.FrontFilter.createQuickBlock({
    getSettings: () => settings,
    isAllowed: (name) => name === "allowedsub",
  });
  quickBlock.update();

  const toast = () => page.document.querySelector(".frontfilter-block-toast");
  return {
    quickBlock,
    settings,
    location,
    writes,
    buttons: () => page.document.querySelectorAll(".frontfilter-block-subreddit"),
    button: (name) => page.document.querySelectorAll(".frontfilter-block-subreddit")
      .find((button) => button.dataset.subreddit === name),
    toast,
    toastText: () => toast()?.querySelector("span").textContent,
    undoButton: () => toast()?.querySelector("button"),
    click: (button) => button.dispatch("click", { preventDefault() {}, stopPropagation() {} }),
  };
}

test("adds Block buttons to subreddit posts and headers, only while enabled", () => {
  const page = loadQuickBlock();
  assert.deepEqual(page.buttons().map((button) => button.dataset.subreddit), [
    "worldnews", "news", "firefox",
  ]);
  const button = page.button("news");
  assert.equal(button.parentElement.className, "actions");
  assert.equal(button.getAttribute("aria-label"), "Block r/news with FrontFilter");
  assert.match(page.button("worldnews").className, /--header/);

  page.quickBlock.update();
  assert.equal(page.buttons().length, 3);

  page.settings.showBlockSubredditButton = false;
  page.quickBlock.update();
  assert.equal(page.buttons().length, 0);
});

test("leaves out the subreddit whose page is open", () => {
  const page = loadQuickBlock({ url: "https://www.reddit.com/r/firefox/" });
  assert.deepEqual(page.buttons().map((button) => button.dataset.subreddit), ["worldnews", "news"]);
});

test("blocks a subreddit in ALL mode from a feed, with an undo", async () => {
  const page = loadQuickBlock({ blockedSubreddits: [{ name: "firefox", mode: "home" }] });
  page.click(page.button("news"));
  await settle();

  assert.deepEqual(page.writes, [{
    blockedSubreddits: [{ name: "firefox", mode: "home" }, { name: "news", mode: "all" }],
  }]);
  assert.equal(page.toastText(), "r/news blocked");

  page.undoButton().click();
  await settle();
  assert.deepEqual(page.writes.at(-1), { blockedSubreddits: [{ name: "firefox", mode: "home" }] });
  assert.equal(page.toastText(), "r/news unblocked");
  assert.equal(page.undoButton(), null);
});

test("turns a HOME rule into ALL, and undoing turns it back", async () => {
  const page = loadQuickBlock({ blockedSubreddits: [{ name: "news", mode: "home" }] });
  page.click(page.button("news"));
  await settle();
  assert.deepEqual(page.writes, [{ blockedSubreddits: [{ name: "news", mode: "all" }] }]);

  page.undoButton().click();
  await settle();
  assert.deepEqual(page.writes.at(-1), { blockedSubreddits: [{ name: "news", mode: "home" }] });
  assert.equal(page.toastText(), "r/news is back to HOME");
});

test("does not block an already blocked subreddit again", async () => {
  const page = loadQuickBlock({ blockedSubreddits: [{ name: "news", mode: "all" }] });
  page.click(page.button("news"));
  await settle();
  assert.deepEqual(page.writes, []);
  assert.equal(page.toastText(), "r/news is already blocked");
  assert.equal(page.undoButton(), null);
});

test("blocking the open subreddit leaves a one-time undo for its block page", async () => {
  const page = loadQuickBlock({ url: "https://www.reddit.com/r/worldnews/" });
  const before = Date.now();
  page.click(page.button("worldnews"));
  await settle();

  const [{ blockedSubreddits, quickBlockUndo }] = page.writes;
  assert.deepEqual(blockedSubreddits, [{ name: "worldnews", mode: "all" }]);
  assert.equal(quickBlockUndo.subreddit, "worldnews");
  assert.equal(quickBlockUndo.previousMode, null);
  assert.match(quickBlockUndo.token, /^[0-9a-f]{32}$/);
  assert.ok(quickBlockUndo.expires > before);

});

test("hands the undo token only to the redirect the block causes, once", async () => {
  const redirected = async (url, check) => {
    const page = loadQuickBlock({ url: "https://www.reddit.com/r/worldnews/" });
    page.click(page.button("worldnews"));
    await settle();
    page.location.href = url;
    return check(page.quickBlock, page.writes[0].quickBlockUndo.token);
  };

  await redirected("https://www.reddit.com/r/worldnews/", (quickBlock, token) => {
    assert.equal(quickBlock.takeUndo("worldnews"), token);
    assert.equal(quickBlock.takeUndo("worldnews"), "");
  });
  // Another subreddit's redirect, or one after navigating, gets nothing.
  await redirected("https://www.reddit.com/r/worldnews/", (quickBlock) => {
    assert.equal(quickBlock.takeUndo("news"), "");
    assert.equal(quickBlock.takeUndo("worldnews"), "");
  });
  await redirected("https://www.reddit.com/r/worldnews/top/", (quickBlock) => {
    assert.equal(quickBlock.takeUndo("worldnews"), "");
  });
});

test("reports a block that could not be saved", async () => {
  const page = loadQuickBlock({
    url: "https://www.reddit.com/r/worldnews/",
    setError: new Error("storage unavailable"),
  });
  page.click(page.button("worldnews"));
  await settle();
  assert.equal(page.toastText(), "Could not block r/worldnews: storage unavailable");
  assert.equal(page.quickBlock.takeUndo("worldnews"), "");
});
