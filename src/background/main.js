/**
 * FrontFilter's background script: keeps the declarative navigation rules in
 * step with the settings, and opens the settings page for other pages.
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

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local
    .remove(OBSOLETE_STORAGE_KEYS)
    .then(syncNavigationRules)
    .catch((error) => console.error("Could not migrate FrontFilter settings:", error));
});

chrome.runtime.onStartup.addListener(syncNavigationRulesInBackground);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((key) => FrontFilter.NAVIGATION_STORAGE_KEYS.includes(key))) {
    syncNavigationRulesInBackground();
  }
});

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
  return false;
});

syncNavigationRulesInBackground();
