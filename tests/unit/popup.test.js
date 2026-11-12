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
  // What the current tab's page answers; by default, no page listens.
  tabMessage = async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  },
} = {}) {
  const page = loadPage("popup/index.html");
  const writes = [];
  const themeCache = new Map([["frontfilter-theme", cachedTheme]]);
  const storageListeners = [];
  let currentSettings = storedSettings;
  // Stores and removes values and, like browsers, reports them to every
  // page.
  function store(settings, removed = []) {
    const changes = Object.fromEntries([
      ...Object.entries(settings).map(([key, newValue]) => [key, { oldValue: currentSettings[key], newValue }]),
      ...removed.map((key) => [key, { oldValue: currentSettings[key] }]),
    ]);
    currentSettings = { ...currentSettings, ...settings };
    for (const key of removed) delete currentSettings[key];
    setImmediate(() => storageListeners.forEach((listener) => listener(changes, "local")));
  }
  const chrome = {
    storage: {
      local: {
        // The Stats tab reads the statistics, and their switch, apart
        // from the settings: tests of settings reads count only those.
        get: (keys) => (getSettings && !isStatsRead(keys) ? getSettings() : currentSettings),
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
      // The background may read and write the storage this page does.
      sendMessage: async (message) => {
        sent.push(message);
        return sendMessage(message, { values: () => currentSettings, store });
      },
    },
    tabs: {
      query: async () => tabs,
      create: async (properties) => created.push(properties),
      reload: async (tabId) => reloaded.push(tabId),
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message });
        return tabMessage(tabId, message);
      },
    },
  };
  const sent = [];
  const tabMessages = [];
  const created = [];
  const reloaded = [];
  const windowListeners = {};
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
    addEventListener: (type, listener) => (windowListeners[type] ??= []).push(listener),
    setTimeout,
    clearTimeout,
  });

  runScripts(context, page.scripts);
  page.ready();
  await settle();

  return {
    get closed() { return closed; },
    createdTabs: created,
    reloadedTabs: reloaded,
    sentMessages: sent,
    tabMessages,
    createdElements: page.created,
    documentElement: page.document.documentElement,
    elements: page.elements,
    // Closes the page, as closing its tab or leaving the popup does.
    hide() {
      for (const listener of windowListeners.pagehide ?? []) listener({ type: "pagehide" });
    },
    // Changes settings as another page would, and lets this page catch up.
    async storeElsewhere(settings) {
      store(settings);
      await settle();
      await settle();
    },
    // What the storage holds now.
    stored: () => currentSettings,
    themeCache,
    writes,
  };
}

function isStatsRead(keys) {
  return Array.isArray(keys) && keys.includes("stats") && !keys.includes("blockHomepage");
}

function getRenderedItems(elements) {
  return elements["subreddit-list"].querySelectorAll(".subreddit-item");
}

// The mode a row's badge shows, as stored: a block mode, or "allow" for
// an exception.
function selectedMode(item) {
  return item.querySelector(".mode-badge").children.find((option) => option.selected)?.value;
}

// Types in a row's field and leaves it, as a user would.
function type(input, value) {
  input.value = value;
  input.dispatch("input");
  input.dispatch("blur");
}

function getRenderedKeywords(elements) {
  return elements["keyword-list"].querySelectorAll(".keyword-item");
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
  popup.elements["add-keyword"].click();
  const input = getRenderedKeywords(popup.elements)[0].querySelector("input");
  input.value = "election";
  input.dispatch("input");
  await button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(popup.writes.at(-1).settings)),
    { blockedTitleKeywords: ["election"], allowedKeywords: [] });
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
    for (const section of ["block", "filter", "simplify", "stats", "settings"]) {
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
    ["simplify", "ArrowRight", "stats"],
    ["stats", "ArrowRight", "settings"],
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
  assert.equal(elements["subreddit-count"].textContent, "1 rule");
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
  // HOME and ALL rules read as Reddit users would put them, beside
  // exceptions.
  assert.deepEqual(
    items[0].children[1].children.map((option) => [option.value, option.textContent]),
    [["home", "Front page"], ["all", "Everywhere"], ["allow", "Allowed"]],
  );
  assert.equal(items[0].children[1].getAttribute("aria-label"), "Block or allow");
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

  getRenderedItems(elements)[0].querySelector(".remove-btn").click();
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
  const list = elements["subreddit-list"];
  const removeButton = (name) => getRenderedItems(elements)
    .find((item) => item.querySelector("input").value === name).querySelector(".remove-btn");

  removeButton("news").click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings.blockedSubreddits)),
    [{ name: "alpha", mode: "home" }, { name: "zeta", mode: "home" }]);
  assert.equal(elements["subreddit-count"].textContent, "2 rules");
  // The undo row stands where the rule was, and takes the focus.
  assert.deepEqual(list.children.map((child) => child.className),
    ["entry subreddit-item", "entry-undo", "entry subreddit-item"]);
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
  const list = elements["keyword-list"];
  const remove = (value) => getRenderedKeywords(elements)
    .find((item) => item.querySelector("input").value === value).querySelector(".remove-btn").click();

  remove("alpha");
  await settle();
  remove("beta");
  await settle();
  // Only the last removal can be undone.
  const undoRows = list.querySelectorAll(".entry-undo");
  assert.equal(undoRows.length, 1);
  assert.equal(undoRows[0].querySelector(".entry-undo-text").textContent, "Removed “beta”");

  // Adding a rule ends the offer.
  elements["add-keyword"].click();
  assert.equal(list.querySelectorAll(".entry-undo").length, 0);
});

test("leaves the undo of a list's last rule in place of its empty message", async () => {
  const { elements } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedFlairs: ["Meme"] },
  });
  const list = elements["flair-list"];
  list.querySelector(".flair-item").querySelector(".remove-btn").click();
  await settle();
  assert.equal(list.querySelector(".empty-state"), null);
  list.querySelector(".entry-undo button").click();
  await settle();
  assert.equal(list.querySelector(".flair-item input").value, "Meme");
});

test("removes an empty draft without offering to undo it", async () => {
  const { elements } = await loadPopup({ autoResolveWrites: true });
  elements["add-blocked-user"].click();
  elements["blocked-user-list"].querySelector(".user-item").querySelector(".remove-btn").click();
  await settle();
  assert.equal(elements["blocked-user-list"].querySelector(".entry-undo"), null);
  assert.equal(elements["blocked-user-list"].textContent, "No users filtered yet");
});

test("shows subreddit exceptions among the rules, as Allowed", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: {
      blockedSubreddits: [{ name: "*", mode: "all" }, { name: "news", mode: "home" }],
      allowedSubreddits: ["zeta", "ItalyPersonalFinance", "ITALYPERSONALFINANCE", "ask*"],
    },
  });
  const items = () => getRenderedItems(elements);
  const values = () => items().map((item) => [item.querySelector("input").value, selectedMode(item)]);

  // One list, in alphabetical order, counting rules and exceptions alike.
  assert.deepEqual(values(), [
    ["*", "all"], ["ask*", "allow"], ["italypersonalfinance", "allow"], ["news", "home"],
    ["zeta", "allow"],
  ]);
  assert.equal(elements["subreddit-count"].textContent, "5 rules");
  assert.equal(elements["subreddit-list"].querySelectorAll(".entry").length, 5);

  // The badge turns a rule into an exception, and back.
  const news = items()[3];
  news.children[1].value = "allow";
  news.children[1].dispatch("change");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [{ name: "*", mode: "all" }],
    allowedSubreddits: ["ask*", "italypersonalfinance", "news", "zeta"],
  });
  news.children[1].value = "all";
  news.children[1].dispatch("change");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [{ name: "*", mode: "all" }, { name: "news", mode: "all" }],
    allowedSubreddits: ["ask*", "italypersonalfinance", "zeta"],
  });

  items()[2].querySelector(".remove-btn").click();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.allowedSubreddits)),
    ["ask*", "zeta"],
  );
});

test("makes an exception of a rule typed after a +", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: [{ name: "news", mode: "all" }] },
  });

  elements["add-subreddit"].click();
  const draft = getRenderedItems(elements)[0];
  assert.equal(selectedMode(draft), "all");
  type(draft.querySelector("input"), " + https://www.reddit.com/r/WorldNews/ ");
  await settle();
  assert.equal(draft.querySelector("input").value, "worldnews");
  assert.equal(selectedMode(draft), "allow");
  assert.equal(draft.querySelector(".mode-badge").value, "allow");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [{ name: "news", mode: "all" }],
    allowedSubreddits: ["worldnews"],
  });

  // Patterns make exceptions too; a + alone makes none.
  type(draft.querySelector("input"), "+world*");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings.allowedSubreddits)), ["world*"]);
  type(draft.querySelector("input"), "+");
  assert.equal(draft.querySelector("input").value, "");
  assert.equal(elements["toast"].textContent,
    "Enter a subreddit name, a pattern with *, or a Reddit URL");

  // An exception for a blocked subreddit replaces its rule, which it overrides.
  elements["add-subreddit"].click();
  type(getRenderedItems(elements)[0].querySelector("input"), "+r/News");
  await settle();
  const rows = getRenderedItems(elements);
  assert.deepEqual(rows.map((item) => [item.querySelector("input").value, selectedMode(item)]),
    [["", "allow"], ["news", "allow"]]);
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [],
    allowedSubreddits: ["news"],
  });
  // A rule typed for an exception merges into it: the exception still wins.
  elements["add-subreddit"].click();
  type(getRenderedItems(elements)[0].querySelector("input"), "news");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [],
    allowedSubreddits: ["news"],
  });
});

test("shows and saves an exception as soon as its + is typed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { elements, hide, writes } = await loadPopup({ autoResolveWrites: true });
  elements["add-keyword"].click();
  const row = getRenderedKeywords(elements)[0];
  const input = row.querySelector("input");
  input.value = "+ai art";
  input.dispatch("input");
  assert.equal(selectedMode(row), "allow");
  // Saved once typing pauses, as the exception it is.
  t.mock.timers.tick(700);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: [],
    allowedKeywords: ["ai art"],
  });
  // Taking the + back makes it a rule again.
  input.value = "ai art";
  input.dispatch("input");
  assert.equal(selectedMode(row), "block");
  // Closing the page saves what is typed, as typed.
  input.value = "+ai";
  input.dispatch("input");
  hide();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: [],
    allowedKeywords: ["ai"],
  });
});

test("reads a + as text in a rule that already holds it, until it is typed again", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["+1"] },
  });
  const row = getRenderedKeywords(elements)[0];
  assert.equal(row.querySelector("input").value, "+1");
  assert.equal(selectedMode(row), "block");
  // Leaving the field unchanged keeps the rule as it is.
  row.querySelector("input").dispatch("blur");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: ["+1"],
    allowedKeywords: [],
  });
  assert.equal(selectedMode(row), "block");
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

  items().find((item) => item.querySelector("input").value === "kn0thing").querySelector(".remove-btn").click();
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
  const items = () => elements["flair-list"].querySelectorAll(".flair-item");
  assert.equal(items().length, 1);
  assert.equal(elements["flair-count"].textContent, "1 flair");

  elements["add-flair"].click();
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
  assert.equal(elements["flair-count"].textContent, "2 flairs");

  items().find((item) => item.querySelector("input").value === "Meme").querySelector(".remove-btn").click();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedFlairs)),
    ["*Politic*"],
  );
  assert.equal(elements["flair-count"].textContent, "1 flair");
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
  assert.equal(elements["keyword-count"].textContent, "2 keywords");

  elements["add-keyword"].click();
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
  assert.equal(elements["keyword-count"].textContent, "3 keywords");

  getRenderedKeywords(elements)[0].querySelector(".remove-btn").click();
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
    elements["add-keyword"].click();
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
  assert.equal(elements["keyword-count"].textContent, "3 keywords");
  assert.deepEqual(
    JSON.parse(JSON.stringify(writes.at(-1).settings.blockedTitleKeywords)),
    ["/\\D+/", "/\\d+/", "perche"],
  );
});

test("edits keyword exceptions as keywords are edited, in the same list", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["trump"], allowedKeywords: ["Biden", "biden"] },
  });
  const items = () => getRenderedKeywords(elements);
  assert.deepEqual(items().map((item) => [item.querySelector("input").value, selectedMode(item)]),
    [["Biden", "allow"], ["trump", "block"]]);
  assert.equal(elements["keyword-count"].textContent, "2 keywords");
  assert.deepEqual(
    items()[0].querySelector(".mode-badge").children.map((option) => [option.value, option.textContent]),
    [["block", "Hidden"], ["allow", "Allowed"]],
  );
  assert.equal(items()[0].querySelector(".mode-badge").getAttribute("aria-label"), "Hide or allow");

  elements["add-keyword"].click();
  const input = items()[0].querySelector("input");
  assert.equal(input.focused, true);
  assert.equal(selectedMode(items()[0]), "block");
  type(input, "  + /ukrain(e|ian)/ ");
  await settle();
  assert.equal(input.value, "/ukrain(e|ian)/");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: ["trump"],
    allowedKeywords: ["/ukrain(e|ian)/", "Biden"],
  });
  assert.equal(elements["keyword-count"].textContent, "3 keywords");

  // An exception and a rule that match alike merge into the exception.
  elements["add-keyword"].click();
  type(items()[0].querySelector("input"), "+TRUMP");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: [],
    allowedKeywords: ["/ukrain(e|ian)/", "Biden", "TRUMP"],
  });

  items().find((item) => item.querySelector("input").value === "Biden").querySelector(".remove-btn").click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: [],
    allowedKeywords: ["/ukrain(e|ian)/", "TRUMP"],
  });
});

test("hides and allows flairs in one list", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedFlairs: ["*"], allowedFlairs: ["Discussion"] },
  });
  const items = () => elements["flair-list"].querySelectorAll(".flair-item");
  assert.deepEqual(items().map((item) => [item.querySelector("input").value, selectedMode(item)]),
    [["*", "block"], ["Discussion", "allow"]]);
  elements["add-flair"].click();
  type(items()[0].querySelector("input"), "+Question");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedFlairs: ["*"],
    allowedFlairs: ["Question", "Discussion"],
  });
});

test("keeps users a list of blocks, with no exceptions", async () => {
  const { elements } = await loadPopup({ autoResolveWrites: true });
  elements["add-blocked-user"].click();
  const row = elements["blocked-user-list"].querySelector(".user-item");
  assert.equal(row.querySelector(".mode-badge"), null);
  type(row.querySelector("input"), "+spez");
  assert.equal(row.querySelector("input").value, "");
  assert.equal(elements["toast"].textContent, "Enter a username, such as u/name, or a profile URL");
});

test("adds the current tab's subreddit and reports non-subreddit tabs", async () => {
  const currentSubreddit = await loadPopup({
    autoResolveWrites: true,
    tabs: [{ url: "https://www.reddit.com/r/Firefox/comments/abc/post" }],
  });
  // A card names the subreddit, with buttons that block or allow it.
  const card = currentSubreddit.elements["current-page"];
  assert.equal(card.hidden, false);
  assert.equal(currentSubreddit.elements["current-page-prefix"].textContent, "r/");
  assert.equal(currentSubreddit.elements["current-page-name"].textContent, "r/firefox");
  assert.equal(currentSubreddit.elements["current-page-name"].getAttribute("title"), "r/firefox");
  assert.equal(currentSubreddit.elements["current-page-actions"].hidden, false);
  // A page that does not answer gives no count.
  assert.equal(currentSubreddit.elements["current-page-hidden"].hidden, true);
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

  // Allowing it turns its rule into an exception.
  await currentSubreddit.elements["add-current-allowed-subreddit"].click();
  await settle();
  const rows = getRenderedItems(currentSubreddit.elements);
  assert.deepEqual(rows.map((item) => [item.querySelector("input").value, selectedMode(item)]),
    [["firefox", "allow"]]);
  assert.equal(currentSubreddit.elements["toast"].textContent, "r/firefox allowed");
  assert.deepEqual(
    JSON.parse(JSON.stringify(currentSubreddit.writes.at(-1).settings)),
    { blockedSubreddits: [], allowedSubreddits: ["firefox"] },
  );

  // Outside Reddit, browsers withhold the tab's URL.
  for (const tab of [{ url: "https://www.reddit.com/" }, { id: 7 }]) {
    const nonSubreddit = await loadPopup({ tabs: [tab] });
    // Nothing to add, nor to count: the card stays hidden.
    assert.equal(nonSubreddit.elements["current-page"].hidden, true);
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
    [{ blockedSubreddits: [{ name: "*", mode: "all" }], allowedSubreddits: ["new*"] },
      "Allowed by new*, so it stays open", true, true],
    [{ blockedSubreddits: [{ name: "*", mode: "all" }] }, "Blocked everywhere by *", true, false],
  ];
  for (const [storedSettings, status, blockOff, allowOff] of states) {
    const { elements } = await loadPopup({
      storedSettings, tabs: [{ url: "https://www.reddit.com/r/News/" }],
    });
    assert.equal(elements["current-page-status"].textContent, status);
    assert.equal(elements["add-current-subreddit"].disabled, blockOff, status);
    assert.equal(elements["add-current-allowed-subreddit"].disabled, allowOff, status);
  }

  // Blocking it says so at once, and leaves nothing more to block.
  const { elements } = await loadPopup({
    autoResolveWrites: true, tabs: [{ url: "https://www.reddit.com/r/news/" }],
  });
  await elements["add-current-subreddit"].click();
  assert.equal(elements["current-page-status"].textContent, "Blocked everywhere");
  assert.equal(elements["add-current-subreddit"].disabled, true);
  assert.equal(elements["add-current-allowed-subreddit"].disabled, false);
});

test("sends the blocked subreddit's page to the block page, by reloading it if it cannot go itself", async () => {
  const tabs = [{ id: 3, url: "https://www.reddit.com/r/news/comments/abc/post" }];
  // A page whose content script listens goes once the rule is saved.
  const listening = await loadPopup({
    autoResolveWrites: true, tabs, tabMessage: async () => null,
  });
  await listening.elements["add-current-subreddit"].click();
  assert.equal(listening.writes.length, 1);
  assert.deepEqual(listening.reloadedTabs, []);
  assert.deepEqual(listening.sentMessages, []);

  // A page loaded before FrontFilter was installed, updated or reloaded has
  // none: it is reloaded once the rule is saved and the navigation rules
  // block it.
  const stale = await loadPopup({ tabs });
  const clicked = stale.elements["add-current-subreddit"].click();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(stale.writes[0].settings.blockedSubreddits)),
    [{ name: "news", mode: "all" }],
  );
  assert.deepEqual(stale.sentMessages, []);
  assert.deepEqual(stale.reloadedTabs, []);
  stale.writes[0].completion.resolve();
  await clicked;
  assert.deepEqual(JSON.parse(JSON.stringify(stale.sentMessages)), [{ action: "syncNavigationRules" }]);
  assert.deepEqual(stale.reloadedTabs, [3]);

  // Nor without the rules, as its new content script blocks it.
  const unsynced = await loadPopup({
    autoResolveWrites: true, tabs, sendMessage: async () => ({ success: false, error: "busy" }),
  });
  await unsynced.elements["add-current-subreddit"].click();
  assert.deepEqual(unsynced.reloadedTabs, [3]);

  // A rule that could not be saved leaves the page as it is.
  const failed = await loadPopup({ tabs });
  const failedClick = failed.elements["add-current-subreddit"].click();
  await settle();
  failed.writes[0].completion.reject(new Error("storage is full"));
  await failedClick;
  await settle();
  assert.deepEqual(failed.sentMessages, []);
  assert.deepEqual(failed.reloadedTabs, []);
  assert.equal(failed.elements["toast"].textContent, "Save failed: storage is full");

  // Allowing it changes nothing the page cannot show itself.
  const allowed = await loadPopup({ autoResolveWrites: true, tabs });
  await allowed.elements["add-current-allowed-subreddit"].click();
  await settle();
  assert.deepEqual(allowed.reloadedTabs, []);
});

test("names every Reddit page on its card, and says what filters hide on it", async (t) => {
  // Pages that answer are asked again later.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pages = [
    ["https://www.reddit.com/", "", "Homepage"],
    ["https://www.reddit.com/top/?t=day", "", "Homepage"],
    ["https://www.reddit.com/explore/", "", "Explore"],
    ["https://www.reddit.com/news", "", "News"],
    ["https://www.reddit.com/user/Spez/submitted/", "u/", "u/spez"],
    ["https://www.reddit.com/search/?q=cats", "", "Reddit"],
  ];
  for (const [url, prefix, name] of pages) {
    const { elements, tabMessages } = await loadPopup({
      tabs: [{ id: 4, url }],
      tabMessage: async () => ({ posts: 12, comments: 0 }),
    });
    assert.equal(elements["current-page"].hidden, false, url);
    assert.equal(elements["current-page-prefix"].textContent, prefix, url);
    assert.equal(elements["current-page-name"].textContent, name, url);
    assert.equal(elements["current-page-hidden"].textContent, "12 posts hidden on this page");
    // Only a subreddit has rules to tell and buttons.
    assert.equal(elements["current-page-status"].hidden, true);
    assert.equal(elements["current-page-actions"].hidden, true);
    assert.deepEqual(JSON.parse(JSON.stringify(tabMessages)),
      [{ tabId: 4, message: { action: "countHidden" } }]);
  }

  // A subreddit's card adds the count below what the rules do to it.
  const { elements } = await loadPopup({
    tabs: [{ id: 4, url: "https://www.reddit.com/r/news/" }],
    tabMessage: async () => ({ posts: 1, comments: 3 }),
  });
  assert.equal(elements["current-page-status"].textContent, "Not blocked");
  assert.equal(elements["current-page-hidden"].hidden, false);
  assert.equal(elements["current-page-hidden"].textContent, "1 post and 3 comments hidden on this page");
  assert.equal(elements["current-page-actions"].hidden, false);

  // A page that gives no count, as Old Reddit, has nothing for the card.
  const oldReddit = await loadPopup({
    tabs: [{ id: 4, url: "https://old.reddit.com/" }],
    tabMessage: async () => null,
  });
  assert.equal(oldReddit.elements["current-page"].hidden, true);
});

test("keeps the page's count up to date while it answers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = { counts: { posts: 0, comments: 0 } };
  const popup = await loadPopup({
    tabs: [{ id: 9, url: "https://www.reddit.com/" }],
    tabMessage: async () => {
      if (!page.counts) throw new Error("Receiving end does not exist.");
      return page.counts;
    },
  });
  const count = popup.elements["current-page-hidden"];
  assert.equal(count.textContent, "Nothing hidden on this page");

  // Reddit loads posts, or a setting changes, and the card follows.
  page.counts = { posts: 1, comments: 1 };
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(count.textContent, "1 post and 1 comment hidden on this page");

  // A page that stops answering, as one blocked meanwhile, loses its card,
  // and is not asked again.
  page.counts = null;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(popup.elements["current-page"].hidden, true);
  const asked = popup.tabMessages.length;
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(popup.tabMessages.length, asked);
});

test("asks no page for a count in a tab of its own", async () => {
  const popup = await loadPopup({
    locationSearch: "?standalone=true&currentSubreddit=Firefox",
    tabs: [{ id: 2, url: "https://www.reddit.com/r/firefox/" }],
    tabMessage: async () => ({ posts: 5, comments: 0 }),
  });
  assert.equal(popup.elements["current-page-name"].textContent, "r/firefox");
  assert.equal(popup.elements["current-page-hidden"].hidden, true);
  assert.deepEqual(popup.tabMessages, []);
});

test("labels every list's Add button alike, and names each for its list", async () => {
  const { elements } = await loadPopup();
  const names = [
    ["add-subreddit", "Add a subreddit"],
    ["add-blocked-user", "Add a user"],
    ["add-keyword", "Add a keyword"],
    ["add-flair", "Add a flair"],
  ];
  for (const [id, name] of names) {
    assert.equal(elements[id].textContent.trim(), "Add", id);
    // The visible label starts the accessible name.
    assert.equal(elements[id].getAttribute("aria-label"), name);
    assert.ok(name.startsWith("Add "));
  }
});

// Block holds what keeps pages from opening; Filter, what hides posts and
// comments, users included. Exceptions are in the list of the rules they
// override, which has no list of exceptions beside it.
test("puts each list in the tab of what it does", () => {
  const { elements } = loadPage("popup/index.html");
  assert.ok(elements["panel-block"].querySelector("#subreddit-list"));
  for (const id of ["keyword-list", "flair-list", "blocked-user-list"]) {
    assert.ok(elements["panel-filter"].querySelector(`#${id}`), id);
  }
  for (const id of ["allowed-list", "allowed-keyword-list", "add-allowed-subreddit", "add-allowed-keyword"]) {
    assert.equal(elements[id], null, id);
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
    getRenderedItems(elements)[0].querySelector("input").value,
    "italypersonalfinance",
  );
  assert.equal(selectedMode(getRenderedItems(elements)[0]), "allow");
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
    allowedKeywords: ["ai art"],
    blockedFlairs: [],
    allowedSubreddits: ["science"],
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
    // A list's rules and exceptions count together.
    ["Subreddits: 3 rules, replaced", "Keywords: 0 → 3 keywords", "2 other settings"],
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
  assert.equal(elements["flair-list"].querySelector(".flair-item input").value, "Meme");
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
  assert.equal(elements["add-subreddit"].disabled, true);
  assert.equal(elements["add-keyword"].disabled, true);

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
  assert.equal(elements["add-subreddit"].disabled, false);
  assert.equal(elements["add-keyword"].disabled, false);
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

// "Block pages" chooses the pages to block; the block page's options say
// what happens on them, under a title that does not read the same.
test("names the block page's options apart from the pages to block", () => {
  const { elements } = loadPage("popup/index.html");
  const nameOf = (id) => elements[id].getAttribute("aria-labelledby").split(" ")
    .map((part) => elements[part].textContent.replace(/\s+/g, " ").trim())
    .join(" ");
  assert.equal(elements["pages-heading"].textContent, "Block pages");
  assert.equal(nameOf("hide-block-page-settings-button"), "When a page is blocked Hide the Open settings button");
  assert.equal(nameOf("redirect-blocked-pages"), "When a page is blocked Redirect to another website");
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
  elements["add-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  input.value = "spoilers";
  input.dispatch("input");
  t.mock.timers.tick(699);
  await settle();
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  await settle();
  // A list saves its rules and its exceptions together.
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].settings)), {
    blockedTitleKeywords: ["spoilers"],
    allowedKeywords: [],
  });
});

test("saves what is typed when the page closes before typing pauses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { elements, hide, writes } = await loadPopup();
  // A save still in progress does not hold back the one made on closing.
  elements["block-news"].checked = true;
  elements["block-news"].dispatch("change");
  await settle();
  assert.equal(writes.length, 1);
  elements["add-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  input.value = "spoilers";
  input.dispatch("input");
  hide();
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[1].settings)), {
    blockedTitleKeywords: ["spoilers"],
    allowedKeywords: [],
  });
  // Nothing is left to save twice.
  t.mock.timers.tick(700);
  await settle();
  assert.equal(writes.length, 2);
});

test("saves numbers and an address typed but not committed when the page closes", async () => {
  const { elements, hide, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { limitInfiniteScroll: true, limitComments: true, scrollLimit: 25 },
  });
  elements["scroll-limit"].value = "7";
  elements["comment-limit"].value = "0";
  elements["redirect-url"].value = "example.com";
  hide();
  assert.equal(writes.length, 1);
  // A number that cannot be used is left as it was saved.
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].settings)), {
    scrollLimit: 7, redirectUrl: "https://example.com/",
  });
});

test("saves a cleared address, and no address that cannot be used, when the page closes", async () => {
  const stored = { redirectBlockedPages: true, redirectUrl: "https://example.com/" };
  const cleared = await loadPopup({ autoResolveWrites: true, storedSettings: stored });
  cleared.elements["redirect-url"].value = " ";
  cleared.hide();
  assert.deepEqual(JSON.parse(JSON.stringify(cleared.writes[0].settings)), { redirectUrl: "" });

  const invalid = await loadPopup({ autoResolveWrites: true, storedSettings: stored });
  invalid.elements["redirect-url"].value = "not a website";
  invalid.hide();
  assert.equal(invalid.writes.length, 0);
});

test("saves nothing when the page closes with everything saved", async () => {
  // Defaults included: the fields start with them before settings load.
  for (const storedSettings of [{}, { scrollLimit: 13, redirectUrl: "https://example.com/" }]) {
    const { hide, writes } = await loadPopup({ autoResolveWrites: true, storedSettings });
    hide();
    assert.equal(writes.length, 0, JSON.stringify(storedSettings));
  }
});

test("explains entries that cannot be used, and clears them", async () => {
  const { elements, writes } = await loadPopup({ autoResolveWrites: true });
  for (const [addId, list, value, message] of [
    ["add-subreddit", "subreddit-list", "not a subreddit!", "Enter a subreddit name, a pattern with *, or a Reddit URL"],
    ["add-blocked-user", "blocked-user-list", "r/firefox", "Enter a username, such as u/name, or a profile URL"],
    ["add-flair", "flair-list", "x".repeat(101), "Flairs can be at most 100 characters long"],
    ["add-keyword", "keyword-list", "/(unclosed/", "Enter a keyword, or a valid regular expression between slashes"],
    ["add-keyword", "keyword-list", "+/[a/", "Enter a keyword, or a valid regular expression between slashes"],
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
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: [],
    allowedKeywords: [],
  });
});

test("merges a row into an earlier one for the same rule", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedTitleKeywords: ["Spoilers"] },
  });
  elements["add-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  input.value = "SPOILERS";
  input.dispatch("input");
  input.dispatch("blur");
  await settle();

  const items = getRenderedKeywords(elements);
  assert.equal(items.length, 1);
  assert.equal(items[0].querySelector("input").focused, true);
  assert.equal(elements["keyword-count"].textContent, "1 keyword");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: ["SPOILERS"],
    allowedKeywords: [],
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
  assert.equal(elements["subreddit-count"].textContent, "3 rules");
  assert.equal(elements["toast"].textContent, "Added 2 rules; 1 entry could not be used");
  assert.equal(elements["toast"].className, "show error");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [
      { name: "askreddit", mode: "all" },
      { name: "firefox", mode: "all" },
      { name: "news", mode: "all" },
    ],
    allowedSubreddits: [],
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
    allowedSubreddits: [],
  });
});

test("pastes exceptions written with a +, in any row", async () => {
  const { elements, writes } = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: [{ name: "news", mode: "all" }] },
  });
  elements["add-subreddit"].click();
  assert.equal(paste(getRenderedItems(elements)[0].querySelector("input"),
    "*\n+AskHistorians, + r/science\n+news, +not valid!"), true);
  await settle();
  const rows = () => getRenderedItems(elements)
    .map((item) => [item.querySelector("input").value, selectedMode(item)]);
  assert.deepEqual(rows(), [
    ["*", "all"], ["askhistorians", "allow"], ["news", "allow"], ["science", "allow"],
  ]);
  // An exception for a rule already there replaces it, and is no new rule.
  assert.equal(elements["toast"].textContent, "Added 3 rules; 1 entry could not be used");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedSubreddits: [{ name: "*", mode: "all" }],
    allowedSubreddits: ["askhistorians", "news", "science"],
  });

  // Pasted in an exception, a list is of exceptions.
  const science = getRenderedItems(elements)[3].querySelector("input");
  Object.assign(science, { selectionStart: 0, selectionEnd: science.value.length });
  assert.equal(paste(science, "science, space"), true);
  await settle();
  assert.deepEqual(rows(), [
    ["*", "all"], ["askhistorians", "allow"], ["news", "allow"], ["science", "allow"],
    ["space", "allow"],
  ]);
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
  elements["add-keyword"].click();
  assert.equal(paste(getRenderedKeywords(elements)[0].querySelector("input"), "/a{1,3}/, spoiler*\nPerché"), true);
  await settle();
  assert.deepEqual(
    getRenderedKeywords(elements).map((item) => item.querySelector("input").value),
    ["/a{1,3}/", "Perché", "spoiler*"],
  );
  assert.equal(elements["toast"].textContent, "Added 2 keywords");
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: ["/a{1,3}/", "Perché", "spoiler*"],
    allowedKeywords: [],
  });

  // An expression keeps its commas as an exception too.
  elements["add-keyword"].click();
  assert.equal(paste(getRenderedKeywords(elements)[0].querySelector("input"), "+/b{1,3}/, +ai art"), true);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1).settings)), {
    blockedTitleKeywords: ["/a{1,3}/", "Perché", "spoiler*"],
    allowedKeywords: ["/b{1,3}/", "ai art"],
  });

  // Only keywords keep commas between slashes; a list of rules already there adds none.
  const flairs = () => elements["flair-list"].querySelectorAll(".flair-item");
  elements["add-flair"].click();
  assert.equal(paste(flairs()[0].querySelector("input"), "meme, MEME"), true);
  await settle();
  assert.deepEqual(flairs().map((item) => item.querySelector("input").value), ["meme"]);
  assert.equal(elements["toast"].textContent, "No new flairs");
  assert.equal(elements["toast"].className, "show info");
});

test("tells empty lists apart and counts their rules", async () => {
  const { elements } = await loadPopup({ storedSettings: { blockedFlairs: ["Meme"] } });
  assert.equal(elements["subreddit-list"].textContent, "No subreddits blocked or allowed yet");
  assert.equal(elements["subreddit-count"].textContent, "0 rules");
  assert.equal(elements["blocked-user-list"].textContent, "No users filtered yet");
  assert.equal(elements["blocked-user-count"].textContent, "0 users");
  assert.equal(elements["keyword-list"].textContent, "No keywords filtered yet");
  assert.equal(elements["keyword-count"].textContent, "0 keywords");
  assert.equal(elements["flair-count"].textContent, "1 flair");
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
  const { tools, more } = listTools(elements, "flair-list");
  assert.equal(shownValues(elements["flair-list"]).length, 8);
  assert.equal(tools.hidden, true);
  assert.equal(more.hidden, true);
});

test("folds a long list to its first rules, and shows it all on request", async () => {
  const keywords = Array.from({ length: 30 }, (_, index) => `keyword ${String(index).padStart(2, "0")}`);
  const { elements, writes } = await loadPopup({ storedSettings: { blockedTitleKeywords: keywords } });
  const list = elements["keyword-list"];
  const { tools, more } = listTools(elements, "keyword-list");
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
  const list = elements["subreddit-list"];
  const { search, more, noMatch } = listTools(elements, "subreddit-list");
  assert.equal(search.getAttribute("aria-label"), "Search subreddits");

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
  const list = elements["subreddit-list"];
  const { search } = listTools(elements, "subreddit-list");

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
  elements["add-keyword"].click();
  const input = getRenderedKeywords(elements)[0].querySelector("input");
  assert.equal(paste(input, "zeta\nyankee"), true);
  await settle();
  const shown = shownValues(elements["keyword-list"]);
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
  assert.equal(elements["subreddit-count"].textContent, "2 rules");

  // Removing another rule here keeps the one added there.
  items[0].querySelector(".remove-btn").click();
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
  elements["add-keyword"].click();
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
    { blockedTitleKeywords: ["trailer", "spoilers"], allowedKeywords: [] },
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

// Statistics as the background stores them, from records made now.
function buildStats(records) {
  const context = vm.createContext({ URL, URLSearchParams });
  runScripts(context, ["shared/core.js", "shared/stats.js"]);
  const now = Date.now();
  return JSON.parse(JSON.stringify(records.reduce(
    (stats, record) => context.FrontFilter.stats.addRecord(stats, record, now),
    undefined,
  )));
}

const MINUTE = 60000;

function rankingRows(list) {
  return list.querySelectorAll(".rank-row").map((row) => [
    row.querySelector(".rank-label").textContent,
    row.querySelector(".rank-detail")?.textContent ?? "",
    row.querySelector(".rank-count").textContent,
  ]);
}

test("shows today's statistics, the last 7 days, and what they blocked and hid", async () => {
  const stats = buildStats([
    { time: 15 * MINUTE }, { time: 15 * MINUTE }, { time: 12 * MINUTE },
    { blocked: { "page:homepage": 2, "subreddit:news": 1 } },
    { posts: { keywords: 4, ads: 1 }, comments: { keywords: 1 } },
  ]);
  const { elements } = await loadPopup({ storedSettings: { stats } });

  assert.equal(elements["stat-time"].textContent, "42 min");
  assert.equal(elements["stat-time-week"].textContent, "42 min in 7 days");
  assert.equal(elements["stat-visits"].textContent, "1");
  assert.equal(elements["stat-blocked"].textContent, "3");
  assert.equal(elements["stat-hidden"].textContent, "6");
  assert.equal(elements["stat-hidden-week"].textContent, "6 in 7 days");
  assert.equal(elements["stats-paused"].hidden, true);

  const days = elements["time-chart"].querySelectorAll(".chart-day");
  assert.equal(days.length, 7);
  const today = days.at(-1);
  assert.equal(today.classList.contains("today"), true);
  assert.match(today.getAttribute("aria-label"), /: 42 min, 1 visit$/);
  assert.equal(today.querySelector(".chart-value").textContent, "42m");
  assert.equal(today.querySelector(".chart-minutes"), null);
  assert.equal(today.querySelector(".chart-bar").style.height, "100%");
  assert.equal(days[0].querySelector(".chart-bar").style.height, "0");
  // Counting began today: no day is over to average yet.
  assert.equal(elements["chart-readout-label"].textContent, "Today");
  assert.equal(elements["chart-readout-value"].textContent, "42 min");
  assert.equal(elements["chart-change"].hidden, true);

  assert.deepEqual(rankingRows(elements["blocked-ranking"]), [["Homepage", "", "2"], ["r/news", "", "1"]]);
  assert.deepEqual(rankingRows(elements["hidden-ranking"]), [
    ["Keywords", "4 posts, 1 comment", "5"],
    ["Ads", "1 post", "1"],
  ]);
  assert.match(elements["stats-since"].textContent, /^Since .+: 42 min on Reddit, 3 pages blocked, 6 hidden$/);
});

test("groups the digits of large figures, hours included", async () => {
  const context = vm.createContext({ URL, URLSearchParams });
  runScripts(context, ["shared/core.js", "shared/stats.js"]);
  const { dayKey, shiftDay } = context.FrontFilter.stats;
  const HOUR = 60 * MINUTE;
  const today = dayKey(Date.now());
  // A minute a day the week before, then 9 h 58 min a day, and today less.
  const days = {};
  for (let offset = -13; offset < 0; offset++) {
    days[shiftDay(today, offset)] = { time: offset < -6 ? MINUTE : 9 * HOUR + 58 * MINUTE, visits: 1 };
  }
  days[today] = {
    time: 2 * HOUR + 5 * MINUTE, visits: 1,
    blocked: { "page:homepage": 12345 }, posts: { keywords: 1234567 },
  };
  const stats = {
    since: Date.now() - 20 * 24 * HOUR,
    totals: { time: 1234 * HOUR, visits: 14, blocked: 12345, posts: 1234567, comments: 0 },
    days,
  };
  const { elements } = await loadPopup({ storedSettings: { stats } });
  const group = (number) => number.toLocaleString();

  assert.equal(elements["stat-blocked"].textContent, group(12345));
  assert.equal(elements["stat-hidden"].textContent, group(1234567));
  assert.equal(elements["chart-change"].textContent, `${group(59700)}% more than the week before`);
  assert.match(elements["stats-since"].textContent, new RegExp(`: ${group(1234)} h on Reddit, `
    + `${group(12345)} pages blocked, ${group(1234567)} hidden$`));
  // A narrow chart hides a value's minutes, which have an element of their own.
  const chartDays = elements["time-chart"].querySelectorAll(".chart-day");
  assert.equal(chartDays[0].querySelector(".chart-value").textContent, "9h 58m");
  assert.equal(chartDays[0].querySelector(".chart-minutes").textContent, " 58m");
  assert.equal(chartDays.at(-1).querySelector(".chart-value").textContent, "2h 5m");
});

test("shows empty statistics, and those recorded while it is open", async () => {
  const popup = await loadPopup();
  const { elements } = popup;
  assert.equal(elements["stat-time"].textContent, "0 min");
  assert.equal(elements["stats-since"].textContent, "Nothing counted yet");
  assert.equal(elements["blocked-ranking"].querySelector(".empty-state").textContent,
    "Nothing blocked in the last 7 days");
  assert.equal(elements["hidden-ranking"].querySelector(".empty-state").textContent,
    "Nothing hidden in the last 7 days");

  await popup.storeElsewhere({ stats: buildStats([{ blocked: { "user:spez": 1 } }]) });
  assert.equal(elements["stat-blocked"].textContent, "1");
  assert.deepEqual(rankingRows(elements["blocked-ranking"]), [["u/spez", "", "1"]]);
  assert.equal(popup.writes.length, 0);
});

test("folds blocked pages past the first five into one row", async () => {
  const blocked = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((name, index) =>
    [`subreddit:${name}`, 10 - index]));
  const { elements } = await loadPopup({ storedSettings: { stats: buildStats([{ blocked }]) } });
  assert.deepEqual(rankingRows(elements["blocked-ranking"]).map(([label, , count]) => [label, count]), [
    ["r/a", "10"], ["r/b", "9"], ["r/c", "8"], ["r/d", "7"], ["r/e", "6"], ["2 more", "9"],
  ]);
});

test("moves through the chart's days with arrows, and says what each holds", async () => {
  const { elements } = await loadPopup({ storedSettings: { stats: buildStats([{ time: 5 * MINUTE }]) } });
  const days = () => elements["time-chart"].querySelectorAll(".chart-day");
  // One stop in the tab order: today.
  assert.deepEqual(days().map(({ tabIndex }) => tabIndex), [-1, -1, -1, -1, -1, -1, 0]);

  let prevented = false;
  days()[6].dispatch("keydown", { key: "ArrowLeft", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(days()[5].focused, true);
  assert.deepEqual(days().map(({ tabIndex }) => tabIndex), [-1, -1, -1, -1, -1, 0, -1]);
  days()[5].dispatch("keydown", { key: "Home", preventDefault() {} });
  assert.equal(days()[0].focused, true);

  days()[6].dispatch("focus");
  assert.equal(elements["chart-readout-value"].textContent, "5 min");
  assert.notEqual(elements["chart-readout-label"].textContent, "Today");
  days()[6].dispatch("blur");
  assert.equal(elements["chart-readout-label"].textContent, "Today");
});

test("asks before deleting the statistics, which the background deletes", async () => {
  const popup = await loadPopup({
    storedSettings: { stats: buildStats([{ posts: { ads: 1 } }]) },
    sendMessage: async (message) => {
      if (message.action === "resetStats") await popup.storeElsewhere({ stats: undefined });
      return { success: true };
    },
  });
  const { elements } = popup;
  elements["reset-stats"].click();
  assert.equal(elements["reset-stats-confirm"].hidden, false);
  assert.equal(elements["reset-stats-question"].focused, true);

  // Cancel, or Escape, keeps them.
  elements["reset-stats-cancel"].click();
  assert.equal(elements["reset-stats-confirm"].hidden, true);
  assert.equal(elements["reset-stats"].focused, true);
  elements["reset-stats"].click();
  elements["reset-stats-confirm"].dispatch("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(elements["reset-stats-confirm"].hidden, true);
  assert.equal(popup.sentMessages.length, 0);

  elements["reset-stats"].click();
  await elements["reset-stats-delete"].click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(popup.sentMessages)), [{ action: "resetStats" }]);
  assert.equal(elements["reset-stats-confirm"].hidden, true);
  assert.equal(elements.toast.textContent, "Statistics deleted");
  assert.equal(elements["stats-since"].textContent, "Nothing counted yet");
  assert.equal(elements["stat-hidden"].textContent, "0");
});

test("says when the statistics could not be deleted", async () => {
  const { elements } = await loadPopup({
    storedSettings: { stats: buildStats([{ posts: { ads: 1 } }]) },
    sendMessage: async () => ({ success: false, error: "storage is full" }),
  });
  elements["reset-stats"].click();
  await elements["reset-stats-delete"].click();
  assert.equal(elements.toast.textContent, "Could not delete statistics: storage is full");
  assert.equal(elements["stat-hidden"].textContent, "1");
});

test("pauses the statistics from their switch, and says so", async () => {
  const popup = await loadPopup({ autoResolveWrites: true });
  const { elements } = popup;
  assert.equal(elements["pause-statistics"].checked, false);
  elements["pause-statistics"].checked = true;
  elements["pause-statistics"].dispatch("change");
  await settle();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(popup.writes.at(-1).settings)), { pauseStatistics: true });
  assert.equal(elements["stats-paused"].hidden, false);
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const plain = (value) => JSON.parse(JSON.stringify(value));

// A background that keeps the settings lock as FrontFilter's does
// (background/main.js), on the page's storage.
function lockBackground() {
  const context = vm.createContext({ URL, URLSearchParams });
  runScripts(context, ["shared/core.js", "shared/settings-lock.js"]);
  const LOCK = context.FrontFilter.settingsLock;
  const operations = {
    startLock: LOCK.start,
    saveSettings: LOCK.save,
    cancelLockedChange: LOCK.cancel,
    updateLock: LOCK.update,
  };
  return async (message, storage) => {
    const operation = operations[message.action];
    if (!operation) return { success: true };
    try {
      const { set, remove, result } = operation(storage.values(), plain(message), Date.now());
      storage.store(plain(set), plain(remove));
      return { success: true, result: plain(result) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };
}

// A lock past its grace period.
function storedLock({ until = Date.now() + 3 * DAY, delay = DAY, pending = [] } = {}) {
  return { until, delay, lastId: pending.length, pending, recent: [] };
}

// A time as a datetime-local field holds it.
function fieldTime(time) {
  const date = new Date(time);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function settleAll() {
  for (let index = 0; index < 4; index += 1) await settle();
}

test("asks before locking, says what the lock does, and locks once its box is checked", async () => {
  const popup = await loadPopup({ autoResolveWrites: true, sendMessage: lockBackground() });
  const { elements } = popup;
  assert.equal(elements["lock-banner"].hidden, true);
  assert.equal(elements["lock-start"].hidden, false);
  assert.equal(elements["lock-change"].hidden, true);
  // A week from now, at a full hour, and a day's wait, to start with.
  assert.equal(elements["lock-delay"].value, String(DAY));
  assert.deepEqual(elements["lock-delay"].children.map((option) => option.textContent),
    ["1 hour", "6 hours", "1 day", "3 days", "7 days", "Until the lock ends"]);
  const until = new Date(elements["lock-until"].value).getTime();
  assert.ok(until > Date.now() + 7 * DAY && until <= Date.now() + 7 * DAY + HOUR);
  assert.equal(new Date(until).getMinutes(), 0);

  elements["lock-delay"].value = String(HOUR);
  elements["lock-start"].click();
  assert.equal(elements["lock-confirm"].hidden, false);
  assert.equal(elements["lock-confirm-title"].textContent, "Lock your settings for 7 days?");
  assert.equal(elements["lock-confirm-title"].focused, true);
  const details = elements["lock-confirm-details"].children.map((item) => item.textContent);
  assert.match(details[0], /^Until /);
  assert.ok(details.includes("Blocking or hiding more applies at once."));
  assert.ok(details.some((detail) => /turning a filter off, waits 1 hour\.$/.test(detail)));
  assert.ok(details.includes("Ending the lock early waits 1 hour too."));
  assert.ok(details.includes("You can take back a change, or the lock itself, within 10 minutes."));
  assert.equal(elements["lock-acknowledge-text"].textContent,
    "I understand that loosening my settings will take 1 hour");
  assert.equal(elements["lock-confirm-button"].textContent, "Lock for 7 days");

  // Nothing locks before the box is checked.
  assert.equal(elements["lock-confirm-button"].disabled, true);
  await elements["lock-confirm-button"].click();
  assert.deepEqual(popup.sentMessages, []);
  elements["lock-acknowledge"].checked = true;
  elements["lock-acknowledge"].dispatch("change");
  assert.equal(elements["lock-confirm-button"].disabled, false);

  await elements["lock-confirm-button"].click();
  await settleAll();
  assert.deepEqual(plain(popup.sentMessages), [{ action: "startLock", until, delay: HOUR }]);
  assert.equal(popup.stored().settingsLock.until, until);
  assert.equal(elements["lock-confirm"].hidden, true);
  assert.match(elements.toast.textContent, /^Settings locked until /);
  assert.equal(elements["lock-heading"].focused, true);
  // Locked: the status, above every tab, and its card.
  assert.equal(elements["lock-banner"].hidden, false);
  assert.match(elements["lock-banner-text"].textContent, /^Locked until [^·]+$/);
  assert.match(elements["lock-state"].textContent, /^Locked until /);
  assert.equal(elements["lock-text"].textContent,
    "Changes that loosen your settings wait 1 hour, or until the lock ends.");
  assert.equal(elements["lock-fields"].hidden, true);
  assert.equal(elements["lock-start"].hidden, true);
  assert.equal(elements["lock-change"].hidden, false);
  assert.equal(elements["lock-end"].hidden, false);
  // No setting was written.
  assert.deepEqual(popup.writes, []);
});

test("warns when the lock cannot end before it does", async () => {
  const { elements } = await loadPopup({ sendMessage: lockBackground() });
  elements["lock-delay"].value = "end";
  elements["lock-start"].click();
  const details = elements["lock-confirm-details"].children.map((item) => item.textContent);
  assert.ok(details.some((detail) => /waits until the lock ends\.$/.test(detail)));
  assert.ok(details.includes("The lock can't end early."));
  assert.match(elements["lock-acknowledge-text"].textContent,
    /^I understand that I can't loosen my settings until /);
});

test("refuses an end it cannot use, and closes the warning when cancelled or changed", async () => {
  const popup = await loadPopup({ sendMessage: lockBackground() });
  const { elements } = popup;
  const refusals = [
    ["", "Choose when the lock ends"],
    [fieldTime(Date.now() - HOUR), "Choose a time in the future"],
    [fieldTime(Date.now() + 400 * DAY), "A lock can last a year at most"],
  ];
  for (const [value, message] of refusals) {
    elements["lock-until"].value = value;
    elements["lock-start"].click();
    assert.equal(elements["lock-confirm"].hidden, true, value);
    assert.equal(elements.toast.textContent, message);
  }

  elements["lock-until"].value = fieldTime(Date.now() + 2 * DAY);
  elements["lock-start"].click();
  assert.equal(elements["lock-confirm-title"].textContent, "Lock your settings for 2 days?");
  // A warning about values that changed since would mislead.
  elements["lock-delay"].dispatch("change");
  assert.equal(elements["lock-confirm"].hidden, true);

  elements["lock-start"].click();
  let prevented = false;
  elements["lock-confirm"].dispatch("keydown", { key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(elements["lock-confirm"].hidden, true);
  assert.equal(elements["lock-start"].focused, true);

  elements["lock-start"].click();
  elements["lock-acknowledge"].checked = true;
  elements["lock-acknowledge"].dispatch("change");
  elements["lock-confirm-cancel"].click();
  assert.equal(elements["lock-confirm"].hidden, true);
  // Opened again, the box needs checking again.
  elements["lock-start"].click();
  assert.equal(elements["lock-acknowledge"].checked, false);
  assert.equal(elements["lock-confirm-button"].disabled, true);
  assert.deepEqual(popup.sentMessages, []);
});

test("saves through the lock while settings are locked, and says what waits", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { hideNsfw: true, hideSpoilers: false, hideAds: true, settingsLock: storedLock() },
    sendMessage: lockBackground(),
  });
  const { elements } = popup;
  assert.equal(elements["lock-banner"].hidden, false);

  elements["hide-nsfw"].checked = false;
  elements["hide-nsfw"].dispatch("change");
  await settleAll();
  assert.deepEqual(popup.writes, []);
  assert.deepEqual(plain(popup.sentMessages), [{ action: "saveSettings", settings: { hideNsfw: false } }]);
  // The switch shows the setting as it applies.
  assert.equal(elements["hide-nsfw"].checked, true);
  assert.match(elements.toast.textContent, /^Turn off “Hide NSFW content”: waits until /);
  assert.match(elements["lock-banner-text"].textContent, /· 1 change waiting$/);
  const [item] = elements["lock-pending-list"].querySelectorAll(".lock-pending-item");
  assert.equal(item.querySelector(".lock-pending-change").textContent, "Turn off “Hide NSFW content”");
  assert.match(item.querySelector(".lock-pending-when").textContent, /^Waits until /);

  // Hiding more applies at once.
  elements["hide-spoilers"].checked = true;
  elements["hide-spoilers"].dispatch("change");
  await settleAll();
  assert.equal(popup.stored().hideSpoilers, true);
  assert.equal(elements["hide-spoilers"].checked, true);

  // Showing ads is free: no impulse would loosen it.
  elements["hide-ads"].checked = false;
  elements["hide-ads"].dispatch("change");
  await settleAll();
  assert.equal(popup.stored().hideAds, false);
  assert.equal(elements["hide-ads"].checked, false);
  assert.match(elements["lock-banner-text"].textContent, /· 1 change waiting$/);
});

test("names switches by their group, and those that block pages by their page", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockPopular: true, hideNavbar: true, settingsLock: storedLock() },
    sendMessage: lockBackground(),
  });
  const { elements } = popup;
  elements["block-popular"].checked = false;
  elements["block-popular"].dispatch("change");
  await settleAll();
  assert.match(elements.toast.textContent, /^Turn off “Block Popular”/);

  // A switch with its sections waits as one change.
  elements["hide-navbar"].checked = false;
  elements["hide-navbar"].dispatch("change");
  await settleAll();
  assert.match(elements.toast.textContent, /^7 changes wait until /);
  const texts = elements["lock-pending-list"].querySelectorAll(".lock-pending-change")
    .map((element) => element.textContent);
  assert.deepEqual(texts, ["Turn off “Block Popular”", "Turn off “Hide navbar”"]);
});

test("saves a rule once typed while locked, not at each step of typing it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedSubreddits: [{ name: "*", mode: "all" }], settingsLock: storedLock() },
    sendMessage: lockBackground(),
  });
  const { elements } = popup;
  elements["add-subreddit"].click();
  const input = getRenderedItems(elements)[0].querySelector("input");
  input.value = "+ask";
  input.dispatch("input");
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(popup.sentMessages, []);

  input.value = "+askreddit";
  input.dispatch("input");
  input.dispatch("blur");
  await settleAll();
  assert.deepEqual(plain(popup.sentMessages), [{
    action: "saveSettings",
    settings: { blockedSubreddits: [{ name: "*", mode: "all" }], allowedSubreddits: ["askreddit"] },
  }]);
  // The exception waits: the list shows the rules as they apply.
  assert.deepEqual(plain(popup.stored().allowedSubreddits ?? []), []);
  assert.equal(getRenderedItems(elements).length, 1);
  assert.match(elements.toast.textContent, /^Allow r\/askreddit: waits until /);
});

test("keeps a removed rule, with the change that waits to remove it", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: {
      blockedSubreddits: [{ name: "news", mode: "all" }],
      blockedTitleKeywords: ["election"],
      settingsLock: storedLock(),
    },
    sendMessage: lockBackground(),
  });
  const { elements } = popup;
  getRenderedKeywords(elements)[0].querySelector(".remove-btn").click();
  await settleAll();
  assert.equal(getRenderedKeywords(elements).length, 1);
  assert.equal(getRenderedKeywords(elements)[0].querySelector("input").value, "election");
  assert.match(elements.toast.textContent, /^Remove keyword “election”: waits until /);
});

test("shows what waits, and cancels it", async () => {
  const now = Date.now();
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: {
      hideNavbar: true,
      settingsLock: storedLock({
        pending: [
          { id: 1, at: now, due: now + DAY, changes: [{ key: "allowedSubreddits", rule: "askreddit", value: "askreddit" }] },
          { id: 2, at: now, due: now + HOUR, changes: [{ key: "hideNavbar", value: false }, { key: "hideNavbarMenu", value: false }] },
        ],
      }),
    },
    sendMessage: lockBackground(),
  });
  const { elements } = popup;
  assert.equal(elements["lock-pending"].hidden, false);
  assert.match(elements["lock-banner-text"].textContent, /· 2 changes waiting$/);
  const items = elements["lock-pending-list"].querySelectorAll(".lock-pending-item");
  // Soonest first.
  assert.deepEqual(items.map((item) => item.querySelector(".lock-pending-change").textContent),
    ["Turn off “Hide navbar”", "Allow r/askreddit"]);
  const cancel = items[0].querySelector(".lock-pending-cancel");
  assert.equal(cancel.getAttribute("aria-label"), "Cancel: Turn off “Hide navbar”");

  await cancel.click();
  await settleAll();
  assert.deepEqual(plain(popup.sentMessages), [{ action: "cancelLockedChange", id: 2 }]);
  assert.deepEqual(plain(popup.stored().settingsLock.pending.map(({ id }) => id)), [1]);
  assert.equal(elements.toast.textContent, "Change cancelled");
  assert.equal(elements["lock-pending-list"].querySelectorAll(".lock-pending-item").length, 1);

  // The banner leads to the lock.
  elements["lock-banner-details"].click();
  assert.equal(elements["tab-settings"].getAttribute("aria-selected"), "true");
  assert.equal(elements["lock-heading"].focused, true);
});

test("ends the lock after its delay, or at once when it was just made", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { settingsLock: storedLock() },
    sendMessage: lockBackground(),
  });
  await popup.elements["lock-end"].click();
  await settleAll();
  assert.deepEqual(plain(popup.sentMessages), [{ action: "saveSettings", settings: { lockUntil: 0 } }]);
  assert.match(popup.elements.toast.textContent, /^End the lock: waits until /);
  assert.ok(popup.stored().settingsLock);

  // A lock that waits until it ends cannot end early.
  const strict = await loadPopup({ storedSettings: { settingsLock: storedLock({ delay: null }) } });
  assert.equal(strict.elements["lock-end"].hidden, true);
  assert.equal(strict.elements["lock-text"].textContent,
    "Changes that loosen your settings wait until the lock ends.");

  // Just made, it ends at once.
  const fresh = await loadPopup({ autoResolveWrites: true, sendMessage: lockBackground() });
  fresh.elements["lock-start"].click();
  fresh.elements["lock-acknowledge"].checked = true;
  fresh.elements["lock-acknowledge"].dispatch("change");
  await fresh.elements["lock-confirm-button"].click();
  await settleAll();
  await fresh.elements["lock-end"].click();
  await settleAll();
  assert.equal(fresh.stored().settingsLock, undefined);
  assert.equal(fresh.elements.toast.textContent, "Lock ended");
  assert.equal(fresh.elements["lock-banner"].hidden, true);
  assert.equal(fresh.elements["lock-start"].hidden, false);
  // The fields offer a new lock.
  assert.ok(new Date(fresh.elements["lock-until"].value).getTime() > Date.now() + 7 * DAY);
});

test("extends the lock at once, from its fields", async () => {
  const until = Date.now() + 3 * DAY;
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { settingsLock: storedLock({ until }) },
    sendMessage: lockBackground(),
  });
  const { elements } = popup;
  elements["lock-change"].click();
  assert.equal(elements["lock-fields"].hidden, false);
  assert.equal(elements["lock-until"].value, fieldTime(until));
  assert.equal(elements["lock-delay"].value, String(DAY));
  assert.equal(elements["lock-save"].hidden, false);
  assert.equal(elements["lock-end"].hidden, true);

  // Unchanged, nothing is sent.
  await elements["lock-save"].click();
  assert.deepEqual(popup.sentMessages, []);
  assert.equal(elements["lock-fields"].hidden, true);

  elements["lock-change"].click();
  const later = new Date(until + 2 * DAY).setSeconds(0, 0);
  elements["lock-until"].value = fieldTime(later);
  await elements["lock-save"].click();
  await settleAll();
  assert.deepEqual(plain(popup.sentMessages), [{ action: "saveSettings", settings: { lockUntil: later } }]);
  assert.equal(popup.stored().settingsLock.until, later);
  assert.equal(elements.toast.textContent, "Lock changed");
  assert.equal(elements["lock-fields"].hidden, true);
});

test("imports and restores through the lock while settings are locked", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { blockedUsers: ["spez"], settingsLock: storedLock() },
    sendMessage: lockBackground(),
  });
  const { elements } = popup;
  elements["import-file"].files = [{ text: async () => JSON.stringify({ blockedUsers: [], hideAds: true }) }];
  elements["import-file"].dispatch("change");
  await settleAll();
  assert.match(elements["import-review-note"].textContent, /while settings are locked, what loosens them waits/);
  await elements["import-confirm"].click();
  await settleAll();

  assert.deepEqual(popup.writes, []);
  const [message] = plain(popup.sentMessages);
  assert.equal(message.action, "saveSettings");
  assert.equal(message.source, "import");
  assert.deepEqual(message.settings, { blockedUsers: [], hideAds: true });
  assert.deepEqual(Object.keys(message.extra), ["settingsVersion", "importBackup"]);
  assert.equal(popup.stored().hideAds, true);
  assert.deepEqual(plain(popup.stored().blockedUsers), ["spez"]);
  assert.match(elements.toast.textContent, /^Remove u\/spez: waits until /);
  assert.equal(elements["backup-restore"].hidden, false);

  // Restoring takes back what the import changed: showing ads again is
  // free, and the removal the import asked for still waits.
  await elements["restore-backup"].click();
  await settleAll();
  const restore = plain(popup.sentMessages).at(-1);
  assert.equal(restore.source, "restore");
  assert.equal(popup.stored().hideAds, false);
  assert.equal(elements.toast.textContent, "Settings restored");
  assert.deepEqual(plain(popup.stored().settingsLock.pending.flatMap(({ changes }) => changes)),
    [{ key: "blockedUsers", rule: "spez", value: null, entry: "spez" }]);
});

test("saves what is typed through the lock when the page closes", async () => {
  const popup = await loadPopup({
    autoResolveWrites: true,
    storedSettings: { limitInfiniteScroll: true, scrollLimit: 25, settingsLock: storedLock() },
    sendMessage: lockBackground(),
  });
  popup.elements["scroll-limit"].value = "40";
  popup.hide();
  await settleAll();
  assert.deepEqual(popup.writes, []);
  assert.deepEqual(plain(popup.sentMessages), [{ action: "saveSettings", settings: { scrollLimit: 40 } }]);
  assert.equal(popup.stored().scrollLimit, 25);
  assert.equal(popup.stored().settingsLock.pending.length, 1);
});

test("asks the background, once, to apply what came due", async () => {
  const now = Date.now();
  const popup = await loadPopup({
    storedSettings: {
      settingsLock: storedLock({
        pending: [{ id: 1, at: now - DAY, due: now - 1000, changes: [{ key: "hideAds", value: false }] }],
      }),
    },
  });
  await settleAll();
  assert.deepEqual(plain(popup.sentMessages), [{ action: "updateLock" }]);
  assert.equal(popup.elements["lock-pending-list"].querySelector(".lock-pending-when").textContent,
    "Applies now");
});
