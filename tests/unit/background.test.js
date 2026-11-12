const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { STATS_RECORDER_SCRIPTS, readSource, runScripts, settle } = require("./helpers");

const manifest = JSON.parse(readSource("manifest.json"));

async function loadBackground({
  dynamicRules = [{ id: 42 }],
  settings = {},
  // Chrome's, as Firefox's manifest asks for no scripting permission.
  scripting,
  openTabs = [],
} = {}) {
  const listeners = {};
  const updates = [];
  const removedKeys = [];
  const storedValues = [];
  const createdTabs = [];
  const tabQueries = [];
  let storedSettings = { ...settings };
  let rules = dynamicRules.map((rule) => ({ ...rule }));

  const chrome = {
    declarativeNetRequest: {
      async getDynamicRules() {
        return rules;
      },
      async updateDynamicRules(update) {
        updates.push(update);
        const removed = new Set(update.removeRuleIds);
        rules = rules.filter(({ id }) => !removed.has(id)).concat(update.addRules);
      },
    },
    runtime: {
      getManifest: () => structuredClone(manifest),
      getURL: (path) => `chrome-extension://frontfilter/${path}`,
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
    },
    storage: {
      local: {
        async get() { return { ...storedSettings }; },
        async set(values) {
          storedValues.push(values);
          storedSettings = { ...storedSettings, ...values };
        },
        async remove(keys) {
          removedKeys.push(...keys);
          for (const key of keys) delete storedSettings[key];
        },
      },
      onChanged: { addListener(listener) { listeners.storageChanged = listener; } },
    },
    tabs: {
      async create(options) {
        createdTabs.push(options);
        return options;
      },
      async query(options) {
        tabQueries.push(options);
        return openTabs;
      },
    },
  };
  if (scripting) chrome.scripting = scripting;
  // The lock's one alarm, by name, as browsers keep it.
  const alarms = new Map();
  chrome.alarms = {
    async create(name, info) { alarms.set(name, info); },
    async clear(name) { return alarms.delete(name); },
    onAlarm: { addListener(listener) { listeners.alarm = listener; } },
  };
  // Each background gets its own console, so tests can read its warnings.
  const backgroundConsole = { error: console.error, warn: console.warn };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    chrome,
    createdTabs,
    console: backgroundConsole,
  });

  runScripts(context, [
    "shared/core.js", "shared/stats.js", "shared/settings-lock.js",
    "background/navigation-rules.js", "background/main.js",
  ]);
  await settle();
  await settle();

  return {
    alarms,
    chrome,
    console: backgroundConsole,
    createdTabs,
    listeners,
    removedKeys,
    rules: () => rules,
    setSettings(value) { storedSettings = { ...value }; },
    storedSettings: () => storedSettings,
    storedValues,
    tabQueries,
    updates,
  };
}

function sendMessage(listener, message) {
  return new Promise((resolve, reject) => {
    const keepsChannelOpen = listener(message, {}, resolve);
    if (!keepsChannelOpen) reject(new Error("Message channel was not kept open"));
  });
}

test("synchronizes owned DNR rules without touching rules from other features", async () => {
  const background = await loadBackground({
    dynamicRules: [{ id: 42 }, { id: 1007 }],
    settings: { blockPopular: true },
  });

  assert.equal(background.updates.length, 1);
  assert.deepEqual(background.updates[0].removeRuleIds, [1007]);
  assert.equal(background.updates[0].addRules.length, 1);
  assert.match(background.updates[0].addRules[0].condition.regexFilter, /r\/popular/);
  assert.ok(background.rules().some(({ id }) => id === 42));
});

test("resynchronizes only for relevant local setting changes", async () => {
  const background = await loadBackground();
  background.setSettings({ blockPopular: true });

  background.listeners.storageChanged({ unrelated: { newValue: true } }, "local");
  background.listeners.storageChanged({ theme: { newValue: "dark" } }, "local");
  background.listeners.storageChanged({ hideNavbar: { newValue: true } }, "local");
  background.listeners.storageChanged({ blockPopular: { newValue: true } }, "sync");
  await settle();
  assert.equal(background.updates.length, 1);

  background.listeners.storageChanged({ blockPopular: { newValue: true } }, "local");
  await settle();
  await settle();
  assert.equal(background.updates.length, 2);
  assert.match(background.updates[1].addRules[0].condition.regexFilter, /r\/popular/);

  // Blocking a user blocks their profile before it loads.
  background.setSettings({ blockedUsers: ["spez"] });
  background.listeners.storageChanged({ blockedUsers: { newValue: ["spez"] } }, "local");
  await settle();
  await settle();
  assert.equal(background.updates.length, 3);
  assert.match(background.updates[2].addRules[0].condition.regexFilter, /r\/u_\)spez/);

  // Rules redirect to the website chosen in the settings.
  background.setSettings({
    blockedUsers: ["spez"], redirectBlockedPages: true, redirectUrl: "https://example.com/",
  });
  background.listeners.storageChanged({ redirectBlockedPages: { newValue: true } }, "local");
  await settle();
  await settle();
  assert.equal(background.updates.length, 4);
  assert.equal(background.updates[3].addRules[0].action.redirect.url, "https://example.com/");
});

test("removes obsolete settings when the extension is installed or updated", async () => {
  const background = await loadBackground({
    settings: {
      blockNsfw: true,
      blockAll: true,
      blockNew: true,
      blockTop: true,
      blockHomepage: true,
    },
  });

  background.listeners.installed({ reason: "update" });
  await settle();
  await settle();

  assert.deepEqual(
    background.removedKeys,
    ["blockNsfw", "blockAll", "blockNew", "blockTop"],
  );
  assert.equal(background.updates.length, 2);
  assert.equal(background.updates[1].addRules.length, 1);
});

test("upgrades keywords saved by an earlier version once, so they match the same texts", async () => {
  const background = await loadBackground({
    settings: { blockedTitleKeywords: ["ai", "[50%]", "/r/", "climate change"], blockHomepage: true },
  });

  background.listeners.installed({ reason: "update" });
  await settle();
  await settle();

  assert.deepEqual(JSON.parse(JSON.stringify(background.storedSettings())), {
    blockedTitleKeywords: ["*ai*", "[50%]", "/\\/r\\//", "*climate change*"],
    blockHomepage: true,
    settingsVersion: 2,
  });
  assert.equal(background.updates.length, 2);

  // Settings already upgraded, or written by this version, stay as they are.
  background.listeners.installed({ reason: "update" });
  background.listeners.installed({ reason: "browser_update" });
  await settle();
  await settle();
  assert.equal(background.storedValues.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.storedSettings().blockedTitleKeywords)),
    ["*ai*", "[50%]", "/\\/r\\//", "*climate change*"],
  );
});

test("marks a new installation's settings as this version's", async () => {
  const background = await loadBackground();

  background.listeners.installed({ reason: "install" });
  await settle();
  await settle();

  assert.deepEqual(JSON.parse(JSON.stringify(background.storedValues)), [{ settingsVersion: 2 }]);
  assert.equal(background.updates.length, 2);
});

// Chrome's scripting API for open tabs: in some, the content script runs,
// and others cannot run scripts at all, as discarded tabs.
function createScripting({ withContentScript = [], unscriptable = [] } = {}) {
  const injections = [];
  return {
    injections,
    async executeScript(injection) {
      injections.push(injection);
      const { tabId, documentIds } = injection.target;
      if (unscriptable.includes(tabId)) throw new Error("Cannot access contents of the page");
      const documentId = documentIds?.[0] ?? `document-${tabId}`;
      if (!injection.func) return [{ documentId, frameId: 0 }];
      // Chrome runs the function's source in the content scripts' world,
      // which holds their globals only.
      const world = vm.createContext(withContentScript.includes(tabId) ? { FrontFilter: {} } : {});
      return [{ documentId, frameId: 0, result: vm.runInContext(`(${injection.func})()`, world) }];
    },
  };
}

test("adds the statistics recorder alone to Reddit pages open when installed or updated", async () => {
  for (const reason of ["install", "update"]) {
    const scripting = createScripting({ withContentScript: [1], unscriptable: [3] });
    const background = await loadBackground({ scripting, openTabs: [{ id: 1 }, { id: 2 }, { id: 3 }] });

    background.listeners.installed({ reason });
    await settle();

    // The pages content scripts run on.
    assert.deepEqual(JSON.parse(JSON.stringify(background.tabQueries)), [{ url: ["*://*.reddit.com/*"] }]);
    assert.deepEqual(scripting.injections.map(({ target }) => target.tabId), [1, 2, 3, 2], reason);
    // Only the page without a content script gets the recorder, and only
    // the document checked: not one loaded since, which has its own.
    assert.deepEqual(JSON.parse(JSON.stringify(scripting.injections.at(-1))), {
      target: { tabId: 2, documentIds: ["document-2"] },
      files: STATS_RECORDER_SCRIPTS,
    });
  }
});

test("adds no recorder when the browser updates, or in Firefox, which adds content scripts itself", async () => {
  const scripting = createScripting();
  let background = await loadBackground({ scripting, openTabs: [{ id: 1 }] });
  background.listeners.installed({ reason: "browser_update" });
  background.listeners.installed({ reason: "chrome_update" });
  await settle();
  assert.deepEqual(background.tabQueries, []);
  assert.deepEqual(scripting.injections, []);

  background = await loadBackground({ openTabs: [{ id: 1 }] });
  background.listeners.installed({ reason: "update" });
  await settle();
  assert.deepEqual(background.tabQueries, []);
});

test("opens standalone settings and reports failures through message responses", async () => {
  const background = await loadBackground();

  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendMessage(
      background.listeners.message,
      { action: "openSettings", currentSubreddit: "Firefox" },
    ))),
    { success: true },
  );
  assert.equal(background.createdTabs.length, 1);
  assert.equal(
    background.createdTabs[0].url,
    "chrome-extension://frontfilter/popup/index.html?standalone=true&currentSubreddit=firefox",
  );

  background.chrome.tabs.create = async () => {
    throw new Error("tabs unavailable");
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendMessage(
      background.listeners.message,
      { action: "openSettings" },
    ))),
    { success: false, error: "tabs unavailable" },
  );
  assert.equal(background.listeners.message({ action: "unknown" }, {}, () => {}), false);
});

test("allows extension pages to await rule synchronization", async () => {
  const background = await loadBackground({ settings: { blockNews: true } });
  const response = await sendMessage(
    background.listeners.message,
    { action: "syncNavigationRules" },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { success: true });
  assert.equal(background.updates.length, 2);
});

test("synchronizes when the browser starts", async () => {
  const background = await loadBackground();
  background.setSettings({ blockExplore: true });
  background.listeners.startup();
  await settle();
  await settle();

  assert.equal(background.updates.length, 2);
  assert.match(background.updates[1].addRules[0].condition.regexFilter, /explore/);
});

test("keeps synchronizing after a failed synchronization, and reports it", async () => {
  const background = await loadBackground();
  const { declarativeNetRequest } = background.chrome;
  const updateDynamicRules = declarativeNetRequest.updateDynamicRules;
  declarativeNetRequest.updateDynamicRules = async () => {
    throw new Error("rule limit reached");
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendMessage(
      background.listeners.message,
      { action: "syncNavigationRules" },
    ))),
    { success: false, error: "rule limit reached" },
  );

  declarativeNetRequest.updateDynamicRules = updateDynamicRules;
  background.setSettings({ blockNews: true });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendMessage(
      background.listeners.message,
      { action: "syncNavigationRules" },
    ))),
    { success: true },
  );
  assert.match(background.updates.at(-1).addRules[0].condition.regexFilter, /news/);
});

test("leaves out only the rules the browser cannot compile", async () => {
  // As Chrome does, the update fails as a whole over one rule whose regular
  // expression exceeds the browser's memory budget.
  const tooComplex = (regex) => regex.includes("a".repeat(40));
  const background = await loadBackground();
  const { declarativeNetRequest } = background.chrome;
  const updateDynamicRules = declarativeNetRequest.updateDynamicRules;
  declarativeNetRequest.updateDynamicRules = async (update) => {
    const rule = update.addRules.find(({ condition }) => tooComplex(condition.regexFilter));
    if (rule) throw new Error(`Rule with id ${rule.id} exceeded the 2KB memory limit`);
    return updateDynamicRules(update);
  };
  declarativeNetRequest.isRegexSupported = async ({ regex, isCaseSensitive }) => {
    assert.equal(isCaseSensitive, false);
    return tooComplex(regex) ? { isSupported: false, reason: "memoryLimitExceeded" } : { isSupported: true };
  };
  const warnings = [];
  background.console.warn = (...args) => warnings.push(args);

  background.setSettings({
    blockPopular: true,
    blockedSubreddits: [{ name: "a".repeat(40), mode: "home" }, { name: "firefox", mode: "all" }],
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendMessage(
      background.listeners.message,
      { action: "syncNavigationRules" },
    ))),
    { success: true },
  );
  const regexes = background.rules()
    .filter(({ condition }) => condition)
    .map(({ condition }) => condition.regexFilter);
  assert.equal(regexes.length, 2);
  assert.match(regexes[0], /r\/popular/);
  assert.match(regexes[1], /r\/firefox/);
  assert.equal(warnings.length, 1);

  // Other failures are still reported.
  declarativeNetRequest.updateDynamicRules = async () => {
    throw new Error("rule limit reached");
  };
  background.setSettings({ blockNews: true });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await sendMessage(
      background.listeners.message,
      { action: "syncNavigationRules" },
    ))),
    { success: false, error: "rule limit reached" },
  );
});

test("adds the records pages send to the statistics, one at a time", async () => {
  const background = await loadBackground();
  const record = (posts) => sendMessage(background.listeners.message, { action: "recordStats", record: { posts } });
  // Sent together, as from two tabs: neither replaces the other.
  const responses = await Promise.all([record({ ads: 2 }), record({ keywords: 1 }), record({ ads: 1 })]);
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), Array(3).fill({ success: true }));

  const { stats } = background.storedSettings();
  const [day] = Object.values(stats.days);
  assert.deepEqual(JSON.parse(JSON.stringify(day.posts)), { ads: 3, keywords: 1 });
  assert.equal(stats.totals.posts, 4);
  // Empty records write nothing.
  const writes = background.storedValues.length;
  await sendMessage(background.listeners.message, { action: "recordStats", record: { posts: { unknown: 1 } } });
  assert.equal(background.storedValues.length, writes);
});

test("counts nothing while statistics are paused", async () => {
  const background = await loadBackground({ settings: { pauseStatistics: true } });
  const response = await sendMessage(background.listeners.message, {
    action: "recordStats", record: { time: 60000, blocked: { "page:homepage": 1 } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { success: true });
  assert.equal("stats" in background.storedSettings(), false);
});

test("deletes the statistics after the records sent before", async () => {
  const background = await loadBackground();
  const recorded = sendMessage(background.listeners.message, {
    action: "recordStats", record: { posts: { ads: 1 } },
  });
  const reset = sendMessage(background.listeners.message, { action: "resetStats" });
  assert.deepEqual(JSON.parse(JSON.stringify(await reset)), { success: true });
  await recorded;
  assert.equal("stats" in background.storedSettings(), false);
  assert.deepEqual(background.removedKeys.filter((key) => key === "stats"), ["stats"]);

  // Counting starts again from there.
  await sendMessage(background.listeners.message, { action: "recordStats", record: { posts: { ads: 1 } } });
  assert.equal(background.storedSettings().stats.totals.posts, 1);
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("locks the settings, and saves them through the lock, as the settings page asks", async () => {
  const background = await loadBackground({ settings: { hideNsfw: true } });
  const ask = (message) => sendMessage(background.listeners.message, message);
  assert.deepEqual(plain([...background.alarms.keys()]), []);

  const until = Date.now() + 7 * DAY;
  const started = plain(await ask({ action: "startLock", until, delay: DAY }));
  assert.equal(started.success, true);
  assert.equal(started.result.lock.until, until);
  assert.equal(background.storedSettings().settingsLock.until, until);
  // The alarm wakes the background when the lock ends.
  assert.equal(background.alarms.get("settingsLock").when, until);

  // Past its grace period, turning a filter off waits a day.
  const lock = background.storedSettings().settingsLock;
  background.setSettings({
    ...background.storedSettings(),
    settingsLock: { ...lock, recent: [] },
  });
  const saved = plain(await ask({ action: "saveSettings", settings: { hideNsfw: false, hideAds: true } }));
  assert.equal(saved.success, true);
  assert.deepEqual(saved.result.waiting.map(({ key, value }) => [key, value]), [["hideNsfw", false]]);
  assert.equal(background.storedSettings().hideNsfw, true);
  assert.equal(background.storedSettings().hideAds, true);
  const [request] = background.storedSettings().settingsLock.pending;
  assert.equal(background.alarms.get("settingsLock").when, request.due);

  // Locking again is refused, and answered as such.
  assert.deepEqual(plain(await ask({ action: "startLock", until, delay: DAY })),
    { success: false, error: "Settings are already locked" });

  const cancelled = plain(await ask({ action: "cancelLockedChange", id: request.id }));
  assert.deepEqual(cancelled, { success: true, result: { cancelled: true } });
  assert.deepEqual(plain(background.storedSettings().settingsLock.pending), []);
  assert.equal(background.alarms.get("settingsLock").when, until);
});

test("applies what waits when its alarm rings, and ends the lock, clearing the alarm", async () => {
  const now = Date.now();
  const settingsLock = {
    until: now + DAY,
    delay: HOUR,
    lastId: 2,
    pending: [
      { id: 1, at: now - 2 * HOUR, due: now - HOUR, changes: [{ key: "hideNsfw", value: false }] },
      { id: 2, at: now, due: now + HOUR, changes: [{ key: "allowedSubreddits", rule: "askreddit", value: "askreddit" }] },
    ],
    recent: [],
  };
  // What came due while the browser was closed applies as it starts.
  const background = await loadBackground({ settings: { hideNsfw: true, settingsLock } });
  await settle();
  assert.equal(background.storedSettings().hideNsfw, false);
  assert.deepEqual(plain(background.storedSettings().settingsLock.pending.map(({ id }) => id)), [2]);
  assert.equal(background.alarms.get("settingsLock").when, now + HOUR);

  // Once the lock is over, the alarm applies the rest and ends it.
  background.setSettings({
    ...background.storedSettings(),
    settingsLock: { ...background.storedSettings().settingsLock, until: now - 1 },
  });
  background.listeners.alarm({ name: "elsewhere" });
  await settle();
  assert.ok(background.storedSettings().settingsLock);
  background.listeners.alarm({ name: "settingsLock" });
  await settle();
  await settle();
  assert.equal(background.storedSettings().settingsLock, undefined);
  assert.deepEqual(plain(background.storedSettings().allowedSubreddits), ["askreddit"]);
  assert.equal(background.alarms.has("settingsLock"), false);
  assert.ok(background.removedKeys.includes("settingsLock"));
});

test("writes nothing for the lock when there is none", async () => {
  const background = await loadBackground({ settings: { hideNsfw: true } });
  await settle();
  assert.deepEqual(background.storedValues, []);
  assert.deepEqual(background.removedKeys, []);
});
