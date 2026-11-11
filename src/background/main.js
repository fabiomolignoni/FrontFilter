/**
 * FrontFilter's background script: keeps the declarative navigation rules in
 * step with the settings, opens the settings page for other pages, and
 * keeps the statistics they record, adding the recorder to Reddit pages
 * open before an update.
 */

// These settings belonged to features removed in previous releases. Removing
// them on update prevents stale data from surviving indefinitely.
const OBSOLETE_STORAGE_KEYS = ["blockNsfw", "blockAll", "blockNew", "blockTop"];
let ruleSyncQueue = Promise.resolve();

// Chrome compiles each rule's regular expression within a small memory
// budget, which a long HOME rule or a pattern with several wildcards can
// exceed, and then rejects the whole update. The rules it can compile still
// apply; the content script blocks the other pages once they load.
async function compilableRules(rules) {
  const support = await Promise.all(rules.map(({ condition }) =>
    chrome.declarativeNetRequest.isRegexSupported({
      regex: condition.regexFilter,
      isCaseSensitive: condition.isUrlFilterCaseSensitive,
    })
  ));
  return rules.filter((_, index) => support[index].isSupported);
}

async function replaceNavigationRules() {
  const [storedSettings, currentRules] = await Promise.all([
    chrome.storage.local.get(FrontFilter.NAVIGATION_STORAGE_KEYS),
    chrome.declarativeNetRequest.getDynamicRules(),
  ]);
  const removeRuleIds = currentRules
    .filter(({ id }) => FrontFilter.isNavigationRuleId(id))
    .map(({ id }) => id);
  const addRules = FrontFilter.createNavigationRules(
    storedSettings,
    chrome.runtime.getURL("blocked/index.html"),
  );

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (error) {
    if (!chrome.declarativeNetRequest.isRegexSupported) throw error;
    const compilable = await compilableRules(addRules);
    if (compilable.length === addRules.length) throw error;
    console.warn(
      `FrontFilter left out ${addRules.length - compilable.length} navigation rules`
      + " the browser cannot compile:", error,
    );
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: compilable });
  }
}

// Synchronizations run one at a time, so the last one reflects the latest
// settings even when an earlier one failed.
function syncNavigationRules() {
  ruleSyncQueue = ruleSyncQueue
    .catch(() => undefined)
    .then(replaceNavigationRules);
  return ruleSyncQueue;
}

function syncNavigationRulesInBackground() {
  void syncNavigationRules().catch((error) => {
    console.error("Could not update FrontFilter navigation rules:", error);
  });
}

// Settings saved by an earlier version, which has no settings version or an
// older one, keep their meaning once upgraded. A new installation has none.
async function upgradeStoredSettings(reason) {
  const versionKey = FrontFilter.SETTINGS_VERSION_KEY;
  const stored = await chrome.storage.local.get([versionKey, "blockedTitleKeywords"]);
  if (stored[versionKey] >= FrontFilter.SETTINGS_VERSION) return;
  await chrome.storage.local.set(reason === "install"
    ? { [versionKey]: FrontFilter.SETTINGS_VERSION }
    : FrontFilter.upgradeSettings(stored));
}

// Chrome gives no content script to the Reddit pages already open when
// FrontFilter is installed or updated, and the one a page had before an
// update can no longer reach FrontFilter: the time spent there would go
// uncounted until the page is reloaded, and moving between Reddit's pages
// reloads none. Such pages get the statistics recorder alone
// (content/stats-only.js); their filters wait for their next load, as
// before. Firefox gives open pages their content scripts itself, and its
// manifest asks for no permission to add any.
const STATS_RECORDER_SCRIPTS = Object.freeze([
  "shared/core.js", "shared/stats.js", "content/stats-recorder.js", "content/stats-only.js",
]);

async function addStatsRecorder(tabId) {
  try {
    // A page whose content script runs has FrontFilter in the content
    // scripts' world. The recorder goes to the page checked, not to one
    // loaded since, which has its content script.
    const [{ result: hasContentScript, documentId }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof FrontFilter !== "undefined",
    });
    if (hasContentScript) return;
    await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      files: STATS_RECORDER_SCRIPTS,
    });
  } catch {
    // Some pages run no script, such as discarded tabs, which load again,
    // with their content script, once shown.
  }
}

async function addStatsRecorders() {
  if (!chrome.scripting) return;
  const { matches } = chrome.runtime.getManifest().content_scripts.find(({ world }) => world !== "MAIN");
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(tabs.map(({ id }) => addStatsRecorder(id)));
}

chrome.runtime.onInstalled.addListener(({ reason } = {}) => {
  void chrome.storage.local
    .remove(OBSOLETE_STORAGE_KEYS)
    .then(() => upgradeStoredSettings(reason))
    .then(syncNavigationRules)
    .catch((error) => console.error("Could not migrate FrontFilter settings:", error));
  if (reason === "install" || reason === "update") {
    void addStatsRecorders().catch((error) => {
      console.error("Could not count the time on open Reddit pages:", error);
    });
  }
});

chrome.runtime.onStartup.addListener(syncNavigationRulesInBackground);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((key) => FrontFilter.NAVIGATION_STORAGE_KEYS.includes(key))) {
    syncNavigationRulesInBackground();
  }
});

// Statistics have one writer, which adds pages' records one at a time:
// writes from several tabs at once would otherwise drop each other's.
let statsQueue = Promise.resolve();

function updateStats(operation) {
  statsQueue = statsQueue.catch(() => undefined).then(operation);
  return statsQueue;
}

// Nothing is counted while statistics are paused.
function recordStats(record) {
  if (FrontFilter.stats.isEmptyRecord(record)) return Promise.resolve();
  return updateStats(async () => {
    const key = FrontFilter.stats.STORAGE_KEY;
    const { [key]: stored, pauseStatistics } = await chrome.storage.local.get([key, "pauseStatistics"]);
    if (pauseStatistics === true) return;
    await chrome.storage.local.set({ [key]: FrontFilter.stats.addRecord(stored, record, Date.now()) });
  });
}

function resetStats() {
  return updateStats(() => chrome.storage.local.remove([FrontFilter.stats.STORAGE_KEY]));
}

// Answers a message with whether the operation succeeded.
function respond(operation, sendResponse) {
  operation.then(
    () => sendResponse({ success: true }),
    (error) => sendResponse({ success: false, error: error?.message ?? String(error) }),
  );
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "openSettings") {
    const url = chrome.runtime.getURL(FrontFilter.settingsPagePath(message.currentSubreddit));
    return respond(chrome.tabs.create({ url }), sendResponse);
  }
  // Extension pages wait for the rules before revisiting an unblocked page.
  if (message?.action === "syncNavigationRules") {
    return respond(syncNavigationRules(), sendResponse);
  }
  if (message?.action === "recordStats") {
    return respond(recordStats(message.record), sendResponse);
  }
  if (message?.action === "resetStats") {
    return respond(resetStats(), sendResponse);
  }
  return false;
});

syncNavigationRulesInBackground();
