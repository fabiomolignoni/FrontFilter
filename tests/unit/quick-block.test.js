const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { createDocument, fakeFetch, fakeI18n, runScripts, settle } = require("./helpers");

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

// A feed of posts, each with the markup given for its subreddit.
function feedPage(posts) {
  return `<html><body><shreddit-feed>${Object.entries(posts).map(([name, markup]) =>
    `<shreddit-post subreddit-prefixed-name="r/${name}">${markup}</shreddit-post>`).join("")}</shreddit-feed></body></html>`;
}

// The credit bar as Reddit lays it out for most visitors and for the others,
// with what stands for Join in it: nothing, for a subreddit the reader joined.
const MENU = '<shreddit-async-loader bundlename="shreddit_post_overflow_menu"></shreddit-async-loader>';
const JOIN = "<shreddit-join-button></shreddit-join-button>";
const usualBar = (join = JOIN) => `<span slot="credit-bar">
  <span id="feed-post-credit-bar-t3_abc"><a>subreddit</a></span>
  <span class="actions">${join}<span class="menu">${MENU}</span></span>
</span>`;
const otherBar = (join = JOIN) => `<span slot="credit-bar" id="feed-post-credit-bar-t3_abc">
  <span><span>
    <faceplate-loader></faceplate-loader>
    <div><span class="icon"></span><ul></ul><div class="actions">${join}${MENU}</div></div>
  </span></span>
</span>`;

function loadQuickBlock({
  blockedSubreddits = [],
  url = "https://www.reddit.com/r/popular/",
  setError = null,
  html = PAGE,
} = {}) {
  const page = createDocument(html);
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
      i18n: fakeI18n(),
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
    "shared/core.js", "shared/i18n.js", "content/selectors.js", "content/posts.js", "content/quick-block.js",
  ]);
  const quickBlock = context.FrontFilter.createQuickBlock({
    getSettings: () => settings,
    isAllowed: (name) => name === "allowedsub",
  });
  quickBlock.update();

  const toast = () => page.document.querySelector(".frontfilter-block-toast");
  return {
    context,
    quickBlock,
    settings,
    location,
    writes,
    document: page.document,
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

test("puts the Block button before Join in each of Reddit's credit bars", () => {
  const page = loadQuickBlock({
    html: feedPage({
      usual: usualBar(),
      other: otherBar(),
      // A slim card, such as a link post, holds its bar inside its grid.
      slim: `<a slot="full-post-link"></a><div><div>${otherBar()}</div></div>`,
      // A recommended post has a bar for the reason it is shown.
      recommended: `<span slot="credit-bar"><span>Because you visited</span></span>${usualBar()}`,
      // A bar in a nested card is that card's, not this one's.
      outer: `<div><shreddit-post subreddit-prefixed-name="r/inner">${usualBar()}</shreddit-post></div>`,
    }),
  });
  assert.deepEqual(
    page.buttons().map((button) => button.dataset.subreddit),
    ["usual", "other", "slim", "recommended", "inner"],
  );
  for (const button of page.buttons()) {
    assert.equal(button.nextElementSibling.localName, "shreddit-join-button", button.dataset.subreddit);
    assert.equal(button.parentElement.className, "actions", button.dataset.subreddit);
  }
});

test("puts the Block button beside the overflow menu of a bar without Join", () => {
  const page = loadQuickBlock({ html: feedPage({ usual: usualBar(""), other: otherBar("") }) });
  assert.equal(page.button("usual").nextElementSibling.className, "menu");
  assert.equal(page.button("other").nextElementSibling.localName, "shreddit-async-loader");
  for (const button of page.buttons()) assert.equal(button.parentElement.className, "actions");
});

test("moves the Block button before Join once a bar that was still arriving holds it", () => {
  // Reddit's pages stream in: a bar can be read before all of it is there.
  const page = loadQuickBlock({
    html: feedPage({ late: '<span slot="credit-bar"><span id="feed-post-credit-bar-t3_abc"></span></span>' }),
  });
  const button = page.button("late");
  const creditBar = button.parentElement;
  assert.equal(creditBar.getAttribute("slot"), "credit-bar");

  const actions = page.document.createElement("span");
  const join = page.document.createElement("shreddit-join-button");
  actions.append(join);
  creditBar.append(actions);
  page.quickBlock.update();
  assert.deepEqual(page.buttons(), [button]);
  assert.equal(button.nextElementSibling, join);

  // Once there, it stays.
  page.quickBlock.update();
  assert.deepEqual(actions.children, [button, join]);
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
  assert.equal(page.toastText(), "r/news is blocked on its front page only");
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

test("relabels its buttons in a language chosen once they show", async () => {
  const page = loadQuickBlock();
  const { i18n } = page.context.FrontFilter;
  const load = (tag) => {
    page.context.fetch = fakeFetch();
    page.context.chrome.runtime = { getURL: (path) => `chrome-extension://frontfilter/${path}` };
    return i18n.fetchMessages(tag);
  };
  assert.equal(await i18n.use("it", load), true);
  page.quickBlock.relabel();
  const button = page.button("news");
  assert.equal(button.textContent, "Blocca");
  assert.equal(button.title, "Nascondi r/news ovunque con FrontFilter");
  assert.equal(button.getAttribute("aria-label"), "Blocca r/news con FrontFilter");
});
