/**
 * FrontFilter's settings page, shown as the toolbar popup and in a tab of
 * its own. Every change is saved as it is made.
 */

// The page speaks the language cached for it, once its messages load.
const languageReady = FrontFilter.i18n.startPage(document);

document.addEventListener("DOMContentLoaded", async () => {
  await languageReady;
  // The page's text, before anything reads it.
  FrontFilter.i18n.localizePage(document);
  const { t, plural, formatNumber } = FrontFilter.i18n;
  const pageParams = new URLSearchParams(globalThis.location?.search);
  const standalone = pageParams.get("standalone") === "true";
  // In a tab of its own, the card shows the subreddit this page was opened
  // for: the current tab is the page itself.
  const standaloneCurrentSubreddit = FrontFilter.normalizeExactSubredditName(
    pageParams.get("currentSubreddit"),
  );
  // In a tab of its own, the page fills it, and offers no tab to open.
  const openInTab = document.getElementById("open-in-tab");
  if (standalone) {
    document.body.classList.add("standalone");
    openInTab.hidden = true;
  }
  document.getElementById("app-version").textContent =
    `FrontFilter v${chrome.runtime.getManifest().version}`;

  // Keep panels mounted: switching sections must preserve edits and scroll position.
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  // Labels too long to sit beside their icons in their tabs, as some
  // languages' are, show alone, each taking the room it needs (popup.css).
  // The page checks again as its width changes, as a tab's does.
  const tabList = document.querySelector('[role="tablist"]');
  function fitTabs() {
    tabList.removeAttribute("data-compact");
    const tooLong = tabs.some((tab) => {
      const label = tab.querySelector("span");
      const icon = tab.querySelector(".icon");
      const gap = Number.parseFloat(globalThis.getComputedStyle?.(tab).columnGap) || 0;
      return label.scrollWidth + (icon?.getBoundingClientRect?.().width ?? 0) + gap > tab.clientWidth;
    });
    if (tooLong) tabList.setAttribute("data-compact", "");
  }
  fitTabs();
  if (globalThis.ResizeObserver) new ResizeObserver(fitTabs).observe(tabList);
  function selectTab(selectedTab) {
    for (const tab of tabs) {
      const selected = tab === selectedTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      let nextIndex;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[nextIndex]);
      tabs[nextIndex].focus();
    });
  }

  const content = document.querySelector("main");
  const saveIndicator = document.getElementById("save-indicator");
  const toast = document.getElementById("toast");
  const colorTheme = document.getElementById("color-theme");
  const languageSelect = document.getElementById("language");
  for (const { tag, name } of FrontFilter.i18n.languageNames()) {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = name;
    option.setAttribute("lang", tag);
    languageSelect.append(option);
  }
  const redirectUrl = document.getElementById("redirect-url");
  const redirectUrlOption = document.getElementById("redirect-url-option");

  // Each switch's name is the setting it stores.
  const switches = Object.fromEntries(Array.from(
    document.querySelectorAll('input[type="checkbox"][name]'),
    (input) => [input.name, input],
  ));
  // The scroll and comment limits: a switch, then a mode and a number of
  // posts or comments, kept as last saved while another is typed.
  const limits = [
    {
      switchKey: "limitInfiniteScroll", countKey: "scrollLimit", modeKey: "scrollMode",
      countId: "scroll-limit", modeId: "scroll-mode", invalid: t("scrollLimitInvalid"),
    },
    {
      switchKey: "limitComments", countKey: "commentLimit", modeKey: "commentLimitMode",
      countId: "comment-limit", modeId: "comment-limit-mode", invalid: t("commentLimitInvalid"),
    },
  ].map(({ countId, modeId, ...limit }) => ({
    ...limit,
    count: document.getElementById(countId),
    mode: document.getElementById(modeId),
    lastCount: FrontFilter.DEFAULT_SETTINGS[limit.countKey],
  }));
  // A parent switch checks and locks its sections, and turns them off with
  // it. While it is off with some sections on, it shows a mixed state.
  const switchGroups = Object.entries(FrontFilter.SETTING_GROUPS).map(([parent, sections]) => ({
    parent: switches[parent],
    sections: sections.map((section) => switches[section]),
    // Says how many sections a mixed group hides, as its switch cannot.
    summary: Array.from(document.querySelectorAll(".group-summary"))
      .find((element) => element.getAttribute("data-group") === parent),
  }));

  const PAGE_SWITCHES = new Set([
    ...FrontFilter.PAGE_ROUTES.map(({ key }) => key), "blockForYou", "blockSubHome",
  ]);

  // A setting's name as the page says it: a switch's label, after its
  // group's or its section's where the page joins them; a limit's option
  // by its limit's.
  function labelOf(key) {
    const limit = limits.find(({ countKey, modeKey }) => key === countKey || key === modeKey);
    const input = switches[limit ? limit.switchKey : key];
    if (!input) return key;
    const textOf = (element) => FrontFilter.normalizeText(element?.textContent ?? "");
    const row = textOf(input.parentElement?.querySelector(".row-label"));
    if (limit) return row;
    const ids = (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (ids.length > 1) {
      const [group, ...names] = ids.map((id) => textOf(document.getElementById(id)));
      return t("settingInGroup", group, names.join(" "));
    }
    const label = ids.length === 1 ? textOf(document.getElementById(ids[0])) : row;
    // The switches that block pages are named by the page alone.
    return PAGE_SWITCHES.has(key) ? t("blockPageSetting", label) : label;
  }

  // While settings are locked, the background saves them: what loosens
  // them waits (popup/lock-card.js).
  const lockCard = FrontFilter.createLockCard({
    showToast,
    labelOf,
    showLockSection: () => selectTab(document.getElementById("tab-settings")),
  });

  let toastTimer = null;
  let indicatorTimer = null;
  let debounceTimer = null;
  const pendingSaveKeys = new Set();
  // Settings being written, with the number of their writes in progress,
  // and for written settings, the last read started before their write ended.
  const savingKeys = new Map();
  const lastReadBeforeSave = new Map();
  // Writes run one at a time, so an older write cannot finish last.
  const saveQueue = FrontFilter.createQueue();
  // What the page shows of storage: it reads them together, and again when
  // any of them changes.
  const SHOWN_KEYS = Object.freeze([
    ...FrontFilter.STORAGE_KEYS,
    FrontFilter.IMPORT_BACKUP_KEY,
    FrontFilter.settingsLock.STORAGE_KEY,
  ]);
  let lastRead = 0;
  let lastShownRead = 0;
  let latestSaveId = 0;
  let controlsDisabled = false;
  let lastRedirectUrl = FrontFilter.DEFAULT_SETTINGS.redirectUrl;

  // Sections and help texts start collapsed; a mixed parent switch tells
  // what its sections hide.
  for (const toggle of document.querySelectorAll(".group-toggle, .help-toggle")) {
    const options = document.getElementById(toggle.getAttribute("aria-controls"));
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      options.hidden = !expanded;
    });
  }

  function setControlsDisabled(disabled) {
    controlsDisabled = disabled;
    for (const control of content.querySelectorAll("input, select, button")) {
      control.disabled = disabled;
    }
    lockCard.setDisabled(disabled);
    updateDependentControls();
    updateGroupControls();
    currentPage.update();
  }

  // Options that apply only while their switch is on: the limits' options
  // are disabled while it is off, and the redirect address hidden.
  function updateDependentControls() {
    for (const { switchKey, count, mode } of limits) {
      const disabled = controlsDisabled || !switches[switchKey].checked;
      count.disabled = disabled;
      mode.disabled = disabled;
    }
    redirectUrlOption.hidden = !switches.redirectBlockedPages.checked;
  }

  function updateGroupControls() {
    for (const { parent, sections, summary } of switchGroups) {
      for (const section of sections) {
        if (parent.checked) section.checked = true;
        section.disabled = controlsDisabled || parent.checked;
      }
      const hidden = sections.filter((section) => section.checked).length;
      parent.indeterminate = !parent.checked && hidden > 0;
      if (summary) {
        // A group may name its message of its own (data-i18n-partial), as
        // Hide comments does, whose one section would read "1 of 1 hidden".
        const partial = summary.getAttribute("data-i18n-partial");
        let text = "";
        if (parent.indeterminate) {
          text = partial ? t(partial) : plural("groupSummaryHidden", hidden, formatNumber(sections.length));
        }
        summary.textContent = text;
      }
    }
  }

  // A message stays for as long as it takes to read: longer ones, such as
  // those that say when a change applies, and those that report a problem
  // stay longer.
  function showToast(message, type = "info") {
    const shortest = type === "error" ? 4000 : 2500;
    const duration = Math.min(Math.max(shortest, message.length * 60), 8000);
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `show ${type}`;
    toastTimer = setTimeout(() => {
      toast.className = "";
    }, duration);
  }

  function showSaving() {
    clearTimeout(indicatorTimer);
    saveIndicator.textContent = t("saveSaving");
    saveIndicator.setAttribute("data-state", "saving");
    saveIndicator.classList.add("visible");
  }

  function showSaved(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = t("saveSaved");
    saveIndicator.setAttribute("data-state", "saved");
    indicatorTimer = setTimeout(() => saveIndicator.classList.remove("visible"), 1200);
  }

  function showSaveFailed(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = t("saveFailed");
    saveIndicator.setAttribute("data-state", "failed");
    saveIndicator.classList.add("visible");
  }

  function getSettingsSnapshot() {
    return {
      ...Object.fromEntries(
        Object.entries(switches).map(([key, input]) => [key, input.checked]),
      ),
      ...Object.assign({}, ...entryLists.map((list) => list.stored())),
      ...Object.fromEntries(limits.flatMap(({ countKey, modeKey, mode, lastCount }) => [
        [countKey, lastCount], [modeKey, mode.value],
      ])),
      theme: colorTheme.value,
      language: languageSelect.value,
      redirectUrl: lastRedirectUrl,
    };
  }

  // The given settings alone, as the page shows them.
  function snapshotOf(keys) {
    const snapshot = getSettingsSnapshot();
    return Object.fromEntries(Array.from(keys, (key) => [key, snapshot[key]]));
  }

  // Saves only the given settings, so this page cannot overwrite changes
  // made elsewhere, such as in another settings page, with stale values.
  function queueSave(keys) {
    const saveId = ++latestSaveId;
    const settings = snapshotOf(keys);
    for (const list of entryLists) list.updateCount();
    currentPage.update();
    showSaving();

    for (const key of keys) savingKeys.set(key, (savingKeys.get(key) || 0) + 1);
    const saved = () => {
      for (const key of keys) {
        const count = savingKeys.get(key) - 1;
        if (count > 0) savingKeys.set(key, count);
        else savingKeys.delete(key);
        lastReadBeforeSave.set(key, lastRead);
      }
    };
    // Through the lock, what waits stays as stored, which shows once saved.
    let throughLock = false;
    const save = saveQueue.run(async () => {
      if (!lockCard.savesThroughLock()) {
        await chrome.storage.local.set(settings);
        return;
      }
      throughLock = true;
      lockCard.report(await saveThroughLock(settings));
    });
    save.then(
      () => {
        saved();
        showSaved(saveId);
        if (throughLock) reloadSettings();
      },
      (error) => {
        saved();
        showSaveFailed(saveId);
        showToast(t("saveFailedBecause", error.message), "error");
        if (throughLock) reloadSettings();
      },
    );
    return save;
  }

  // Asks the background to save settings as the lock allows, with extra
  // values such as an import's backup, and returns what waits.
  function saveThroughLock(settings, { extra, source } = {}) {
    return FrontFilter.askBackground({
      action: "saveSettings", settings, ...(extra && { extra }), ...(source && { source }),
    });
  }

  function reloadSettings() {
    loadSettings().catch((error) => console.error("Could not reload FrontFilter settings:", error));
  }

  // Whether a read may lack an edit of the setting made on this page: one
  // not written yet, or written after the read started.
  function mayLackEdit(key, read) {
    return pendingSaveKeys.has(key) || savingKeys.has(key)
      || (lastReadBeforeSave.get(key) ?? 0) >= read;
  }

  // Saves what waits to be saved, and settles with the last write.
  function queuePendingSave() {
    if (pendingSaveKeys.size === 0) return saveQueue.last();

    const keys = new Set(pendingSaveKeys);
    pendingSaveKeys.clear();
    return queueSave(keys);
  }

  function cancelDebounce() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Typing saves once it pauses; other changes save at once.
  function scheduleAutoSave(keys, immediate = false) {
    for (const key of keys) pendingSaveKeys.add(key);
    cancelDebounce();

    if (immediate) {
      queuePendingSave();
      return;
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      queuePendingSave();
    }, 700);
  }

  async function flushPendingSave() {
    cancelDebounce();
    await queuePendingSave();
  }

  // A typed count, or null unless it is a positive whole number.
  function typedCount(limit) {
    const value = Number(limit.count.value);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }

  // A page closed before typing pauses, as a tab closed or the popup left
  // right after typing, would never save what was typed, nor a number or
  // an address typed but not yet committed. Values that can be used are
  // written at once: a write queued behind another could start after the
  // page is gone.
  globalThis.addEventListener("pagehide", () => {
    cancelDebounce();
    for (const limit of limits) {
      const value = typedCount(limit);
      if (value === null || value === limit.lastCount) continue;
      limit.lastCount = value;
      pendingSaveKeys.add(limit.countKey);
    }
    const url = FrontFilter.normalizeRedirectUrl(redirectUrl.value);
    if ((url || !redirectUrl.value.trim()) && url !== lastRedirectUrl) {
      lastRedirectUrl = url;
      pendingSaveKeys.add("redirectUrl");
    }
    if (pendingSaveKeys.size === 0) return;
    const settings = snapshotOf(pendingSaveKeys);
    pendingSaveKeys.clear();
    const write = lockCard.savesThroughLock()
      ? saveThroughLock(settings)
      : chrome.storage.local.set(settings);
    void write.catch(() => undefined);
  });

  // The lists of rules (popup/entry-list.js). While settings are locked, a
  // rule saves once typed, not as typing pauses: each step of typing it
  // would be a change of its own, which may wait.
  function saveList(keys, immediate) {
    if (!immediate && lockCard.savesThroughLock()) {
      for (const key of keys) pendingSaveKeys.add(key);
      return;
    }
    scheduleAutoSave(keys, immediate);
  }
  const createEntryList = (options) => FrontFilter.entryList.create(options, {
    saveSettings: saveList,
    isDisabled: () => controlsDisabled,
    showToast,
  });

  // Each list says its counts in words of its own, which agree with what
  // it counts.
  const subredditList = createEntryList({
    key: "blockedSubreddits",
    allowKey: "allowedSubreddits",
    title: t("subredditsTitle"),
    listId: "subreddit-list",
    searchLabel: t("subredditsSearch"),
    countId: "subreddit-count",
    addId: "add-subreddit",
    itemClass: "subreddit-item",
    normalizeList: FrontFilter.normalizeBlockedSubreddits,
    normalizeAllowList: FrontFilter.normalizeAllowedSubreddits,
    // Rules block a front page (HOME) or everything (ALL). The stored names
    // are kept; these read better beside Reddit's own Home feed and r/all.
    blockModes: [["home", t("subredditsModeFrontPage")], ["all", t("subredditsModeEverywhere")]],
    storesModes: true,
    // New rows block everywhere, as the Block buttons on Reddit do.
    defaultMode: "all",
    modeLabel: t("subredditsModeLabel"),
    placeholder: t("subredditsPlaceholder"),
    label: t("subredditsPlaceholder"),
    removeLabel: t("subredditsRemove"),
    emptyMessage: t("subredditsEmpty"),
    invalidMessage: t("subredditsInvalid"),
    countText: (count) => plural("subredditsCount", count),
    addedText: (count) => plural("subredditsAdded", count),
    noneNewText: t("subredditsNoneNew"),
    noMatchText: (query) => t("subredditsNoMatch", query),
  });
  const entryLists = [
    subredditList,
    createEntryList({
      key: "blockedTitleKeywords",
      allowKey: "allowedKeywords",
      title: t("keywordsTitle"),
      listId: "keyword-list",
      searchLabel: t("keywordsSearch"),
      countId: "keyword-count",
      addId: "add-keyword",
      itemClass: "keyword-item",
      normalizeList: FrontFilter.normalizeTitleKeywords,
      getRuleKey: FrontFilter.getKeywordKey,
      splitList: (text) => FrontFilter.splitList(text, { keywords: true }),
      blockModes: [["block", t("listModeHidden")]],
      modeLabel: t("listModeHideLabel"),
      placeholder: t("keywordsPlaceholder"),
      label: t("keywordsLabel"),
      removeLabel: t("keywordsRemove"),
      emptyMessage: t("keywordsEmpty"),
      invalidMessage: t("keywordsInvalid"),
      countText: (count) => plural("keywordsCount", count),
      addedText: (count) => plural("keywordsAdded", count),
      noneNewText: t("keywordsNoneNew"),
      noMatchText: (query) => t("keywordsNoMatch", query),
    }),
    createEntryList({
      key: "blockedFlairs",
      allowKey: "allowedFlairs",
      title: t("flairsTitle"),
      listId: "flair-list",
      searchLabel: t("flairsSearch"),
      countId: "flair-count",
      addId: "add-flair",
      itemClass: "flair-item",
      normalizeList: FrontFilter.normalizeBlockedFlairs,
      blockModes: [["block", t("listModeHidden")]],
      modeLabel: t("listModeHideLabel"),
      placeholder: t("flairsPlaceholder"),
      label: t("flairsLabel"),
      removeLabel: t("flairsRemove"),
      emptyMessage: t("flairsEmpty"),
      invalidMessage: t("flairsInvalid"),
      countText: (count) => plural("flairsCount", count),
      addedText: (count) => plural("flairsAdded", count),
      noneNewText: t("flairsNoneNew"),
      noMatchText: (query) => t("flairsNoMatch", query),
    }),
    createEntryList({
      key: "blockedUsers",
      title: t("usersTitle"),
      listId: "blocked-user-list",
      searchLabel: t("usersSearch"),
      countId: "blocked-user-count",
      addId: "add-blocked-user",
      itemClass: "user-item",
      normalizeList: FrontFilter.normalizeBlockedUsers,
      placeholder: t("usersPlaceholder"),
      label: t("usersPlaceholder"),
      removeLabel: t("usersRemove"),
      emptyMessage: t("usersEmpty"),
      invalidMessage: t("usersInvalid"),
      countText: (count) => plural("usersCount", count),
      addedText: (count) => plural("usersAdded", count),
      noneNewText: t("usersNoneNew"),
      noMatchText: (query) => t("usersNoMatch", query),
    }),
  ];

  // The card for the Reddit page open in the current tab
  // (popup/current-page.js).
  const currentPage = FrontFilter.createCurrentPageCard({
    standalone,
    openedFor: standaloneCurrentSubreddit,
    subredditList,
    blocksSubredditFronts: () => switches.blockSubHome.checked,
    isLocked: lockCard.isLocked,
    isDisabled: () => controlsDisabled,
    showToast,
    flushPendingSave,
  });

  // Export, import and restore (popup/configuration.js).
  const configuration = FrontFilter.createConfigurationCard({
    standalone,
    entryLists,
    lockCard,
    showToast,
    flushPendingSave,
    enqueueStorageOperation: saveQueue.run,
    saveThroughLock,
    loadSettings,
    setControlsDisabled,
    openSettingsTab,
  });

  // Shows the settings a storage read returned, except those the read may
  // predate an edit of: the page already shows that edit.
  function showSettings(settings, read) {
    const showSetting = (key, update) => {
      if (!mayLackEdit(key, read)) update(settings[key]);
    };
    for (const [key, input] of Object.entries(switches)) {
      showSetting(key, (checked) => { input.checked = checked; });
    }
    // A list shows its rules and exceptions together.
    for (const list of entryLists) {
      if (!list.keys.some((key) => mayLackEdit(key, read))) list.show(settings);
    }
    for (const limit of limits) {
      showSetting(limit.countKey, (value) => {
        // A number still being typed stays unless the stored one changed.
        if (value !== limit.lastCount) limit.count.value = String(value);
        limit.lastCount = value;
      });
      showSetting(limit.modeKey, (mode) => { limit.mode.value = mode; });
    }
    showSetting("theme", (theme) => { colorTheme.value = applyTheme(theme); });
    // A language chosen elsewhere, such as in another settings page, shows
    // once the page loads again in it.
    showSetting("language", (language) => {
      languageSelect.value = language;
      if (FrontFilter.i18n.pageNeedsReload(language)) reloadPage();
    });
    showSetting("redirectUrl", (url) => {
      // So does an address still being typed, unless the stored one changed.
      if (url !== lastRedirectUrl) redirectUrl.value = url;
      lastRedirectUrl = url;
    });
    updateDependentControls();
    updateGroupControls();
    currentPage.update();
  }

  // Reads can finish out of order: an older one never replaces a newer one.
  async function loadSettings() {
    const read = ++lastRead;
    const stored = await chrome.storage.local.get(SHOWN_KEYS);
    if (read < lastShownRead) return;
    lastShownRead = read;
    lockCard.show(stored[FrontFilter.settingsLock.STORAGE_KEY]);
    showSettings(FrontFilter.coerceSettings(stored), read);
    configuration.showBackup(stored[FrontFilter.IMPORT_BACKUP_KEY]);
  }

  for (const [key, input] of Object.entries(switches)) {
    input.addEventListener("change", () => {
      // Sections are saved with their parent, as storage implies them.
      const sections = FrontFilter.SETTING_GROUPS[key] || [];
      for (const section of sections) switches[section].checked = input.checked;
      updateDependentControls();
      updateGroupControls();
      scheduleAutoSave([key, ...sections], true);
    });
  }

  for (const limit of limits) {
    limit.count.addEventListener("change", () => {
      const value = typedCount(limit);
      if (value === null) {
        showToast(limit.invalid, "error");
        limit.count.value = String(limit.lastCount);
        return;
      }
      limit.lastCount = value;
      scheduleAutoSave([limit.countKey], true);
    });
    limit.mode.addEventListener("change", () => scheduleAutoSave([limit.modeKey], true));
  }
  // The address shows as it is saved, with its scheme; clearing it is allowed.
  redirectUrl.addEventListener("change", () => {
    const url = FrontFilter.normalizeRedirectUrl(redirectUrl.value);
    if (redirectUrl.value.trim() && !url) {
      showToast(t("blockPageAddressInvalid"), "error");
      redirectUrl.value = lastRedirectUrl;
      return;
    }
    redirectUrl.value = url;
    lastRedirectUrl = url;
    scheduleAutoSave(["redirectUrl"], true);
  });
  colorTheme.addEventListener("change", () => {
    colorTheme.value = applyTheme(colorTheme.value);
    scheduleAutoSave(["theme"], true);
  });
  // The page speaks a language once it loads in it: once the language is
  // saved, it loads again.
  languageSelect.addEventListener("change", async () => {
    pendingSaveKeys.add("language");
    try {
      await flushPendingSave();
    } catch {
      // The save says it failed.
      return;
    }
    if (FrontFilter.i18n.pageNeedsReload(languageSelect.value)) reloadPage();
  });

  function reloadPage() {
    globalThis.location?.reload?.();
  }

  // Saves what is being typed, opens the page in a tab, for the same
  // subreddit, and closes the popup.
  async function openSettingsTab({ importing = false } = {}) {
    await flushPendingSave().catch(() => undefined);
    const subreddit = currentPage.subreddit();
    try {
      await FrontFilter.askBackground({
        action: "openSettings", currentSubreddit: subreddit, ...(importing && { importing }),
      });
    } catch {
      const path = FrontFilter.settingsPagePath(subreddit, { importing });
      await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
    }
    globalThis.close?.();
  }
  openInTab.addEventListener("click", () => openSettingsTab());

  // Settings changed elsewhere, such as by a Block button on Reddit, the
  // block page or another settings page, show here too. Otherwise a list
  // saved here would put back rules removed elsewhere and drop rules added.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && SHOWN_KEYS.some((key) => Object.hasOwn(changes, key))) reloadSettings();
  });

  const statsTab = FrontFilter.createStatsTab({ showToast });

  // Opened from the popup's Import, the page offers its own, which can
  // open a file picker: browsers open one only on a click.
  const openedToImport = standalone && pageParams.get("import") === "true";
  if (openedToImport) selectTab(document.getElementById("tab-settings"));

  void currentPage.show();
  void statsTab.load();
  setControlsDisabled(true);
  loadSettings()
    .then(() => {
      setControlsDisabled(false);
      if (!openedToImport) return;
      configuration.focusImport();
      showToast(t("importChooseFile"));
    })
    .catch((error) => {
      showToast(t("loadFailed", error.message), "error");
    });
});
