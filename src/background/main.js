/**
 * FrontFilter's background script: keeps the declarative navigation rules in
 * step with the settings, opens the settings page for other pages, keeps
 * the statistics they record, adding the recorder to Reddit pages open
 * before an update, and keeps the settings lock.
 */

const ruleSyncQueue = FrontFilter.createQueue();

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
  return ruleSyncQueue.run(replaceNavigationRules);
}

function syncNavigationRulesInBackground() {
  void syncNavigationRules().catch((error) => {
    console.error("Could not update FrontFilter navigation rules:", error);
  });
}

// Stored settings carry the version of their format, as exports do, so
// that a later version can tell how to read them. A new installation's are
// this version's.
async function markSettingsVersion() {
  const versionKey = FrontFilter.SETTINGS_VERSION_KEY;
  const stored = await chrome.storage.local.get(versionKey);
  if (stored[versionKey] >= FrontFilter.SETTINGS_VERSION) return;
  await chrome.storage.local.set({ [versionKey]: FrontFilter.SETTINGS_VERSION });
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
  if (reason === "install") {
    void markSettingsVersion().catch((error) => {
      console.error("Could not store the version of FrontFilter's settings:", error);
    });
  }
  // The rules are this version's, whatever an earlier one left.
  syncNavigationRulesInBackground();
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
const STATS = FrontFilter.stats;
const statsQueue = FrontFilter.createQueue();

// Nothing is counted while statistics are paused.
function recordStats(record) {
  if (STATS.isEmptyRecord(record)) return Promise.resolve();
  return statsQueue.run(async () => {
    const key = STATS.STORAGE_KEY;
    const { [key]: stored, pauseStatistics } = await chrome.storage.local.get([key, "pauseStatistics"]);
    if (pauseStatistics === true) return;
    await chrome.storage.local.set({ [key]: STATS.addRecord(stored, record, Date.now()) });
  });
}

function resetStats() {
  return statsQueue.run(() => chrome.storage.local.remove([STATS.STORAGE_KEY]));
}

// The settings lock has one writer too: while it is on, the settings page
// asks the background to save settings, which applies what tightens them
// and keeps what loosens them waiting (shared/settings-lock.js). An alarm
// applies what waits once it is due, and ends the lock.
const LOCK = FrontFilter.settingsLock;
const LOCK_ALARM = "settingsLock";
const lockQueue = FrontFilter.createQueue();

// Runs a lock operation on the stored settings and lock, stores what it
// returns, and answers its result.
function updateLock(operation, message = {}) {
  return lockQueue.run(async () => {
    const stored = await chrome.storage.local.get([...FrontFilter.STORAGE_KEYS, LOCK.STORAGE_KEY]);
    const { set, remove, lock, result } = operation(stored, message, Date.now());
    if (Object.keys(set).length > 0) await chrome.storage.local.set(set);
    if (remove.length > 0) await chrome.storage.local.remove(remove);
    // Browsers may drop alarms when they restart: each update sets it again.
    if (lock) await chrome.alarms.create(LOCK_ALARM, { when: LOCK.nextUpdate(lock) });
    else await chrome.alarms.clear(LOCK_ALARM);
    return result;
  });
}

function updateLockInBackground() {
  void updateLock(LOCK.update).catch((error) => {
    console.error("Could not update the settings lock:", error);
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === LOCK_ALARM) updateLockInBackground();
});

function openSettings({ currentSubreddit, importing }) {
  const url = chrome.runtime.getURL(FrontFilter.settingsPagePath(
    currentSubreddit, { importing: importing === true },
  ));
  return chrome.tabs.create({ url });
}

// What pages ask for, by the action their message names. Each answers
// whether it succeeded (FrontFilter.askBackground).
const ACTIONS = Object.freeze({
  openSettings,
  // Extension pages wait for the rules before revisiting an unblocked page.
  syncNavigationRules,
  recordStats: ({ record }) => recordStats(record),
  resetStats,
});

// The lock's operations also answer their result: what waits, and the lock.
const LOCK_ACTIONS = Object.freeze({
  startLock: LOCK.start,
  saveSettings: LOCK.save,
  cancelLockedChange: LOCK.cancel,
  updateLock: LOCK.update,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message?.action;
  let answer;
  if (Object.hasOwn(ACTIONS, action)) {
    answer = async () => {
      await ACTIONS[action](message);
      return { success: true };
    };
  } else if (Object.hasOwn(LOCK_ACTIONS, action)) {
    answer = async () => ({ success: true, result: await updateLock(LOCK_ACTIONS[action], message) });
  } else {
    // Not a message for the background.
    return false;
  }
  answer().then(sendResponse, (error) => {
    sendResponse({ success: false, error: error?.message ?? String(error) });
  });
  // The answer comes later.
  return true;
});

syncNavigationRulesInBackground();
// What came due while the browser was closed applies now.
updateLockInBackground();
