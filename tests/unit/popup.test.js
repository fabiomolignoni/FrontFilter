const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { deferred, loadPage, runScripts, settle } = require("./helpers");

async function loadPopup({
  storedSettings = {},
  autoResolveWrites = false,
  getSettings,
  locationSearch = "",
  tabs = [],
  cachedTheme = "system",
  // What the background answers to a message.
  sendMessage = async () => ({ success: true }),
} = {}) {
  const page = loadPage("popup/index.html");
  const writes = [];
  const themeCache = new Map([["frontfilter-theme", cachedTheme]]);
  const storageListeners = [];
  let currentSettings = storedSettings;
  // Stores values and, like browsers, reports them to every page.
  function store(settings) {
    const changes = Object.fromEntries(Object.entries(settings).map(([key, newValue]) =>
      [key, { oldValue: currentSettings[key], newValue }]));
    currentSettings = { ...currentSettings, ...settings };
    setImmediate(() => storageListeners.forEach((listener) => listener(changes, "local")));
  }
  const chrome = {
    storage: {
      local: {
        get: () => getSettings ? getSettings() : currentSettings,
        set(settings) {
          const completion = deferred();
          writes.push({ settings, completion });
          if (autoResolveWrites) {
            store(settings);
            completion.resolve();
          }
          return completion.promise;
        },
      },
      onChanged: { addListener: (listener) => storageListeners.push(listener) },
    },
    runtime: {
      getManifest: () => ({ version: "9.8.7" }),
      getURL: (path) => `chrome-extension://frontfilter/${path}`,
      sendMessage: async (message) => {
        sent.push(message);
        return sendMessage(message);
      },
    },
    tabs: {
      query: async () => tabs,
      create: async (properties) => created.push(properties),
    },
  };
  const sent = [];
  const created = [];
  let closed = false;
  const context = vm.createContext({
    Blob,
    URL,
    URLSearchParams,
    chrome,
    console,
    document: page.document,
    localStorage: {
      getItem: (key) => themeCache.get(key) ?? null,
      setItem: (key, value) => themeCache.set(key, String(value)),
    },
    location: { search: locationSearch },
    close: () => { closed = true; },
    setTimeout,
    clearTimeout,
  });

  runScripts(context, ["shared/theme-bootstrap.js", "shared/core.js", "popup/popup.js"]);
  page.ready();
  await settle();

  return {
    get closed() { return closed; },
    createdTabs: created,
    sentMessages: sent,
    createdElements: page.created,
    documentElement: page.document.documentElement,
    elements: page.elements,
    // Changes settings as another page would, and lets this page catch up.
    async storeElsewhere(settings) {
      store(settings);
      await settle();
      await settle();
    },
    themeCache,
    writes,
  };
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

// Imports the file the file picker holds, confirming its review.
async function importChosenFile(elements) {
  elements["import-file"].dispatch("change");
  await settle();
  await settle();
  await elements["import-confirm"].click();
  await settle();
  await settle();
}

// Pastes text in a field, as the browser would at its selection, and
// returns whether the page pasted it instead.
function paste(input, text) {
  let prevented = false;
  input.dispatch("paste", {
    clipboardData: { getData: (type) => (type === "text/plain" ? text : "") },
    preventDefault() { prevented = true; },
  });
  return prevented;
}

test("shows the extension version from its manifest", async () => {
  const { elements } = await loadPopup();
  assert.equal(elements["app-version"].textContent, "FrontFilter v9.8.7");
});

test("opens the settings in a tab, for the same subreddit, after saving what is typed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const popup = await loadPopup({
    autoResolveWrites: true,
    tabs: [{ url: "https://www.reddit.com/r/news/" }],
  });
  const button = popup.elements["open-in-tab"];
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute("aria-label"), "Open settings in a tab");

  // A keyword still being typed is saved first.
  popup.elements["add-title-keyword"].click();
  const input = getRenderedKeywords(popup.elements)[0].querySelector("input");
  input.value = "election";
  input.dispatch("input");
  await button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(popup.writes.at(-1).settings)),
    { blockedTitleKeywords: ["election"] });
  assert.deepEqual(JSON.parse(JSON.stringify(popup.sentMessages)),
    [{ action: "openSettings", currentSubreddit: "news" }]);
  assert.equal(popup.closed, true);
});

test("opens the settings tab itself when the background cannot", async () => {
  const popup = await loadPopup({
    sendMessage: async () => ({ success: false, error: "no tabs" }),
  });
  await popup.elements["open-in-tab"].click();
  assert.deepEqual(JSON.parse(JSON.stringify(popup.createdTabs)),
    [{ url: "chrome-extension://frontfilter/popup/index.html?standalone=true" }]);
  assert.equal(popup.closed, true);
});

test("fills a tab of its own, which it offers no tab to open", async () => {
  // Opened with the query the options page and the block page give it.
  const standalone = await loadPopup({ locationSearch: "?standalone=true" });
  assert.equal(standalone.elements["open-in-tab"].hidden, true);
  assert.equal(standalone.documentElement.querySelector("body").classList.contains("standalone"), true);

  const popup = await loadPopup();
  assert.equal(popup.elements["open-in-tab"].hidden, false);
  assert.equal(popup.documentElement.querySelector("body").classList.contains("standalone"), false);
});

test("navigates settings tabs with arrows, Home and End without saving configuration", async () => {
  const { elements, writes } = await loadPopup();
  function expectSelected(name) {
    for (const section of ["block", "filter", "simplify", "settings"]) {
      const selected = section === name;
      assert.equal(elements[`tab-${section}`].getAttribute("aria-selected"), String(selected));
      assert.equal(elements[`tab-${section}`].tabIndex, selected ? 0 : -1);
      assert.equal(elements[`panel-${section}`].hidden, !selected);
    }
  }
  expectSelected("block");
  elements["tab-filter"].click();
  expectSelected("filter");
  for (const [from, key, to] of [
    ["filter", "ArrowRight", "simplify"],
    ["simplify", "ArrowRight", "settings"],
    ["settings", "ArrowRight", "block"],
    ["block", "ArrowLeft", "settings"],
    ["settings", "Home", "block"],
    ["block", "End", "settings"],
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
  elements["add-subreddit"].click();
  const input = getRenderedItems(elements)[0].querySelector("input");
  input.value = "Firefox";
  input.dispatch("input");
  elements["tab-settings"].click();
  elements["tab-simplify"].click();
  elements["tab-block"].click();
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
  await settle();

  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].settings)), {
    blockHomepage: true,
  });

  writes[0].completion.resolve();
  await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[1].settings)), {
    blockPopular: true,
  });

  writes[1].completion.resolve();
  await settle();
});

test("continues the save queue after an earlier storage write fails", async () => {
  const { elements, writes } = await loadPopup();

  elements["block-homepage"].checked = true;
  elements["block-homepage"].dispatch("change");
  elements["block-popular"].checked = true;
  elements["block-popular"].dispatch("change");
  await settle();

  writes[0].completion.reject(new Error("storage unavailable"));
  await settle();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].settings.blockPopular, true);

  writes[1].completion.resolve();
  await settle();
  assert.equal(elements["toast"].textContent, "Save failed: storage unavailable");
});

test("does not leave the save indicator in a saving state after a failure", async () => {
  const { elements, writes } = await loadPopup();

  elements["block-homepage"].checked = true;
  elements["block-homepage"].dispatch("change");
  assert.equal(elements["save-indicator"].textContent, "Saving…");
  assert.equal(elements["save-indicator"].getAttribute("data-state"), "saving");
  await settle();
  writes[0].completion.reject(new Error("storage unavailable"));
  await settle();

  assert.equal(elements["save-indicator"].textContent, "Save failed");
  assert.equal(elements["save-indicator"].getAttribute("data-state"), "failed");
  assert.equal(elements["save-indicator"].classList.contains("visible"), true);
});

test("shows a save that succeeded as saved", async () => {
  const { elements } = await loadPopup({ autoResolveWrites: true });

  elements["block-homepage"].checked = true;
  elements["block-homepage"].dispatch("change");
  await settle();

  assert.equal(elements["save-indicator"].textContent, "Saved");
  assert.equal(elements["save-indicator"].getAttribute("data-state"), "saved");
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
  // HOME and ALL rules read as Reddit users would put them.
  assert.deepEqual(
    items[0].children[1].children.map((option) => [option.value, option.textContent]),
    [["home", "Front page"], ["all", "Everywhere"]],
  );
  assert.equal(items[0].children[1].getAttribute("aria-label"), "Where to block");
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
  await settle();

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
  await settle();
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
  await settle();
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
  await settle();

  assert.equal(getRenderedItems(elements).length, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes[0].settings.blockedSubreddits)),
    [],
  );
});

test("offers to undo a removal in the removed rule's place, restoring its mode", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: {
      blockedSubreddits: [
        { name: "alpha", mode: "home" },
        { name: "news", mode: "all" },
        { name: "zeta", mode: "home" },
      ],
    },
  });
  const list = elements["blocked-list"];
  const removeButton = (name) => getRenderedItems(elements)
    .find((item) => item.querySelector("input").value === name).children[2];

  removeButton("news").click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings.blockedSubreddits)),
    [{ name: "alpha", mode: "home" }, { name: "zeta", mode: "home" }]);
  assert.equal(elements["blocked-count"].textContent, "2 rules");
  // The undo row stands where the rule was, and takes the focus.
  assert.deepEqual(list.children.map((child) => child.className),
    ["entry blocked-item", "entry-undo", "entry blocked-item"]);
  const undoRow = list.querySelector(".entry-undo");
  assert.equal(undoRow.querySelector(".entry-undo-text").textContent, "Removed “news”");
  const undo = undoRow.querySelector("button");
  assert.equal(undo.getAttribute("aria-label"), "Undo removing “news”");
  assert.equal(undo.focused, true);

  undo.click();
  await settle();
  assert.equal(list.querySelector(".entry-undo"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings.blockedSubreddits)),
    [{ name: "alpha", mode: "home" }, { name: "news", mode: "all" }, { name: "zeta", mode: "home" }]);
  const restored = getRenderedItems(elements)[1];
  assert.equal(restored.querySelector("input").value, "news");
  // Back in its mode: Everywhere.
  assert.equal(restored.children[1].children[1].selected, true);
  assert.equal(restored.children[1].children[0].selected, false);
  assert.equal(restored.querySelector("input").focused, true);
});

test("keeps one undo per list, until the list changes otherwise", async () => {
  const { elements } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["alpha", "beta", "gamma"] },
  });
  const list = elements["title-keyword-list"];
  const remove = (value) => getRenderedKeywords(elements)
    .find((item) => item.querySelector("input").value === value).children[1].click();

  remove("alpha");
  await settle();
  remove("beta");
  await settle();
  // Only the last removal can be undone.
  const undoRows = list.querySelectorAll(".entry-undo");
  assert.equal(undoRows.length, 1);
  assert.equal(undoRows[0].querySelector(".entry-undo-text").textContent, "Removed “beta”");

  // Adding a rule ends the offer.
  elements["add-title-keyword"].click();
  assert.equal(list.querySelectorAll(".entry-undo").length, 0);
});

test("leaves the undo of a list's last rule in place of its empty message", async () => {
  const { elements } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedFlairs: ["Meme"] },
  });
  const list = elements["blocked-flair-list"];
  list.querySelector(".flair-item").children[1].click();
  await settle();
  assert.equal(list.querySelector(".empty-state"), null);
  list.querySelector(".entry-undo button").click();
  await settle();
  assert.equal(list.querySelector(".flair-item input").value, "Meme");
});

test("removes an empty draft without offering to undo it", async () => {
  const { elements } = await loadPopup({ autoResolveWrites: true });
  elements["add-blocked-user"].click();
  elements["blocked-user-list"].querySelector(".user-item").children[1].click();
  await settle();
  assert.equal(elements["blocked-user-list"].querySelector(".entry-undo"), null);
  assert.equal(elements["blocked-user-list"].textContent, "No users blocked yet");
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
  await settle();

  assert.equal(input.value, "firefox");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.allowedSubreddits)),
    ["firefox", "italypersonalfinance", "zeta"],
  );
  assert.equal(elements["allowed-count"].textContent, "3 exceptions");

  input.value = "*fire*";
  input.dispatch("input");
  input.dispatch("blur");
  await settle();
  assert.equal(input.value, "");
  assert.equal(
    elements["toast"].textContent,
    "Allowed subreddits must be exact names, without *",
  );

  getRenderedAllowedItems(elements)[0].children[1].click();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.allowedSubreddits)),
    ["italypersonalfinance", "zeta"],
  );
});

test("blocks users by name, u/name or profile URL, each once", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedUsers: ["Spez", "u/spez", "kn0thing", "not a user"] },
  });
  const items = () => elements["blocked-user-list"].querySelectorAll(".user-item");
  const values = () => items().map((item) => item.querySelector("input").value);
  assert.deepEqual(values(), ["kn0thing", "spez"]);
  assert.equal(elements["blocked-user-count"].textContent, "2 users");

  elements["add-blocked-user"].click();
  const input = items()[0].querySelector("input");
  assert.equal(input.focused, true);
  input.value = " https://www.reddit.com/user/AutoModerator/ ";
  input.dispatch("input");
  input.dispatch("blur");
  await settle();
  assert.equal(input.value, "automoderator");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings)),
    { blockedUsers: ["automoderator", "kn0thing", "spez"] },
  );
  assert.equal(elements["blocked-user-count"].textContent, "3 users");

  // A user added again merges into the existing row.
  elements["add-blocked-user"].click();
  const duplicate = items()[0].querySelector("input");
  duplicate.value = "U/SPEZ";
  duplicate.dispatch("input");
  duplicate.dispatch("blur");
  await settle();
  assert.deepEqual(values(), ["automoderator", "kn0thing", "spez"]);

  items().find((item) => item.querySelector("input").value === "kn0thing").children[1].click();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings)),
    { blockedUsers: ["automoderator", "spez"] },
  );
  assert.equal(elements["blocked-user-count"].textContent, "2 users");
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
  await settle();
  assert.equal(input.value, "*Politic*");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedFlairs)),
    ["*Politic*", "Meme"],
  );
  assert.equal(elements["blocked-flair-count"].textContent, "2 flairs");

  items().find((item) => item.querySelector("input").value === "Meme").children[1].click();
  await settle();
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
  await settle();

  assert.equal(input.value, "climate CHANGE");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedTitleKeywords)),
    ["climate CHANGE", "Trump", "zeta"],
  );
  assert.equal(elements["title-keyword-count"].textContent, "3 keywords");

  getRenderedKeywords(elements)[0].children[1].click();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedTitleKeywords)),
    ["Trump", "zeta"],
  );
});

test("merges keywords that match alike, and keeps regular expressions as written", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["Perché", "/\\d+/"] },
  });
  const values = () => Array.from(getRenderedKeywords(elements), (item) => item.querySelector("input").value);
  const type = async (value) => {
    elements["add-title-keyword"].click();
    const input = getRenderedKeywords(elements)[0].querySelector("input");
    input.value = value;
    input.dispatch("input");
    input.dispatch("blur");
    await settle();
  };

  await type("perche");
  assert.deepEqual(values(), ["/\\d+/", "perche"]);
  await type("/\\D+/");
  assert.deepEqual(values(), ["/\\D+/", "/\\d+/", "perche"]);
  assert.equal(elements["title-keyword-count"].textContent, "3 keywords");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedTitleKeywords)),
    ["/\\D+/", "/\\d+/", "perche"],
  );
});

test("edits allowed keywords as keywords are edited", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { allowedKeywords: ["Biden", "biden"] },
  });
  const items = () => elements["allowed-keyword-list"].querySelectorAll(".allowed-keyword-item");
  assert.equal(items().length, 1);
  assert.equal(elements["allowed-keyword-count"].textContent, "1 exception");

  elements["add-allowed-keyword"].click();
  const input = items()[0].querySelector("input");
  assert.equal(input.focused, true);
  input.value = "  /ukrain(e|ian)/ ";
  input.dispatch("input");
  input.dispatch("blur");
  await settle();
  assert.equal(input.value, "/ukrain(e|ian)/");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    allowedKeywords: ["/ukrain(e|ian)/", "Biden"],
  });
  assert.equal(elements["allowed-keyword-count"].textContent, "2 exceptions");

  items().find((item) => item.querySelector("input").value === "Biden").children[1].click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    allowedKeywords: ["/ukrain(e|ian)/"],
  });
});

test("adds the current tab's subreddit and reports non-subreddit tabs", async () => {
  const currentSubreddit = await loadPopup({
    autoResolveWrites: true,
    tabs: [{ url: "https://www.reddit.com/r/Firefox/comments/abc/post" }],
  });
  // A card names the subreddit, with buttons that block or allow it.
  const card = currentSubreddit.elements["current-subreddit"];
  assert.equal(card.hidden, false);
  assert.equal(currentSubreddit.elements["current-subreddit-name"].textContent, "r/firefox");
  assert.equal(currentSubreddit.elements["current-subreddit-name"].getAttribute("title"), "r/firefox");
  assert.equal(currentSubreddit.elements["add-current-subreddit"].textContent, "Block");
  assert.equal(currentSubreddit.elements["add-current-subreddit"].getAttribute("aria-label"),
    "Block r/firefox");
  assert.equal(currentSubreddit.elements["add-current-allowed-subreddit"].textContent, "Allow");
  assert.equal(currentSubreddit.elements["add-current-allowed-subreddit"].getAttribute("aria-label"),
    "Allow r/firefox");

  await currentSubreddit.elements["add-current-subreddit"].click();
  await settle();
  assert.equal(
    getRenderedItems(currentSubreddit.elements)[0].querySelector("input").value,
    "firefox",
  );
  assert.equal(currentSubreddit.writes.length, 1);
  assert.equal(currentSubreddit.elements["toast"].textContent, "r/firefox blocked everywhere");
  // The rule shows in its list, while the focus stays on the card.
  assert.equal(getRenderedItems(currentSubreddit.elements)[0].querySelector("input").focused, false);

  await currentSubreddit.elements["add-current-allowed-subreddit"].click();
  await settle();
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

  // Outside Reddit, browsers withhold the tab's URL.
  for (const tab of [{ url: "https://www.reddit.com/" }, { id: 7 }]) {
    const nonSubreddit = await loadPopup({ tabs: [tab] });
    // Nothing to add: the card stays hidden.
    assert.equal(nonSubreddit.elements["current-subreddit"].hidden, true);
    await nonSubreddit.elements["add-current-subreddit"].click();
    assert.equal(
      nonSubreddit.elements["toast"].textContent,
      "No subreddit found on current tab",
    );
  }
});

test("tells what the rules do to the current subreddit, and offers only what changes it", async () => {
  const states = [
    [{}, "Not blocked", false, false],
    [{ blockSubHome: true }, "Front page blocked, like every subreddit's", false, false],
    [{ blockedSubreddits: [{ name: "news", mode: "home" }] }, "Front page blocked", false, false],
    [{ blockedSubreddits: [{ name: "new*", mode: "all" }] }, "Blocked everywhere by new*", true, false],
    [{ blockedSubreddits: [{ name: "news", mode: "all" }], allowedSubreddits: ["news"] },
      "Allowed, so it stays open", true, true],
  ];
  for (const [storedSettings, status, blockOff, allowOff] of states) {
    const { elements } = await loadPopup({
      storedSettings, tabs: [{ url: "https://www.reddit.com/r/News/" }],
    });
    assert.equal(elements["current-subreddit-status"].textContent, status);
    assert.equal(elements["add-current-subreddit"].disabled, blockOff, status);
    assert.equal(elements["add-current-allowed-subreddit"].disabled, allowOff, status);
  }

  // Blocking it says so at once, and leaves nothing more to block.
  const { elements } = await loadPopup({
    autoResolveWrites: true, tabs: [{ url: "https://www.reddit.com/r/news/" }],
  });
  await elements["add-current-subreddit"].click();
  assert.equal(elements["current-subreddit-status"].textContent, "Blocked everywhere");
  assert.equal(elements["add-current-subreddit"].disabled, true);
  assert.equal(elements["add-current-allowed-subreddit"].disabled, false);
});

test("labels every list's Add button alike, and names each for its list", async () => {
  const { elements } = await loadPopup();
  const names = [
    ["add-subreddit", "Add a blocked subreddit"],
    ["add-allowed-subreddit", "Add an allowed subreddit"],
    ["add-blocked-user", "Add a blocked user"],
    ["add-title-keyword", "Add a keyword"],
    ["add-allowed-keyword", "Add an allowed keyword"],
    ["add-blocked-flair", "Add a flair"],
  ];
  for (const [id, name] of names) {
    assert.equal(elements[id].textContent.trim(), "Add", id);
    // The visible label starts the accessible name.
    assert.equal(elements[id].getAttribute("aria-label"), name);
    assert.ok(name.startsWith("Add "));
  }
});

test("adds the originating subreddit from standalone blocked-page settings", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    locationSearch: "?standalone=true&currentSubreddit=Firefox",
    tabs: [{ url: "chrome-extension://frontfilter/popup/index.html?standalone=true" }],
  });

  await popup.elements["add-current-subreddit"].click();
  await settle();

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
  assert.equal(exported.settingsVersion, 2);
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

test("makes hiding all comments imply the nested reply toggle and turn it off with it", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  const allComments = elements["hide-comments"];
  const replies = elements["hide-comment-replies"];

  assert.equal(replies.checked, false);
  assert.equal(replies.disabled, false);

  allComments.checked = true;
  allComments.dispatch("change");
  await settle();
  assert.equal(replies.checked, true);
  assert.equal(replies.disabled, true);
  assert.equal(writes.at(-1).settings.hideCommentReplies, true);

  allComments.checked = false;
  allComments.dispatch("change");
  await settle();
  assert.equal(replies.checked, false);
  assert.equal(replies.disabled, false);
  assert.equal(allComments.indeterminate, false);
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    hideComments: false,
    hideCommentReplies: false,
  });

  replies.checked = true;
  replies.dispatch("change");
  await settle();
  assert.equal(writes.at(-1).settings.hideCommentReplies, true);
  assert.equal(allComments.indeterminate, true);
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
  await settle();
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, true);
    assert.equal(elements[id].disabled, true);
  }
  assert.equal(writes.at(-1).settings.hideNavbarOthers, true);

  allNavbar.checked = false;
  allNavbar.dispatch("change");
  await settle();
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }
  assert.equal(writes.at(-1).settings.hideNavbarOthers, false);

  elements[sectionIds[1]].checked = true;
  elements[sectionIds[1]].dispatch("change");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    hideNavbarSearch: true,
  });
});

test("collapses grouped sub-options and shows partly hidden groups as mixed", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true,
    storedSettings: { hideNavbarChat: true, hideNavbarProfile: true },
  });
  const toggle = elements["navbar-toggle"];
  const options = elements["navbar-options"];
  const navbar = elements["hide-navbar"];

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(options.hidden, true);
  assert.equal(navbar.checked, false);
  assert.equal(navbar.indeterminate, true);
  assert.equal(elements["hide-left-sidebar"].indeterminate, false);

  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(options.hidden, false);
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(options.hidden, true);
  assert.equal(writes.length, 0);

  // A mixed group turns fully on when clicked, then fully off.
  navbar.checked = true;
  navbar.dispatch("change");
  assert.equal(navbar.indeterminate, false);
  navbar.checked = false;
  navbar.dispatch("change");
  assert.equal(navbar.indeterminate, false);
  assert.equal(elements["hide-navbar-chat"].checked, false);

  elements["hide-navbar-search"].checked = true;
  elements["hide-navbar-search"].dispatch("change");
  assert.equal(navbar.indeterminate, true);
  elements["hide-navbar-search"].checked = false;
  elements["hide-navbar-search"].dispatch("change");
  assert.equal(navbar.indeterminate, false);
});

test("shows each help text from its ? button without saving settings", async () => {
  const { documentElement, elements, writes } = await loadPopup({ autoResolveWrites: true });
  const toggles = documentElement.querySelectorAll(".help-toggle");
  assert.ok(toggles.length > 0);

  for (const toggle of toggles) {
    const helpId = toggle.getAttribute("aria-controls");
    const help = elements[helpId];
    assert.ok(help?.classList.contains("help-text"), helpId);
    assert.ok(toggle.getAttribute("aria-label"), helpId);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(help.hidden, true);

    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(help.hidden, false);
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(help.hidden, true);
  }
  assert.equal(writes.length, 0);
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
  assert.equal(elements["hide-social-signals"].indeterminate, true);

  elements["hide-social-signals"].checked = true;
  elements["hide-social-signals"].dispatch("change");
  await settle();
  for (const id of signalIds) {
    assert.equal(elements[id].checked, true);
    assert.equal(elements[id].disabled, true);
  }
  assert.equal(elements["hide-social-signals"].indeterminate, false);
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
  await settle();
  for (const id of signalIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }

  elements["hide-usernames"].checked = true;
  elements["hide-usernames"].dispatch("change");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    hideUsernames: true,
  });
  assert.equal(elements["hide-social-signals"].indeterminate, true);
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
  await settle();
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, true);
    assert.equal(elements[id].disabled, true);
  }
  assert.equal(writes.at(-1).settings.hideLeftSidebarResources, true);

  allSidebar.checked = false;
  allSidebar.dispatch("change");
  await settle();
  for (const id of sectionIds) {
    assert.equal(elements[id].checked, false);
    assert.equal(elements[id].disabled, false);
  }
  assert.equal(writes.at(-1).settings.hideLeftSidebarResources, false);

  elements[sectionIds[0]].checked = true;
  elements[sectionIds[0]].dispatch("change");
  await settle();
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
    "hide-nsfw": "hideNsfw",
    "hide-spoilers": "hideSpoilers",
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
    "hide-block-page-settings-button": "hideBlockPageSettingsButton",
    "redirect-blocked-pages": "redirectBlockedPages",
    "limit-infinite-scroll": "limitInfiniteScroll",
    "limit-comments": "limitComments",
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
  await settle();

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
  await settle();

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
  await settle();
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

  await importChosenFile(elements);

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
  // A file without a settings version is from before keywords matched whole
  // words: its keywords keep matching inside words.
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes[0].settings.blockedTitleKeywords)),
    ["*Trump*"],
  );
  assert.equal(writes[0].settings.settingsVersion, 2);
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
    "*Trump*",
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

test("imports keywords as the version that exported them wrote them", async () => {
  const importKeywords = async (file, storedSettings = {}) => {
    const { elements, writes } = await loadPopup({ autoResolveWrites: true, storedSettings });
    elements["import-file"].files = [{ text: async () => JSON.stringify(file) }];
    await importChosenFile(elements);
    return JSON.parse(JSON.stringify(writes[0].settings));
  };

  const current = await importKeywords({
    settingsVersion: 2,
    blockedTitleKeywords: ["ai", "spoiler*"],
    allowedKeywords: ["biden"],
  });
  assert.deepEqual(current.blockedTitleKeywords, ["ai", "spoiler*"]);
  assert.deepEqual(current.allowedKeywords, ["biden"]);
  assert.equal(current.settingsVersion, 2);

  // Earlier files, whose keywords between slashes or with stars were text,
  // and which never had allowed keywords.
  const legacy = await importKeywords({
    blockedTitleKeywords: ["ai", "/r/", "*", "f*ck", "/(/"],
    allowedKeywords: ["biden"],
  });
  assert.deepEqual(
    legacy.blockedTitleKeywords,
    ["*ai*", "/\\/r\\//", "/\\*/", "*f*ck*", "/\\/\\(\\//"],
  );
  assert.deepEqual(legacy.allowedKeywords, ["biden"]);

  // Stored keywords not yet upgraded are upgraded with a partial import.
  const partial = await importKeywords({ settingsVersion: 2, blockPopular: true }, {
    blockedTitleKeywords: ["ai"],
  });
  assert.deepEqual(partial.blockedTitleKeywords, ["*ai*"]);
  const upgraded = await importKeywords({ settingsVersion: 2, blockPopular: true }, {
    blockedTitleKeywords: ["ai"],
    settingsVersion: 2,
  });
  assert.deepEqual(upgraded.blockedTitleKeywords, ["ai"]);
});

test("shows what an import would change, and changes nothing until it is confirmed", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: {
      blockPopular: true,
      blockedSubreddits: ["a", "b", "c"].map((name) => ({ name, mode: "all" })),
    },
  });
  elements["import-file"].files = [{ text: async () => JSON.stringify({
    blockPopular: true,
    blockHomepage: true,
    theme: "light",
    blockedSubreddits: [{ name: "news", mode: "all" }, { name: "pics", mode: "home" }],
    blockedTitleKeywords: ["ai", "nft"],
    blockedFlairs: [],
  }) }];
  elements["import-file"].dispatch("change");
  await settle();
  await settle();

  const review = elements["import-review"];
  assert.equal(review.hidden, false);
  assert.equal(elements["import-review-title"].textContent, "Import this file?");
  assert.equal(elements["import-review-title"].focused, true);
  // Lists that the file leaves as they are, as blockPopular, go unmentioned.
  assert.deepEqual(
    elements["import-review-changes"].children.map((item) => item.textContent),
    ["Blocked subreddits: 3 → 2 rules", "Keywords: 0 → 2 keywords", "2 other settings"],
  );
  assert.equal(writes.length, 0);

  elements["import-cancel"].click();
  await settle();
  assert.equal(review.hidden, true);
  assert.equal(elements["import-config"].focused, true);
  assert.equal(writes.length, 0);
  // A cancelled import cannot be confirmed later.
  await elements["import-confirm"].click();
  assert.equal(writes.length, 0);
});

test("says when a file matches the settings, with nothing to import", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedFlairs: ["Meme", "News"] },
  });
  elements["import-file"].files = [{ text: async () => JSON.stringify({
    blockedFlairs: ["News", "Meme"],
  }) }];
  elements["import-file"].dispatch("change");
  await settle();
  await settle();
  assert.equal(elements["import-review-title"].textContent, "This file matches your settings");
  assert.equal(elements["import-confirm"].hidden, true);
  assert.equal(elements["import-cancel"].textContent, "Close");
  assert.equal(writes.length, 0);
});

test("keeps the settings an import replaces, and restores them, undoably", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockHomepage: true, blockedFlairs: ["Meme"], settingsVersion: 2 },
  });
  assert.equal(elements["backup-restore"].hidden, true);
  elements["import-file"].files = [{ text: async () => JSON.stringify({
    settingsVersion: 2, blockHomepage: false, blockedFlairs: ["Politics"],
  }) }];
  await importChosenFile(elements);

  // One write holds the import and the settings it replaced.
  assert.equal(writes.length, 1);
  const { importBackup } = writes[0].settings;
  assert.equal(importBackup.replacedBy, "import");
  assert.equal(importBackup.settings.blockHomepage, true);
  assert.deepEqual(JSON.parse(JSON.stringify(importBackup.settings.blockedFlairs)), ["Meme"]);
  assert.equal(elements["block-homepage"].checked, false);
  assert.equal(elements["backup-restore"].hidden, false);
  assert.match(elements["backup-restore-text"].textContent, /^Your settings before your import of .*\d/);

  await elements["restore-backup"].click();
  await settle();
  await settle();
  assert.equal(elements["toast"].textContent, "Settings restored");
  assert.equal(elements["block-homepage"].checked, true);
  assert.equal(elements["blocked-flair-list"].querySelector(".flair-item input").value, "Meme");
  // The restore keeps what it replaced in turn.
  const swapped = writes.at(-1).settings.importBackup;
  assert.equal(swapped.replacedBy, "restore");
  assert.equal(swapped.settings.blockHomepage, false);
  assert.deepEqual(JSON.parse(JSON.stringify(swapped.settings.blockedFlairs)), ["Politics"]);
  assert.match(elements["backup-restore-text"].textContent, /before your restore of/);

  // Exports never include the backup.
  await elements["export-config"].click();
  assert.equal(elements["toast"].textContent, "Configuration exported!");
});

test("rejects imports without recognized configuration keys", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  elements["import-file"].files = [{
    text: async () => JSON.stringify({ unknown: true }),
  }];

  elements["import-file"].dispatch("change");
  await settle();

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
  await settle();

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
      // The page's first read, then the review's, then the import's.
      if (readCount <= 2) return { blockPopular: true };
      if (readCount === 3) return importRead.promise;
      return { blockPopular: true, blockHomepage: true };
    },
  });
  elements["import-file"].files = [{
    text: async () => JSON.stringify({ blockHomepage: true }),
  }];

  elements["import-file"].dispatch("change");
  await settle();
  await settle();
  // The review leaves the page as it is.
  assert.equal(elements["import-review"].hidden, false);
  assert.equal(elements["block-sub-home"].disabled, false);
  elements["import-confirm"].click();
  await settle();

  assert.equal(elements["block-sub-home"].disabled, true);
  assert.equal(elements["import-config"].disabled, true);
  assert.equal(elements["color-theme"].disabled, true);
  assert.equal(elements["add-allowed-subreddit"].disabled, true);
  assert.equal(elements["add-title-keyword"].disabled, true);

  importRead.resolve({ blockPopular: true });
  await settle();
  await settle();

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
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    scrollLimit: 12,
  });
  elements["scroll-limit"].value = "0";
  elements["scroll-limit"].dispatch("change");
  assert.equal(elements["scroll-limit"].value, "12");
  elements["limit-infinite-scroll"].checked = false;
  elements["limit-infinite-scroll"].dispatch("change");
  await settle();
  assert.equal(elements["scroll-limit"].disabled, true);
  assert.equal(elements["scroll-mode"].disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    limitInfiniteScroll: false,
  });
});

test("loads and saves the comment limit apart from the scroll limit", async () => {
  const { elements, storeElsewhere, writes } = await loadPopup({ autoResolveWrites: true });
  const saved = () => JSON.parse(JSON.stringify(writes.at(-1).settings));
  const count = elements["comment-limit"];
  const mode = elements["comment-limit-mode"];
  assert.equal(count.value, "10");
  assert.equal(mode.value, "fixed");
  assert.equal(count.disabled, true);
  assert.equal(mode.disabled, true);

  elements["limit-comments"].checked = true;
  elements["limit-comments"].dispatch("change");
  await settle();
  assert.deepEqual(saved(), { limitComments: true });
  assert.equal(count.disabled, false);
  assert.equal(mode.disabled, false);
  assert.equal(elements["scroll-limit"].disabled, true);

  count.value = "5";
  count.dispatch("change");
  await settle();
  assert.deepEqual(saved(), { commentLimit: 5 });
  mode.value = "button";
  mode.dispatch("change");
  await settle();
  assert.deepEqual(saved(), { commentLimitMode: "button" });

  count.value = "2.5";
  count.dispatch("change");
  assert.equal(count.value, "5");
  assert.equal(elements["toast"].textContent, "Enter a positive whole number of comments");
  assert.equal(writes.length, 3);

  await storeElsewhere({ commentLimit: 20, commentLimitMode: "fixed", scrollLimit: 40 });
  assert.equal(count.value, "20");
  assert.equal(mode.value, "fixed");
  assert.equal(elements["scroll-limit"].value, "40");
});

test("saves the website for blocked pages, shown only while its switch is on", async () => {
  // Hidden in the markup, so it never shows before the settings load.
  assert.equal(loadPage("popup/index.html").elements["redirect-url-option"].hidden, true);

  const { elements, storeElsewhere, writes } = await loadPopup({ autoResolveWrites: true });
  const address = elements["redirect-url"];
  const option = elements["redirect-url-option"];
  const saved = () => JSON.parse(JSON.stringify(writes.at(-1).settings));
  assert.ok(elements["panel-block"].querySelector("#redirect-url"));
  assert.equal(address.value, "");
  assert.equal(option.hidden, true);

  elements["redirect-blocked-pages"].checked = true;
  elements["redirect-blocked-pages"].dispatch("change");
  await settle();
  assert.equal(option.hidden, false);
  assert.equal(address.disabled, false);
  assert.deepEqual(saved(), { redirectBlockedPages: true });

  // It is saved, and shown, with its scheme.
  address.value = " example.com/focus ";
  address.dispatch("change");
  await settle();
  assert.equal(address.value, "https://example.com/focus");
  assert.deepEqual(saved(), { redirectUrl: "https://example.com/focus" });

  // An address that is not a website is explained and undone.
  address.value = "javascript:alert(1)";
  address.dispatch("change");
  assert.equal(address.value, "https://example.com/focus");
  assert.equal(elements["toast"].textContent, "Enter a website address, such as example.com");
  assert.equal(writes.length, 2);

  // So that blocked pages show the block page again.
  address.value = "";
  address.dispatch("change");
  await settle();
  assert.deepEqual(saved(), { redirectUrl: "" });

  await storeElsewhere({ redirectUrl: "https://example.org/" });
  assert.equal(address.value, "https://example.org/");
  // Turned off, the address stays saved for when it is turned on again.
  elements["redirect-blocked-pages"].checked = false;
  elements["redirect-blocked-pages"].dispatch("change");
  await settle();
  assert.equal(option.hidden, true);
  assert.deepEqual(saved(), { redirectBlockedPages: false });
  assert.equal(address.value, "https://example.org/");

  // A switch turned on elsewhere shows it too.
  await storeElsewhere({ redirectBlockedPages: true });
  assert.equal(option.hidden, false);
});

test("imports typed scroll preferences without dropping unrelated settings", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true,
    storedSettings: { hideComments: true, scrollLimit: 8 },
  });
  elements["import-file"].files = [{ text: async () => JSON.stringify({
    limitInfiniteScroll: true, scrollLimit: 13, scrollMode: "button",
  }) }];
  await importChosenFile(elements);
  assert.equal(writes.at(-1).settings.hideComments, true);
  assert.equal(writes.at(-1).settings.scrollLimit, 13);
  assert.equal(elements["scroll-mode"].value, "button");
  assert.equal(elements["scroll-limit"].disabled, false);
});

test("saves typed text once typing pauses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  elements["add-title-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  input.value = "spoilers";
  input.dispatch("input");
  t.mock.timers.tick(699);
  await settle();
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].settings)), {
    blockedTitleKeywords: ["spoilers"],
  });
});

test("explains entries that cannot be used, and clears them", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  for (const [addId, list, value, message] of [
    ["add-subreddit", "blocked-list", "not a subreddit!", "Enter a subreddit name, a pattern with *, or a Reddit URL"],
    ["add-blocked-user", "blocked-user-list", "r/firefox", "Enter a username, such as u/name, or a profile URL"],
    ["add-blocked-flair", "blocked-flair-list", "x".repeat(101), "Flairs can be at most 100 characters long"],
    ["add-title-keyword", "title-keyword-list", "/(unclosed/", "Enter a keyword, or a valid regular expression between slashes"],
    ["add-allowed-keyword", "allowed-keyword-list", "/[a/", "Enter a keyword, or a valid regular expression between slashes"],
  ]) {
    elements[addId].click();
    const input = elements[list].querySelector("input");
    input.value = value;
    input.dispatch("input");
    input.dispatch("blur");
    await settle();
    assert.equal(input.value, "");
    assert.equal(elements["toast"].textContent, message);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), { allowedKeywords: [] });
});

test("merges a row into an earlier one for the same rule", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["Spoilers"] },
  });
  elements["add-title-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  input.value = "SPOILERS";
  input.dispatch("input");
  input.dispatch("blur");
  await settle();

  const items = getRenderedKeywords(elements);
  assert.equal(items.length, 1);
  assert.equal(items[0].querySelector("input").focused, true);
  assert.equal(elements["title-keyword-count"].textContent, "1 keyword");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: ["SPOILERS"],
  });
});

test("adds a row for each entry of a pasted list, merging those already there", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: [{ name: "news", mode: "home" }] },
  });
  elements["add-subreddit"].click();
  const input = getRenderedItems(elements)[0].querySelector("input");
  assert.equal(paste(input, "r/Firefox\nNews, https://www.reddit.com/r/AskReddit/top\r\nnot valid!,firefox,"), true);
  await settle();

  const items = getRenderedItems(elements);
  assert.deepEqual(items.map((item) => item.querySelector("input").value), ["askreddit", "firefox", "news"]);
  // New rows are in ALL mode, as the row they were pasted in, which wins over HOME.
  assert.deepEqual(items.map((item) => item.children[1].children[1].selected), [true, true, true]);
  assert.deepEqual(items.map((item) => item.classList.contains("pop-in")), [true, true, true]);
  assert.equal(items[0].querySelector("input").focused, true);
  assert.equal(elements["blocked-count"].textContent, "3 rules");
  assert.equal(elements["toast"].textContent, "Added 2 rules; 1 entry could not be used");
  assert.equal(elements["toast"].className, "show error");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [
      { name: "askreddit", mode: "all" },
      { name: "firefox", mode: "all" },
      { name: "news", mode: "all" },
    ],
  });

  // The row the list replaced leaves the page without saving again.
  const writeCount = writes.length;
  input.value = "not valid!";
  input.dispatch("blur");
  await settle();
  assert.equal(writes.length, writeCount);
  assert.equal(elements["toast"].textContent, "Added 2 rules; 1 entry could not be used");
});

test("pastes a list in the row's mode, with what the row holds around it", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  elements["add-subreddit"].click();
  const item = getRenderedItems(elements)[0];
  const input = item.querySelector("input");
  const select = item.children[1];
  select.value = "home";
  select.dispatch("change");
  input.value = "fire pics";
  input.dispatch("input");
  Object.assign(input, { selectionStart: 4, selectionEnd: 5 });
  assert.equal(paste(input, "fox, funny\n"), true);
  await settle();

  const items = getRenderedItems(elements);
  assert.deepEqual(items.map((row) => row.querySelector("input").value), ["firefox", "funny", "pics"]);
  assert.deepEqual(items.map((row) => row.children[1].children[0].selected), [true, true, true]);
  assert.equal(elements["toast"].textContent, "Added 3 rules");
  assert.equal(elements["toast"].className, "show success");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [
      { name: "firefox", mode: "home" },
      { name: "funny", mode: "home" },
      { name: "pics", mode: "home" },
    ],
  });
});

test("pastes a single entry as usual, and keeps the row if no entry can be used", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  const items = () => elements["blocked-user-list"].querySelectorAll(".user-item");
  elements["add-blocked-user"].click();
  const input = items()[0].querySelector("input");
  assert.equal(paste(input, " u/spez, \n"), false);
  assert.equal(paste(input, "r/firefox, not a user!"), true);
  await settle();
  assert.equal(items().length, 1);
  assert.equal(items()[0].querySelector("input"), input);
  assert.equal(elements["toast"].textContent, "Enter a username, such as u/name, or a profile URL");
  assert.equal(writes.length, 0);

  assert.equal(paste(input, "u/spez\nhttps://www.reddit.com/user/kn0thing/, r/firefox"), true);
  await settle();
  assert.deepEqual(items().map((item) => item.querySelector("input").value), ["kn0thing", "spez"]);
  assert.equal(elements["toast"].textContent, "Added 2 users; 1 entry could not be used");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedUsers: ["kn0thing", "spez"],
  });
});

test("pastes keyword lists without splitting regular expressions", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["perche"], blockedFlairs: ["Meme"] },
  });
  elements["add-title-keyword"].click();
  assert.equal(paste(getRenderedKeywords(elements)[0].querySelector("input"), "/a{1,3}/, spoiler*\nPerché"), true);
  await settle();
  assert.deepEqual(
    getRenderedKeywords(elements).map((item) => item.querySelector("input").value),
    ["/a{1,3}/", "Perché", "spoiler*"],
  );
  assert.equal(elements["toast"].textContent, "Added 2 keywords");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: ["/a{1,3}/", "Perché", "spoiler*"],
  });

  // Only keywords keep commas between slashes; a list of rules already there adds none.
  const flairs = () => elements["blocked-flair-list"].querySelectorAll(".flair-item");
  elements["add-blocked-flair"].click();
  assert.equal(paste(flairs()[0].querySelector("input"), "meme, MEME"), true);
  await settle();
  assert.deepEqual(flairs().map((item) => item.querySelector("input").value), ["meme"]);
  assert.equal(elements["toast"].textContent, "No new flairs");
  assert.equal(elements["toast"].className, "show info");
});

test("tells empty lists apart and counts their rules", async () => {
  const { elements } = await loadPopup({ storedSettings: { blockedFlairs: ["Meme"] } });
  assert.equal(elements["blocked-list"].textContent, "No subreddits blocked yet");
  assert.equal(elements["blocked-count"].textContent, "0 rules");
  assert.equal(elements["allowed-list"].textContent, "No subreddit exceptions yet");
  assert.equal(elements["blocked-user-list"].textContent, "No users blocked yet");
  assert.equal(elements["blocked-user-count"].textContent, "0 users");
  assert.equal(elements["title-keyword-list"].textContent, "No keywords filtered yet");
  assert.equal(elements["allowed-keyword-list"].textContent, "No keyword exceptions yet");
  assert.equal(elements["allowed-keyword-count"].textContent, "0 exceptions");
  assert.equal(elements["blocked-flair-count"].textContent, "1 flair");
});

// The rows a list shows, by their rule.
function shownValues(list) {
  return list.querySelectorAll(".entry")
    .filter((item) => !item.hidden)
    .map((item) => item.querySelector("input").value);
}

// The search field and the footer button that come with a list.
function listTools(elements, listId) {
  const card = elements[listId].parentElement;
  return {
    tools: card.querySelector(".list-tools"),
    search: card.querySelector(".list-search"),
    more: card.querySelector(".list-more"),
    noMatch: card.querySelector(".list-no-match"),
  };
}

test("shows short lists in full, without a search or a Show all button", async () => {
  const flairs = Array.from({ length: 8 }, (_, index) => `Flair ${index}`);
  const { elements } = await loadPopup({ storedSettings: { blockedFlairs: flairs } });
  const { tools, more } = listTools(elements, "blocked-flair-list");
  assert.equal(shownValues(elements["blocked-flair-list"]).length, 8);
  assert.equal(tools.hidden, true);
  assert.equal(more.hidden, true);
});

test("folds a long list to its first rules, and shows it all on request", async () => {
  const keywords = Array.from({ length: 30 }, (_, index) => `keyword ${String(index).padStart(2, "0")}`);
  const { elements, writes } = await loadPopup({ storedSettings: { blockedTitleKeywords: keywords } });
  const list = elements["title-keyword-list"];
  const { tools, more } = listTools(elements, "title-keyword-list");
  // Every rule is still in the list, so edits and saves see them all.
  assert.equal(getRenderedKeywords(elements).length, 30);
  assert.deepEqual(shownValues(list), keywords.slice(0, 6));
  assert.equal(tools.hidden, false);
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, "Show all 30");
  assert.equal(more.getAttribute("aria-expanded"), "false");

  more.click();
  assert.equal(shownValues(list).length, 30);
  assert.equal(more.textContent, "Show fewer");
  assert.equal(more.getAttribute("aria-expanded"), "true");
  more.click();
  assert.equal(shownValues(list).length, 6);
  assert.equal(writes.length, 0);
});

test("searches a long list ignoring case and accents, and says when nothing matches", async () => {
  const subreddits = Array.from({ length: 20 }, (_, index) => ({ name: `sub${index}`, mode: "home" }));
  subreddits.push({ name: "news", mode: "all" }, { name: "worldnews", mode: "home" });
  const { elements, writes } = await loadPopup({ storedSettings: { blockedSubreddits: subreddits } });
  const list = elements["blocked-list"];
  const { search, more, noMatch } = listTools(elements, "blocked-list");
  assert.equal(search.getAttribute("aria-label"), "Search blocked subreddits");

  search.value = "NÉWS";
  search.dispatch("input");
  assert.deepEqual(shownValues(list), ["news", "worldnews"]);
  assert.equal(more.hidden, true);
  assert.equal(noMatch.hidden, true);

  search.value = "politics";
  search.dispatch("input");
  assert.deepEqual(shownValues(list), []);
  assert.equal(noMatch.hidden, false);
  assert.equal(noMatch.textContent, "No rules match “politics”");

  // Escape clears the search, and keeps the popup open.
  let prevented = false;
  search.dispatch("keydown", { key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(search.value, "");
  assert.equal(shownValues(list).length, 6);
  assert.equal(writes.length, 0);
});

test("keeps rules just added or merged in view, however the list folds", async () => {
  const subreddits = Array.from({ length: 20 }, (_, index) => ({ name: `sub${String(index).padStart(2, "0")}`, mode: "home" }));
  const { elements } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: subreddits },
    tabs: [{ url: "https://www.reddit.com/r/zebra/" }],
  });
  const list = elements["blocked-list"];
  const { search } = listTools(elements, "blocked-list");

  // A new draft shows at the top, even while a search hides other rows.
  search.value = "sub0";
  search.dispatch("input");
  elements["add-subreddit"].click();
  const draft = getRenderedItems(elements)[0];
  assert.equal(draft.hidden, false);
  assert.equal(draft.querySelector("input").focused, true);

  // Typing a rule that is folded away merges into it, which then shows,
  // and the search that would hide it is cleared.
  const input = draft.querySelector("input");
  input.value = "sub17";
  input.dispatch("input");
  input.dispatch("blur");
  await settle();
  assert.equal(search.value, "");
  const merged = getRenderedItems(elements).find((item) => item.querySelector("input").value === "sub17");
  assert.equal(merged.hidden, false);
  assert.equal(merged.querySelector("input").focused, true);

  // So does a subreddit added from the current tab, sorted after the fold.
  await elements["add-current-subreddit"].click();
  await settle();
  assert.ok(shownValues(list).includes("zebra"));
  assert.ok(shownValues(list).includes("sub17"));
  assert.equal(shownValues(list).length, 8);
});

test("shows the rules of a pasted list, wherever they sort", async () => {
  const keywords = Array.from({ length: 20 }, (_, index) => `a${String(index).padStart(2, "0")}`);
  const { elements } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: keywords },
  });
  elements["add-title-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  assert.equal(paste(input, "zeta\nyankee"), true);
  await settle();
  const shown = shownValues(elements["title-keyword-list"]);
  assert.ok(shown.includes("zeta") && shown.includes("yankee"), shown.join());
});

test("tells how much of a mixed group is hidden, and nothing otherwise", async () => {
  const { documentElement, elements } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { hideNavbarChat: true, hideNavbarProfile: true, hideCommentReplies: true },
  });
  const summary = (group) => documentElement.querySelector(`[data-group="${group}"]`).textContent;
  assert.equal(summary("hideNavbar"), "2 of 6 hidden");
  assert.equal(summary("hideComments"), "Only replies hidden");
  assert.equal(summary("hideLeftSidebar"), "");
  assert.equal(summary("hideSocialSignals"), "");

  // A group that is fully on, or fully off, says so with its switch alone.
  elements["hide-navbar"].checked = true;
  elements["hide-navbar"].dispatch("change");
  assert.equal(summary("hideNavbar"), "");
  elements["hide-navbar"].checked = false;
  elements["hide-navbar"].dispatch("change");
  assert.equal(summary("hideNavbar"), "");

  elements["hide-left-sidebar-games"].checked = true;
  elements["hide-left-sidebar-games"].dispatch("change");
  assert.equal(summary("hideLeftSidebar"), "1 of 5 hidden");
});

test("saves the scroll mode and opens the file picker for imports", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  elements["scroll-mode"].value = "button";
  elements["scroll-mode"].dispatch("change");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), { scrollMode: "button" });

  elements["import-config"].click();
  assert.equal(elements["import-file"].clickCount, 1);
});

test("shows settings changed elsewhere, and saves lists without undoing them", async () => {
  const { documentElement, elements, storeElsewhere, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: [{ name: "firefox", mode: "home" }] },
  });

  // A Block button on Reddit adds a rule while this page is open.
  await storeElsewhere({
    blockedSubreddits: [{ name: "firefox", mode: "home" }, { name: "pics", mode: "all" }],
  });
  let items = getRenderedItems(elements);
  assert.deepEqual(items.map((item) => item.querySelector("input").value), ["firefox", "pics"]);
  assert.equal(elements["blocked-count"].textContent, "2 rules");

  // Removing another rule here keeps the one added there.
  items[0].children[2].click();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedSubreddits)),
    [{ name: "pics", mode: "all" }],
  );

  // Switches, implied sections and the theme follow too.
  await storeElsewhere({ blockPopular: true, hideComments: true, theme: "dark" });
  assert.equal(elements["block-popular"].checked, true);
  assert.equal(elements["hide-comment-replies"].checked, true);
  assert.equal(elements["hide-comment-replies"].disabled, true);
  assert.equal(elements["color-theme"].value, "dark");
  assert.equal(documentElement.getAttribute("data-theme"), "dark");
  await storeElsewhere({ hideComments: false });
  assert.equal(elements["hide-comment-replies"].checked, false);
  assert.equal(elements["hide-comment-replies"].disabled, false);
  // Changes to other keys, such as the undo marker, need no reload.
  await storeElsewhere({ quickBlockUndo: { subreddit: "pics" } });
  assert.equal(writes.length, 1);
});

test("keeps edits that are not saved yet when settings change elsewhere", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { elements, storeElsewhere, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["spoilers"], scrollLimit: 10 },
  });
  elements["add-title-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  input.value = "trailer";
  input.dispatch("input");
  elements["scroll-limit"].value = "3";

  await storeElsewhere({
    blockedSubreddits: [{ name: "pics", mode: "all" }], blockNews: true, theme: "light",
  });
  assert.equal(getRenderedKeywords(elements)[0].querySelector("input"), input);
  assert.equal(input.value, "trailer");
  assert.equal(elements["scroll-limit"].value, "3");
  assert.equal(elements["block-news"].checked, true);
  assert.equal(getRenderedItems(elements)[0].querySelector("input").value, "pics");

  // The edit is saved once typing pauses, without the stored values it
  // did not change.
  t.mock.timers.tick(700);
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings)),
    { blockedTitleKeywords: ["trailer", "spoilers"] },
  );
});

test("leaves rows as they are when settings are saved, here or elsewhere", async () => {
  const { elements, storeElsewhere } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: [{ name: "zeta", mode: "home" }, { name: "alpha", mode: "all" }] },
  });
  const inputs = () => getRenderedItems(elements).map((item) => item.querySelector("input"));
  const before = inputs();

  // This page's own save, and a list stored in another order.
  before[0].dispatch("blur");
  await settle();
  await settle();
  await storeElsewhere({
    blockedSubreddits: [{ name: "zeta", mode: "home" }, { name: "alpha", mode: "all" }],
  });
  assert.deepEqual(inputs(), before);

  // A new, still empty row stays while another rule arrives.
  elements["add-subreddit"].click();
  await storeElsewhere({
    blockedSubreddits: [{ name: "alpha", mode: "all" }, { name: "beta", mode: "all" }],
  });
  assert.deepEqual(inputs().map((input) => input.value), ["", "alpha", "beta"]);
});

test("never shows a read older than this page's own save", async () => {
  const reads = [];
  const { elements, storeElsewhere, writes } = await loadPopup({
    getSettings: () => {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
  });
  reads[0].resolve({});
  await settle();

  // Another page changes a setting, so this page starts reading...
  await storeElsewhere({ blockNews: true });
  assert.equal(reads.length, 2);
  // ...and finishes only after saving a change of its own.
  elements["block-popular"].checked = true;
  elements["block-popular"].dispatch("change");
  await settle();
  writes[0].completion.resolve();
  await settle();
  reads[1].resolve({ blockNews: true });
  await settle();
  assert.equal(elements["block-popular"].checked, true);
  assert.equal(elements["block-news"].checked, true);
});
