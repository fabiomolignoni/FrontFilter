const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

class FakeElement {
  constructor(tagName = "") {
    this.tagName = tagName.toUpperCase();
    this.checked = false;
    this.children = [];
    this.className = "";
    this.disabled = false;
    this.files = [];
    this.focused = false;
    this.listeners = {};
    this.attributes = {};
    this.parentElement = null;
    this.textContent = "";
    this.value = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    };
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === "") this.children = [];
  }

  get innerHTML() {
    return this._innerHTML || "";
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  click() {
    this.clickCount = (this.clickCount || 0) + 1;
    return this.listeners.click?.({ target: this });
  }

  dispatch(type, event = {}) {
    return this.listeners[type]?.({ target: this, ...event });
  }

  focus() {
    this.focused = true;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const descendants = [];
    const visit = (element) => {
      for (const child of element.children || []) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);

    if (/^\.[\w-]+$/.test(selector)) {
      return descendants.filter((element) => element.className === selector.slice(1));
    }
    if (selector === "input") {
      return descendants.filter((element) => element.tagName === "INPUT");
    }
    if (selector === "input, select, button") {
      return descendants.filter((element) => ["INPUT", "SELECT", "BUTTON"].includes(
        element.tagName,
      ));
    }
    return [];
  }
}

async function loadPopup({
  storedSettings = {},
  autoResolveWrites = false,
  getSettings,
  locationSearch = "",
  tabs = [],
} = {}) {
  const ids = [
    "tab-controls", "tab-filters", "tab-settings",
    "panel-controls", "panel-filters", "panel-settings",
    "blocked-count",
    "blocked-list",
    "add-subreddit",
    "add-current-subreddit",
    "allowed-count",
    "allowed-list",
    "add-allowed-subreddit",
    "add-current-allowed-subreddit",
    "title-keyword-count",
    "title-keyword-list",
    "add-title-keyword",
    "blocked-flair-count",
    "blocked-flair-list",
    "add-blocked-flair",
    "save-indicator",
    "toast",
    "export-config",
    "import-config",
    "import-file",
    "block-homepage",
    "block-popular",
    "block-explore",
    "block-news",
    "block-sub-home",
    "hide-comments",
    "hide-comment-replies",
    "disable-autoplay",
    "hide-suggested-communities",
    "hide-suggested-posts",
    "hide-ads",
    "hide-social-signals",
    "hide-votes",
    "hide-karma",
    "hide-awards",
    "hide-avatars",
    "hide-usernames",
    "hide-navbar",
    "hide-navbar-menu",
    "hide-navbar-search",
    "hide-navbar-chat",
    "hide-navbar-notifications",
    "hide-navbar-profile",
    "hide-navbar-others",
    "hide-left-sidebar",
    "hide-left-sidebar-games",
    "hide-left-sidebar-custom-feeds",
    "hide-left-sidebar-recent",
    "hide-left-sidebar-communities",
    "hide-left-sidebar-resources",
    "hide-right-sidebar",
    "show-block-subreddit-button",
    ...["comments", "navbar", "left-sidebar", "social"].flatMap((group) => [
      `${group}-toggle`, `${group}-options`, `${group}-summary`,
    ]),
    "limit-infinite-scroll",
    "scroll-limit",
    "scroll-mode",
    "color-theme",
    "app-version",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const tabsElements = ["controls", "filters", "settings"].map((name, index) => {
    const tab = elements[`tab-${name}`];
    tab.setAttribute("aria-controls", `panel-${name}`);
    tab.setAttribute("aria-selected", String(index === 0));
    tab.tabIndex = index === 0 ? 0 : -1;
    elements[`panel-${name}`].hidden = index !== 0;
    return tab;
  });
  for (const group of ["comments", "navbar", "left-sidebar", "social"]) {
    elements[`${group}-toggle`].setAttribute("aria-expanded", "false");
    elements[`${group}-options`].hidden = true;
    elements[`${group}-summary`].hidden = true;
  }
  let readyListener;
  const createdElements = [];
  const documentElement = new FakeElement("html");
  const document = {
    addEventListener(type, listener) {
      if (type === "DOMContentLoaded") readyListener = listener;
    },
    createElement: (tagName) => {
      const element = new FakeElement(tagName);
      createdElements.push(element);
      return element;
    },
    createTextNode: () => ({}),
    body: new FakeElement("body"),
    documentElement,
    getElementById: (id) => elements[id],
    querySelectorAll: (selector) => selector === '[role="tab"]' ? tabsElements : [],
  };
  const writes = [];
  const themeCache = new Map();
  let currentSettings = storedSettings;
  const chrome = {
    storage: {
      local: {
        get: () => getSettings ? getSettings() : currentSettings,
        set(settings) {
          const completion = deferred();
          writes.push({ settings, completion });
          if (autoResolveWrites) {
            currentSettings = { ...currentSettings, ...settings };
            completion.resolve();
          }
          return completion.promise;
        },
      },
    },
    runtime: { getManifest: () => ({ version: "9.8.7" }) },
    tabs: { query: async () => tabs },
  };
  const context = vm.createContext({
    Blob,
    URL,
    URLSearchParams,
    chrome,
    console,
    document,
    localStorage: {
      getItem: (key) => themeCache.get(key) ?? null,
      setItem: (key, value) => themeCache.set(key, String(value)),
    },
    location: { search: locationSearch },
    setTimeout,
    clearTimeout,
  });

  for (const file of ["shared/core.js", "popup/popup.js"]) {
    const source = readFileSync(join(__dirname, "..", "..", "src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  readyListener();
  await new Promise((resolve) => setImmediate(resolve));

  return { createdElements, documentElement, elements, themeCache, writes };
}

function getRenderedItems(elements) {
  return elements["blocked-list"].querySelectorAll(".blocked-item");
}

function getRenderedAllowedItems(elements) {
  return elements["allowed-list"].querySelectorAll(".allowed-item");
}

function getRenderedKeywords(elements) {
  return elements["title-keyword-list"].querySelectorAll(".keyword-item");
}

test("shows the extension version from its manifest", async () => {
  const { elements } = await loadPopup();
  assert.equal(elements["app-version"].textContent, "FrontFilter v9.8.7");
});

test("navigates settings tabs with arrows, Home and End without saving configuration", async () => {
  const { elements, writes } = await loadPopup();
  function expectSelected(name) {
    for (const section of ["controls", "filters", "settings"]) {
      const selected = section === name;
      assert.equal(elements[`tab-${section}`].getAttribute("aria-selected"), String(selected));
      assert.equal(elements[`tab-${section}`].tabIndex, selected ? 0 : -1);
      assert.equal(elements[`panel-${section}`].hidden, !selected);
    }
  }
  expectSelected("controls");
  elements["tab-filters"].click();
  expectSelected("filters");
  for (const [from, key, to] of [
    ["filters", "ArrowRight", "settings"],
    ["settings", "ArrowRight", "controls"],
    ["controls", "ArrowLeft", "settings"],
    ["settings", "Home", "controls"],
    ["controls", "End", "settings"],
  ]) {
    let prevented = false;
    elements[`tab-${from}`].dispatch("keydown", { key, preventDefault() { prevented = true; } });
    expectSelected(to);
    assert.equal(prevented, true);
    assert.equal(elements[`tab-${to}`].focused, true);
  }
  elements["tab-settings"].dispatch("keydown", { key: "Tab", preventDefault() { assert.fail("Keep native Tab navigation"); } });
  assert.equal(writes.length, 0);
});

test("retains filter drafts and pending saves when changing tabs", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  elements["tab-filters"].click();
  elements["add-subreddit"].click();
  const input = getRenderedItems(elements)[0].querySelector("input");
  input.value = "Firefox";
  input.dispatch("input");
  elements["tab-settings"].click();
  elements["tab-controls"].click();
  elements["tab-filters"].click();
  assert.equal(getRenderedItems(elements)[0].querySelector("input"), input);
  assert.equal(input.value, "Firefox");
  // Export flushes the pending edit even though it lives in another panel.
  await elements["export-config"].click();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].settings.blockedSubreddits[0].name, "firefox");
  assert.equal(elements["blocked-count"].textContent, "1 rule");
  assert.equal(elements["toast"].textContent, "Configuration exported!");
});

test("serializes popup saves so an older write cannot finish last", async () => {
  const { elements, writes } = await loadPopup();

  elements["block-homepage"].checked = true;
  elements["block-homepage"].dispatch("change");
  elements["block-popular"].checked = true;
  elements["block-popular"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].settings)), {
    blockHomepage: true,
  });

  writes[0].completion.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[1].settings)), {
    blockPopular: true,
  });

  writes[1].completion.resolve();
  await new Promise((resolve) => setImmediate(resolve));
});

test("continues the save queue after an earlier storage write fails", async () => {
  const { elements, writes } = await loadPopup();

  elements["block-homepage"].checked = true;
  elements["block-homepage"].dispatch("change");
  elements["block-popular"].checked = true;
  elements["block-popular"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  writes[0].completion.reject(new Error("storage unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].settings.blockPopular, true);

  writes[1].completion.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["toast"].textContent, "Save failed: storage unavailable");
});

test("does not leave the save indicator in a saving state after a failure", async () => {
  const { elements, writes } = await loadPopup();

  elements["block-homepage"].checked = true;
  elements["block-homepage"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  writes[0].completion.reject(new Error("storage unavailable"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements["save-indicator"].textContent, "Save failed");
  assert.equal(elements["save-indicator"].classList.contains("visible"), true);
});

test("renders stored entries sorted by name with their saved modes", async () => {
  const { elements } = await loadPopup({
    storedSettings: {
      blockedSubreddits: [
        { name: "zeta", mode: "home" },
        { name: "alpha", mode: "all" },
      ],
    },
  });
  const items = getRenderedItems(elements);

  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector("input").value, "alpha");
  assert.equal(items[1].querySelector("input").value, "zeta");
  assert.equal(items[0].children[1].children[0].selected, false);
  assert.equal(items[0].children[1].children[1].selected, true);
});

test("normalizes edited entries and saves their selected mode", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });

  elements["add-subreddit"].click();
  const item = getRenderedItems(elements)[0];
  const input = item.querySelector("input");
  const select = item.children[1];
  assert.equal(input.focused, true);
  assert.equal(writes.length, 0);

  input.value = " https://old.reddit.com/r/Firefox/ ";
  input.dispatch("input");
  input.dispatch("blur");
  select.value = "all";
  select.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(input.value, "firefox");
  assert.equal(writes.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes[1].settings.blockedSubreddits)),
    [{ name: "firefox", mode: "all" }],
  );
});

test("keeps one rule per subreddit, the ALL one when they differ", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: [{ name: "firefox", mode: "home" }] },
    tabs: [{ url: "https://www.reddit.com/r/Firefox/" }],
  });

  // Adding the current subreddit upgrades its HOME rule instead of adding one.
  await elements["add-current-subreddit"].click();
  await new Promise((resolve) => setImmediate(resolve));
  let items = getRenderedItems(elements);
  assert.equal(items.length, 1);
  assert.equal(items[0].children[1].children[1].selected, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedSubreddits)),
    [{ name: "firefox", mode: "all" }],
  );

  // Typing an existing name into a new row merges the two once it is done.
  elements["add-subreddit"].click();
  const input = getRenderedItems(elements)[0].querySelector("input");
  input.value = "r/Firefox";
  input.dispatch("input");
  input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));
  items = getRenderedItems(elements);
  assert.equal(items.length, 1);
  assert.equal(items[0].children[1].children[1].selected, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedSubreddits)),
    [{ name: "firefox", mode: "all" }],
  );
});

test("removes an entry and persists the resulting list", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: {
      blockedSubreddits: [{ name: "firefox", mode: "home" }],
    },
  });

  getRenderedItems(elements)[0].children[2].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getRenderedItems(elements).length, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes[0].settings.blockedSubreddits)),
    [],
  );
});

test("renders, edits and removes exact subreddit exceptions", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: {
      allowedSubreddits: [
        "zeta",
        "ItalyPersonalFinance",
        "ITALYPERSONALFINANCE",
        "*invalid*",
      ],
    },
  });
  let items = getRenderedAllowedItems(elements);

  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector("input").value, "italypersonalfinance");
  assert.equal(items[1].querySelector("input").value, "zeta");
  assert.equal(elements["allowed-count"].textContent, "2 exceptions");

  elements["add-allowed-subreddit"].click();
  items = getRenderedAllowedItems(elements);
  const input = items[0].querySelector("input");
  assert.equal(input.focused, true);
  input.value = " https://www.reddit.com/r/Firefox/ ";
  input.dispatch("input");
  input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(input.value, "firefox");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.allowedSubreddits)),
    ["firefox", "italypersonalfinance", "zeta"],
  );
  assert.equal(elements["allowed-count"].textContent, "3 exceptions");

  input.value = "*fire*";
  input.dispatch("input");
  input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.value, "");
  assert.equal(
    elements["toast"].textContent,
    "Whitelist entries must be exact subreddit names",
  );

  getRenderedAllowedItems(elements)[0].children[1].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.allowedSubreddits)),
    ["italypersonalfinance", "zeta"],
  );
});

test("edits blocked flairs with normalization and a live count", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedFlairs: ["Meme", "meme"] },
  });
  const items = () => elements["blocked-flair-list"].querySelectorAll(".flair-item");
  assert.equal(items().length, 1);
  assert.equal(elements["blocked-flair-count"].textContent, "1 flair");

  elements["add-blocked-flair"].click();
  const input = items()[0].querySelector("input");
  assert.equal(input.focused, true);
  input.value = "  *Politic*  ";
  input.dispatch("input");
  input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.value, "*Politic*");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedFlairs)),
    ["*Politic*", "Meme"],
  );
  assert.equal(elements["blocked-flair-count"].textContent, "2 flairs");

  items().find((item) => item.querySelector("input").value === "Meme").children[1].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedFlairs)),
    ["*Politic*"],
  );
  assert.equal(elements["blocked-flair-count"].textContent, "1 flair");
});

test("renders, edits and removes case-insensitive post keywords", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["zeta", "Trump", "TRUMP"] },
  });
  const { elements, writes } = popup;
  let keywordItems = getRenderedKeywords(elements);

  assert.equal(keywordItems.length, 2);
  assert.equal(keywordItems[0].querySelector("input").value, "Trump");
  assert.equal(keywordItems[1].querySelector("input").value, "zeta");
  assert.equal(elements["title-keyword-count"].textContent, "2 keywords");

  elements["add-title-keyword"].click();
  keywordItems = getRenderedKeywords(elements);
  const input = keywordItems[0].querySelector("input");
  assert.equal(input.focused, true);
  input.value = "  climate   CHANGE ";
  input.dispatch("input");
  input.dispatch("blur");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(input.value, "climate CHANGE");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedTitleKeywords)),
    ["climate CHANGE", "Trump", "zeta"],
  );
  assert.equal(elements["title-keyword-count"].textContent, "3 keywords");

  getRenderedKeywords(elements)[0].children[1].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedTitleKeywords)),
    ["Trump", "zeta"],
  );
});

test("adds the current tab's subreddit and reports non-subreddit tabs", async () => {
  const currentSubreddit = await loadPopup({
    autoResolveWrites: true,
    tabs: [{ url: "https://www.reddit.com/r/Firefox/comments/abc/post" }],
  });

  await currentSubreddit.elements["add-current-subreddit"].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    getRenderedItems(currentSubreddit.elements)[0].querySelector("input").value,
    "firefox",
  );
  assert.equal(currentSubreddit.writes.length, 1);

  await currentSubreddit.elements["add-current-allowed-subreddit"].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    getRenderedAllowedItems(currentSubreddit.elements)[0]
      .querySelector("input").value,
    "firefox",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      currentSubreddit.writes.at(-1).settings.allowedSubreddits,
    )),
    ["firefox"],
  );

  const nonSubreddit = await loadPopup({
    tabs: [{ url: "https://www.reddit.com/" }],
  });
  await nonSubreddit.elements["add-current-subreddit"].click();
  assert.equal(
    nonSubreddit.elements["toast"].textContent,
    "No subreddit found on current tab",
  );
});

test("adds the originating subreddit from standalone blocked-page settings", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    locationSearch: "?standalone=true&currentSubreddit=Firefox",
    tabs: [{ url: "chrome-extension://frontfilter/popup/index.html?standalone=true" }],
  });

  await popup.elements["add-current-subreddit"].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    getRenderedItems(popup.elements)[0].querySelector("input").value,
    "firefox",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(popup.writes.at(-1).settings.blockedSubreddits)),
    [{ name: "firefox", mode: "all" }],
  );
});

test("exports the normalized stored configuration as a JSON download", async () => {
  const { createdElements, elements } = await loadPopup({
    storedSettings: {
      blockAll: true,
      blockNew: true,
      blockTop: true,
      hideRelatedPosts: true,
      disableAutoTranslation: true,
      disableAutoplay: true,
      hideSuggestedCommunities: true,
      hideAds: true,
      blockedSubreddits: ["Firefox"],
      allowedSubreddits: ["ItalyPersonalFinance", "ITALYPERSONALFINANCE"],
      blockedTitleKeywords: [" Trump ", "TRUMP"],
      unknown: true,
    },
  });

  await elements["export-config"].click();
  const link = createdElements.find((element) => element.tagName === "A");

  assert.equal(link.download, "frontfilter-config.json");
  assert.match(link.href, /^blob:/);
  assert.equal(link.clickCount, 1);
  const exported = await fetch(link.href).then((response) => response.json());
  assert.equal(exported.hideRelatedPosts, true);
  assert.equal(exported.disableAutoplay, true);
  assert.equal(exported.hideSuggestedCommunities, true);
  assert.equal(exported.hideAds, true);
  assert.deepEqual(exported.allowedSubreddits, ["italypersonalfinance"]);
  assert.deepEqual(exported.blockedTitleKeywords, ["Trump"]);
  assert.equal(exported.theme, "system");
  assert.equal("disableAutoTranslation" in exported, false);
  assert.equal("blockAll" in exported, false);
  assert.equal("blockNew" in exported, false);
  assert.equal("blockTop" in exported, false);
  assert.equal("unknown" in exported, false);
  assert.equal(elements["toast"].textContent, "Configuration exported!");
});

test("keeps controls disabled after an initial storage read failure", async () => {
  const { elements } = await loadPopup({
    getSettings: async () => {
      throw new Error("storage unavailable");
    },
  });

  assert.equal(elements["toast"].textContent, "Could not load settings: storage unavailable");
  assert.equal(elements["block-homepage"].disabled, true);
  assert.equal(elements["import-config"].disabled, true);
  assert.equal(elements["add-subreddit"].disabled, true);
});

test("makes hiding all comments imply the nested reply toggle", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  const allComments = elements["hide-comments"];
  const replies = elements["hide-comment-replies"];

  assert.equal(replies.checked, false);
  assert.equal(replies.disabled, false);

  allComments.checked = true;
  allComments.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.checked, true);
  assert.equal(replies.disabled, true);
  assert.equal(writes.at(-1).settings.hideCommentReplies, true);

  allComments.checked = false;
  allComments.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.checked, true);
  assert.equal(replies.disabled, false);
  assert.equal(writes.at(-1).settings.hideComments, false);
  assert.equal(writes.at(-1).settings.hideCommentReplies, true);

  replies.checked = false;
  replies.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.at(-1).settings.hideCommentReplies, false);
});

test("makes hiding the navbar imply its indented section toggles", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  const allNavbar = elements["hide-navbar"];
  const sectionIds = [
    "hide-navbar-menu",
    "hide-navbar-search",
    "hide-navbar-chat",
    "hide-navbar-notifications",
    "hide-navbar-profile",
    "hide-navbar-others",
  ];

  for (const id of sectionIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }

  allNavbar.checked = true;
  allNavbar.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, true);
    assert.equal(elements[id].disabled, true);
  }
  assert.equal(writes.at(-1).settings.hideNavbarOthers, true);

  allNavbar.checked = false;
  allNavbar.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }
  assert.equal(writes.at(-1).settings.hideNavbarOthers, false);

  elements[sectionIds[1]].checked = true;
  elements[sectionIds[1]].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    hideNavbarSearch: true,
  });
});

test("collapses grouped sub-options and summarizes the hidden ones", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true,
    storedSettings: { hideNavbarChat: true, hideNavbarProfile: true },
  });
  const toggle = elements["navbar-toggle"];
  const options = elements["navbar-options"];
  const summary = elements["navbar-summary"];

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(options.hidden, true);
  assert.equal(summary.hidden, false);
  assert.equal(summary.textContent, "2 of 6 sections hidden");
  assert.equal(elements["left-sidebar-summary"].hidden, true);

  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(options.hidden, false);
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(options.hidden, true);
  assert.equal(writes.length, 0);

  elements["hide-navbar-search"].checked = true;
  elements["hide-navbar-search"].dispatch("change");
  assert.equal(summary.textContent, "3 of 6 sections hidden");

  elements["hide-navbar"].checked = true;
  elements["hide-navbar"].dispatch("change");
  assert.equal(summary.hidden, true);

  elements["hide-comment-replies"].checked = true;
  elements["hide-comment-replies"].dispatch("change");
  assert.equal(elements["comments-summary"].hidden, false);
  assert.equal(elements["comments-summary"].textContent, "Replies hidden");
});

test("makes hiding votes and user info imply every signal toggle", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true,
    storedSettings: { hideKarma: true, hideAwards: true },
  });
  const signalIds = [
    "hide-votes",
    "hide-karma",
    "hide-awards",
    "hide-avatars",
    "hide-usernames",
  ];
  assert.equal(elements["social-summary"].textContent, "2 of 5 hidden");

  elements["hide-social-signals"].checked = true;
  elements["hide-social-signals"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of signalIds) {
    assert.equal(elements[id].checked, true);
    assert.equal(elements[id].disabled, true);
  }
  assert.equal(elements["social-summary"].hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    hideSocialSignals: true,
    hideVotes: true,
    hideKarma: true,
    hideAwards: true,
    hideAvatars: true,
    hideUsernames: true,
  });

  elements["hide-social-signals"].checked = false;
  elements["hide-social-signals"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of signalIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }

  elements["hide-usernames"].checked = true;
  elements["hide-usernames"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    hideUsernames: true,
  });
  assert.equal(elements["social-summary"].textContent, "1 of 5 hidden");
});

test("makes hiding the left sidebar imply its indented section toggles", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  const allSidebar = elements["hide-left-sidebar"];
  const sectionIds = [
    "hide-left-sidebar-games",
    "hide-left-sidebar-custom-feeds",
    "hide-left-sidebar-recent",
    "hide-left-sidebar-communities",
    "hide-left-sidebar-resources",
  ];

  for (const id of sectionIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }

  allSidebar.checked = true;
  allSidebar.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, true);
    assert.equal(elements[id].disabled, true);
  }
  assert.equal(writes.at(-1).settings.hideLeftSidebarResources, true);

  allSidebar.checked = false;
  allSidebar.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }
  assert.equal(writes.at(-1).settings.hideLeftSidebarResources, false);

  elements[sectionIds[0]].checked = true;
  elements[sectionIds[0]].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    hideLeftSidebarGames: true,
  });
});

test("maps every checkbox to the matching storage setting", async () => {
  const settingByElementId = {
    "block-homepage": "blockHomepage",
    "block-popular": "blockPopular",
    "block-explore": "blockExplore",
    "block-news": "blockNews",
    "block-sub-home": "blockSubHome",
    "hide-comments": "hideComments",
    "hide-comment-replies": "hideCommentReplies",
    "disable-autoplay": "disableAutoplay",
    "hide-suggested-communities": "hideSuggestedCommunities",
    "hide-suggested-posts": "hideSuggestedPosts",
    "hide-ads": "hideAds",
    "hide-social-signals": "hideSocialSignals",
    "hide-votes": "hideVotes",
    "hide-karma": "hideKarma",
    "hide-awards": "hideAwards",
    "hide-avatars": "hideAvatars",
    "hide-usernames": "hideUsernames",
    "hide-navbar": "hideNavbar",
    "hide-navbar-menu": "hideNavbarMenu",
    "hide-navbar-search": "hideNavbarSearch",
    "hide-navbar-chat": "hideNavbarChat",
    "hide-navbar-notifications": "hideNavbarNotifications",
    "hide-navbar-profile": "hideNavbarProfile",
    "hide-navbar-others": "hideNavbarOthers",
    "hide-left-sidebar": "hideLeftSidebar",
    "hide-left-sidebar-games": "hideLeftSidebarGames",
    "hide-left-sidebar-custom-feeds": "hideLeftSidebarCustomFeeds",
    "hide-left-sidebar-recent": "hideLeftSidebarRecent",
    "hide-left-sidebar-communities": "hideLeftSidebarCommunities",
    "hide-left-sidebar-resources": "hideLeftSidebarResources",
    "hide-right-sidebar": "hideRelatedPosts",
    "show-block-subreddit-button": "showBlockSubredditButton",
    "limit-infinite-scroll": "limitInfiniteScroll",
  };
  const storedSettings = Object.fromEntries(
    Object.values(settingByElementId).map((key) => [key, true]),
  );
  const { elements, writes } = await loadPopup({
    storedSettings,
    autoResolveWrites: true,
  });

  for (const elementId of Object.keys(settingByElementId)) {
    assert.equal(elements[elementId].checked, true);
  }

  elements["block-homepage"].checked = false;
  elements["block-homepage"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].settings)), {
    blockHomepage: false,
  });
});

test("saves only changed settings so another open settings page cannot be clobbered", async () => {
  const { elements, writes } = await loadPopup({
    storedSettings: {
      blockPopular: false,
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    },
    autoResolveWrites: true,
  });

  // Another settings page may have changed these values after this page loaded.
  // A local theme edit must not write this page's stale copies back to storage.
  elements["color-theme"].value = "light";
  elements["color-theme"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].settings)), {
    theme: "light",
  });
});

test("follows the system theme by default and persists explicit color modes", async () => {
  const initial = await loadPopup({ autoResolveWrites: true });
  assert.equal(initial.elements["color-theme"].value, "system");
  assert.equal(initial.documentElement.getAttribute("data-theme"), "system");
  assert.equal(initial.themeCache.get("frontfilter-theme"), "system");

  initial.elements["color-theme"].value = "light";
  initial.elements["color-theme"].dispatch("change");
  assert.equal(initial.documentElement.getAttribute("data-theme"), "light");
  assert.equal(initial.themeCache.get("frontfilter-theme"), "light");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initial.writes.at(-1).settings.theme, "light");

  const stored = await loadPopup({ storedSettings: { theme: "dark" } });
  assert.equal(stored.elements["color-theme"].value, "dark");
  assert.equal(stored.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(stored.themeCache.get("frontfilter-theme"), "dark");
});

test("preserves current settings during a partial import", async () => {
  const { elements, writes } = await loadPopup({
    storedSettings: { blockPopular: true },
    autoResolveWrites: true,
  });
  elements["import-file"].files = [{
    text: async () => JSON.stringify({
      blockHomepage: true, hideComments: true, hideNavbar: true, hideRelatedPosts: true,
      blockNsfw: true,
      disableAutoTranslation: true,
      disableAutoplay: true,
      hideSuggestedCommunities: true,
      allowedSubreddits: [" ItalyPersonalFinance "],
      blockedTitleKeywords: ["  Trump  "],
      theme: "light",
    }),
  }];

  elements["import-file"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].settings.blockHomepage, true);
  assert.equal(writes[0].settings.blockPopular, true);
  assert.equal(writes[0].settings.hideComments, true);
  assert.equal(elements["hide-comments"].checked, true);
  assert.equal(writes[0].settings.hideCommentReplies, true);
  assert.equal(elements["hide-comment-replies"].checked, true);
  assert.equal(elements["hide-comment-replies"].disabled, true);
  assert.equal(writes[0].settings.disableAutoplay, true);
  assert.equal(elements["disable-autoplay"].checked, true);
  assert.equal(writes[0].settings.hideSuggestedCommunities, true);
  assert.equal(elements["hide-suggested-communities"].checked, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes[0].settings.blockedTitleKeywords)),
    ["Trump"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes[0].settings.allowedSubreddits)),
    ["italypersonalfinance"],
  );
  assert.equal(
    getRenderedAllowedItems(elements)[0].querySelector("input").value,
    "italypersonalfinance",
  );
  assert.equal(
    getRenderedKeywords(elements)[0].querySelector("input").value,
    "Trump",
  );
  assert.equal(writes[0].settings.theme, "light");
  assert.equal(elements["color-theme"].value, "light");
  assert.equal(writes[0].settings.hideNavbar, true);
  assert.equal(elements["hide-navbar"].checked, true);
  assert.equal(writes[0].settings.hideRelatedPosts, true);
  assert.equal(elements["hide-right-sidebar"].checked, true);
  assert.equal("blockNsfw" in writes[0].settings, false);
  assert.equal("disableAutoTranslation" in writes[0].settings, false);
});

test("rejects imports without recognized configuration keys", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  elements["import-file"].files = [{
    text: async () => JSON.stringify({ unknown: true }),
  }];

  elements["import-file"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 0);
  assert.equal(elements["toast"].textContent, "Invalid config: no recognized keys");
  assert.equal(elements["block-homepage"].disabled, false);
});

test("rejects malformed recognized import values without overwriting settings", async () => {
  const { elements, writes } = await loadPopup({
    storedSettings: { blockHomepage: true },
    autoResolveWrites: true,
  });
  elements["import-file"].files = [{
    text: async () => JSON.stringify({ blockHomepage: "false" }),
  }];

  elements["import-file"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 0);
  assert.equal(elements["block-homepage"].checked, true);
  assert.equal(elements["toast"].textContent, "Invalid config values: blockHomepage");
});

test("disables editing while an import is in progress", async () => {
  const importRead = deferred();
  let readCount = 0;
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    getSettings: async () => {
      readCount += 1;
      if (readCount === 1) return { blockPopular: true };
      if (readCount === 2) return importRead.promise;
      return { blockPopular: true, blockHomepage: true };
    },
  });
  elements["import-file"].files = [{
    text: async () => JSON.stringify({ blockHomepage: true }),
  }];

  elements["import-file"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements["block-sub-home"].disabled, true);
  assert.equal(elements["import-config"].disabled, true);
  assert.equal(elements["color-theme"].disabled, true);
  assert.equal(elements["add-allowed-subreddit"].disabled, true);
  assert.equal(elements["add-title-keyword"].disabled, true);

  importRead.resolve({ blockPopular: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].settings.blockHomepage, true);
  assert.equal(writes[0].settings.blockSubHome, false);
  assert.equal(elements["block-homepage"].checked, true);
  assert.equal(elements["block-sub-home"].disabled, false);
  assert.equal(elements["import-config"].disabled, false);
  assert.equal(elements["color-theme"].disabled, false);
  assert.equal(elements["add-allowed-subreddit"].disabled, false);
  assert.equal(elements["add-title-keyword"].disabled, false);
});

test("loads and saves typed scroll settings and disables dependent controls", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true,
    storedSettings: { limitInfiniteScroll: true, scrollLimit: 7, scrollMode: "button" },
  });
  assert.equal(elements["scroll-limit"].value, "7");
  assert.equal(elements["scroll-mode"].value, "button");
  assert.equal(elements["scroll-limit"].disabled, false);
  elements["scroll-limit"].value = "12";
  elements["scroll-limit"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    scrollLimit: 12,
  });
  elements["scroll-limit"].value = "0";
  elements["scroll-limit"].dispatch("change");
  assert.equal(elements["scroll-limit"].value, "12");
  elements["limit-infinite-scroll"].checked = false;
  elements["limit-infinite-scroll"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["scroll-limit"].disabled, true);
  assert.equal(elements["scroll-mode"].disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    limitInfiniteScroll: false,
  });
});

test("imports typed scroll preferences without dropping unrelated settings", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true,
    storedSettings: { hideComments: true, scrollLimit: 8 },
  });
  elements["import-file"].files = [{ text: async () => JSON.stringify({
    limitInfiniteScroll: true, scrollLimit: 13, scrollMode: "button",
  }) }];
  elements["import-file"].dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.at(-1).settings.hideComments, true);
  assert.equal(writes.at(-1).settings.scrollLimit, 13);
  assert.equal(elements["scroll-mode"].value, "button");
  assert.equal(elements["scroll-limit"].disabled, false);
});
