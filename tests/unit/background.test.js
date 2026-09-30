const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadBackground({
  dynamicRules = [{ id: 42 }],
  settings = {},
} = {}) {
  const listeners = {};
  const updates = [];
  const removedKeys = [];
  const createdTabs = [];
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
      getURL: (path) => `chrome-extension://frontfilter/${path}`,
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
    },
    storage: {
      local: {
        async get() { return { ...storedSettings }; },
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
    },
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    chrome,
    createdTabs,
    console,
  });

  for (const file of [
    "shared/core.js",
    "background/navigation-rules.js",
    "background/main.js",
  ]) {
    const source = readFileSync(join(__dirname, "..", "..", "src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  await settle();
  await settle();

  return {
    chrome,
    createdTabs,
    listeners,
    removedKeys,
    rules: () => rules,
    setSettings(value) { storedSettings = { ...value }; },
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
