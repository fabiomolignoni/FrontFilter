/**
 * FrontFilter's settings page, shown as the toolbar popup and in a tab of
 * its own. Every change is saved as it is made.
 */

document.addEventListener("DOMContentLoaded", () => {
  const pageParams = new URLSearchParams(globalThis.location?.search);
  // In a tab of its own, Add current adds the subreddit this page was opened for.
  const standaloneCurrentSubreddit = FrontFilter.normalizeAllowedSubreddits([
    pageParams.get("currentSubreddit"),
  ])[0] || "";
  if (pageParams.get("standalone") === "true") {
    document.body.classList.add("standalone");
  }
  document.getElementById("app-version").textContent =
    `FrontFilter v${chrome.runtime.getManifest().version}`;

  // Keep panels mounted: switching sections must preserve edits and scroll position.
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
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
  const importFile = document.getElementById("import-file");
  const scrollLimit = document.getElementById("scroll-limit");
  const scrollMode = document.getElementById("scroll-mode");
  const colorTheme = document.getElementById("color-theme");

  // Each switch's name is the setting it stores.
  const switches = Object.fromEntries(Array.from(
    document.querySelectorAll('input[type="checkbox"][name]'),
    (input) => [input.name, input],
  ));
  // A parent switch checks and locks its sections, and turns them off with
  // it. While it is off with some sections on, it shows a mixed state.
  const switchGroups = Object.entries(FrontFilter.SETTING_GROUPS).map(([parent, sections]) => ({
    parent: switches[parent],
    sections: sections.map((section) => switches[section]),
  }));

  let toastTimer = null;
  let indicatorTimer = null;
  let debounceTimer = null;
  const pendingSaveKeys = new Set();
  // Settings being written, with the number of their writes in progress,
  // and for written settings, the last read started before their write ended.
  const savingKeys = new Map();
  const lastReadBeforeSave = new Map();
  let saveQueue = Promise.resolve();
  let lastRead = 0;
  let lastShownRead = 0;
  let latestSaveId = 0;
  let controlsDisabled = false;
  let lastScrollLimit = FrontFilter.DEFAULT_SETTINGS.scrollLimit;

  // Sections start collapsed; a mixed parent switch tells what they hide.
  for (const toggle of document.querySelectorAll(".group-toggle")) {
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
    updateScrollControls();
    updateGroupControls();
  }

  function updateScrollControls() {
    const disabled = controlsDisabled || !switches.limitInfiniteScroll.checked;
    scrollLimit.disabled = disabled;
    scrollMode.disabled = disabled;
  }

  function updateGroupControls() {
    for (const { parent, sections } of switchGroups) {
      for (const section of sections) {
        if (parent.checked) section.checked = true;
        section.disabled = controlsDisabled || parent.checked;
      }
      parent.indeterminate = !parent.checked && sections.some((section) => section.checked);
    }
  }

  function showToast(message, type = "info") {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `show ${type}`;
    toastTimer = setTimeout(() => {
      toast.className = "";
    }, 2500);
  }

  function showSaving() {
    clearTimeout(indicatorTimer);
    saveIndicator.textContent = "Saving…";
    saveIndicator.classList.add("visible");
  }

  function showSaved(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = "Saved";
    indicatorTimer = setTimeout(() => saveIndicator.classList.remove("visible"), 1200);
  }

  function showSaveFailed(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = "Save failed";
    saveIndicator.classList.add("visible");
  }

  function getSettingsSnapshot() {
    return {
      ...Object.fromEntries(
        Object.entries(switches).map(([key, input]) => [key, input.checked]),
      ),
      ...Object.fromEntries(entryLists.map((list) => [list.key, list.values()])),
      scrollLimit: lastScrollLimit,
      scrollMode: scrollMode.value,
      theme: colorTheme.value,
    };
  }

  // Saves only the given settings, so this page cannot overwrite changes
  // made elsewhere, such as in another settings page, with stale values.
  function queueSave(keys) {
    const saveId = ++latestSaveId;
    const snapshot = getSettingsSnapshot();
    const settings = Object.fromEntries(Array.from(keys, (key) => [key, snapshot[key]]));
    for (const list of entryLists) list.updateCount();
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
    enqueueStorageOperation(() => chrome.storage.local.set(settings));
    saveQueue.then(
      () => {
        saved();
        showSaved(saveId);
      },
      (error) => {
        saved();
        showSaveFailed(saveId);
        showToast(`Save failed: ${error.message}`, "error");
      },
    );
    return saveQueue;
  }

  // Whether a read may lack an edit of the setting made on this page: one
  // not written yet, or written after the read started.
  function mayLackEdit(key, read) {
    return pendingSaveKeys.has(key) || savingKeys.has(key)
      || (lastReadBeforeSave.get(key) ?? 0) >= read;
  }

  // Writes run one at a time, so an older write cannot finish last.
  function enqueueStorageOperation(operation) {
    saveQueue = saveQueue.catch(() => undefined).then(operation);
    return saveQueue;
  }

  function queuePendingSave() {
    if (pendingSaveKeys.size === 0) return saveQueue;

    const keys = new Set(pendingSaveKeys);
    pendingSaveKeys.clear();
    return queueSave(keys);
  }

  // Typing saves once it pauses; other changes save at once.
  function scheduleAutoSave(keys, immediate = false) {
    for (const key of keys) pendingSaveKeys.add(key);
    clearTimeout(debounceTimer);
    debounceTimer = null;

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
    clearTimeout(debounceTimer);
    debounceTimer = null;
    await queuePendingSave();
  }

  // An editable list of filter rules. Each row is a draft that keeps what
  // the user types until the field loses focus; it is then normalized and
  // merged into an earlier row for the same rule. Saves store the
  // normalized list. With modes, each rule is blocked in HOME or ALL mode.
  function createEntryList({
    key, listId, countId, addId, itemClass, normalizeList, modes = false,
    placeholder, label, removeLabel, emptyMessage, invalidMessage, countNouns,
  }) {
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    let entries = [];
    let shown = false;

    function normalize(value) {
      const [normalized] = normalizeList([value]);
      return (modes ? normalized?.name : normalized) ?? "";
    }

    function values() {
      return normalizeList(entries.map(({ value, mode }) => (modes ? { name: value, mode } : value)));
    }

    function updateCount() {
      const count = values().length;
      countEl.textContent = `${count} ${count === 1 ? countNouns[0] : countNouns[1]}`;
    }

    function save(immediate = true) {
      scheduleAutoSave([key], immediate);
    }

    // Rules compare case-insensitively; a merged row is in ALL mode if
    // either row was. Returns whether a row was merged.
    function mergeDuplicates() {
      const byRule = new Map();
      const merged = entries.filter((entry) => {
        const rule = entry.value.toLowerCase();
        const first = rule && byRule.get(rule);
        if (!first) {
          if (rule) byRule.set(rule, entry);
          return true;
        }
        if (entry.mode === "all") first.mode = "all";
        return false;
      });
      const changed = merged.length !== entries.length;
      entries = merged;
      return changed;
    }

    function focus(value, animate) {
      const items = Array.from(listEl.querySelectorAll(`.${itemClass}`));
      const item = value
        ? items.find((element) => element.querySelector("input").value === value)
        : items[0];
      if (!item) return;
      if (animate) item.classList.add("pop-in");
      item.querySelector("input").focus();
    }

    function createRow(entry) {
      const item = document.createElement("div");
      item.className = `entry ${itemClass}`;

      const input = document.createElement("input");
      input.type = "text";
      input.value = entry.value;
      input.placeholder = placeholder;
      input.setAttribute("aria-label", label);
      input.spellcheck = false;
      input.disabled = controlsDisabled;
      input.addEventListener("input", () => {
        entry.value = input.value;
        save(false);
      });
      input.addEventListener("blur", () => {
        const normalized = normalize(input.value);
        if (invalidMessage && input.value.trim() && !normalized) {
          showToast(invalidMessage, "error");
        }
        entry.value = normalized;
        input.value = normalized;
        if (mergeDuplicates()) {
          render();
          focus(normalized, true);
        }
        save();
      });
      item.append(input);

      if (modes) {
        const select = document.createElement("select");
        select.className = "mode-badge";
        select.setAttribute("aria-label", "Block mode");
        select.disabled = controlsDisabled;
        for (const mode of ["home", "all"]) {
          const option = document.createElement("option");
          option.value = mode;
          option.textContent = mode.toUpperCase();
          option.selected = entry.mode === mode;
          select.append(option);
        }
        select.addEventListener("change", () => {
          entry.mode = select.value === "all" ? "all" : "home";
          save();
        });
        item.append(select);
      }

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "remove-btn";
      removeButton.title = "Remove";
      removeButton.setAttribute("aria-label", removeLabel);
      removeButton.textContent = "×";
      removeButton.disabled = controlsDisabled;
      removeButton.addEventListener("click", () => {
        entries = entries.filter((other) => other !== entry);
        render();
        save();
      });
      item.append(removeButton);
      return item;
    }

    // New drafts come first, then rules in alphabetical order.
    function render() {
      updateCount();
      if (entries.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = emptyMessage;
        listEl.replaceChildren(empty);
        return;
      }
      entries.sort((a, b) => {
        if (!a.value || !b.value) return Number(Boolean(a.value)) - Number(Boolean(b.value));
        return a.value.localeCompare(b.value, undefined, { sensitivity: "base" });
      });
      listEl.replaceChildren(...entries.map(createRow));
    }

    // One-click additions use ALL mode, as the Block buttons on Reddit do.
    function add(value = "") {
      const normalized = normalize(value);
      entries.unshift({ value: normalized, mode: "all" });
      mergeDuplicates();
      render();
      focus(normalized, true);
      if (normalized) save();
    }

    // Shows stored rules. A list that already shows them, in any order,
    // stays as it is; new rows that are still empty stay in any case.
    function show(list) {
      const ruleKey = (rule) => JSON.stringify(rule);
      const current = new Set(values().map(ruleKey));
      if (shown && list.length === current.size && list.every((rule) => current.has(ruleKey(rule)))) {
        return;
      }
      shown = true;
      entries = [
        ...entries.filter((entry) => !entry.value),
        ...list.map((rule) => (modes ? { value: rule.name, mode: rule.mode } : { value: rule })),
      ];
      render();
    }

    document.getElementById(addId).addEventListener("click", () => add());
    return {
      key,
      add,
      show,
      values,
      updateCount,
    };
  }

  const blockedList = createEntryList({
    key: "blockedSubreddits",
    listId: "blocked-list",
    countId: "blocked-count",
    addId: "add-subreddit",
    itemClass: "blocked-item",
    normalizeList: FrontFilter.normalizeBlockedSubreddits,
    modes: true,
    placeholder: "Subreddit, wildcard, or Reddit URL",
    label: "Subreddit, wildcard, or Reddit URL",
    removeLabel: "Remove subreddit rule",
    emptyMessage: "No subreddits blocked yet",
    invalidMessage: "Enter a subreddit name, a pattern with *, or a Reddit URL",
    countNouns: ["rule", "rules"],
  });
  const allowedList = createEntryList({
    key: "allowedSubreddits",
    listId: "allowed-list",
    countId: "allowed-count",
    addId: "add-allowed-subreddit",
    itemClass: "allowed-item",
    normalizeList: FrontFilter.normalizeAllowedSubreddits,
    placeholder: "Exact subreddit or Reddit URL",
    label: "Allowed subreddit or Reddit URL",
    removeLabel: "Remove subreddit exception",
    emptyMessage: "No subreddit exceptions yet",
    invalidMessage: "Allowed subreddits must be exact names, without *",
    countNouns: ["exception", "exceptions"],
  });
  const entryLists = [
    blockedList,
    allowedList,
    createEntryList({
      key: "blockedTitleKeywords",
      listId: "title-keyword-list",
      countId: "title-keyword-count",
      addId: "add-title-keyword",
      itemClass: "keyword-item",
      normalizeList: FrontFilter.normalizeTitleKeywords,
      placeholder: "Keyword or phrase",
      label: "Keyword or phrase",
      removeLabel: "Remove keyword",
      emptyMessage: "No keywords filtered yet",
      countNouns: ["keyword", "keywords"],
    }),
    createEntryList({
      key: "blockedFlairs",
      listId: "blocked-flair-list",
      countId: "blocked-flair-count",
      addId: "add-blocked-flair",
      itemClass: "flair-item",
      normalizeList: FrontFilter.normalizeBlockedFlairs,
      placeholder: "Flair, e.g. Meme or *politic*",
      label: "Post flair",
      removeLabel: "Remove flair",
      emptyMessage: "No flairs filtered yet",
      invalidMessage: "Flairs can be at most 100 characters long",
      countNouns: ["flair", "flairs"],
    }),
  ];

  // Shows the settings a storage read returned, except those the read may
  // predate an edit of: the page already shows that edit.
  function showSettings(settings, read) {
    const showSetting = (key, update) => {
      if (!mayLackEdit(key, read)) update(settings[key]);
    };
    for (const [key, input] of Object.entries(switches)) {
      showSetting(key, (checked) => { input.checked = checked; });
    }
    for (const list of entryLists) showSetting(list.key, list.show);
    showSetting("scrollLimit", (limit) => {
      // A number still being typed stays unless the stored limit changed.
      if (limit !== lastScrollLimit) scrollLimit.value = String(limit);
      lastScrollLimit = limit;
    });
    showSetting("scrollMode", (mode) => { scrollMode.value = mode; });
    showSetting("theme", (theme) => { colorTheme.value = applyTheme(theme); });
    updateScrollControls();
    updateGroupControls();
  }

  // Reads can finish out of order: an older one never replaces a newer one.
  async function loadSettings() {
    const read = ++lastRead;
    const settings = FrontFilter.coerceSettings(
      await chrome.storage.local.get(FrontFilter.STORAGE_KEYS),
    );
    if (read < lastShownRead) return;
    lastShownRead = read;
    showSettings(settings, read);
  }

  async function exportConfig() {
    try {
      await flushPendingSave();
      const data = FrontFilter.coerceSettings(
        await chrome.storage.local.get(FrontFilter.STORAGE_KEYS),
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "frontfilter-config.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast("Configuration exported!", "success");
    } catch (error) {
      showToast(`Export failed: ${error.message}`, "error");
    }
  }

  // Settings in the file replace their current values; others stay.
  async function importConfig(file) {
    setControlsDisabled(true);
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        showToast("Invalid config: expected a JSON object", "error");
        return;
      }

      const imported = Object.fromEntries(
        Object.entries(data).filter(([key]) => FrontFilter.STORAGE_KEYS.includes(key)),
      );
      if (Object.keys(imported).length === 0) {
        showToast("Invalid config: no recognized keys", "error");
        return;
      }

      const invalidKeys = FrontFilter.getInvalidSettingKeys(imported);
      if (invalidKeys.length > 0) {
        showToast(`Invalid config values: ${invalidKeys.join(", ")}`, "error");
        return;
      }

      await flushPendingSave();
      await enqueueStorageOperation(async () => {
        const current = await chrome.storage.local.get(FrontFilter.STORAGE_KEYS);
        await chrome.storage.local.set(FrontFilter.coerceSettings({ ...current, ...imported }));
      });
      await loadSettings();
      showToast("Configuration imported!", "success");
    } catch (error) {
      showToast(`Import failed: ${error.message}`, "error");
    } finally {
      setControlsDisabled(false);
    }
  }

  async function addCurrentSubreddit(list) {
    try {
      if (standaloneCurrentSubreddit) {
        list.add(standaloneCurrentSubreddit);
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      // Browsers give only the URLs of tabs FrontFilter can access: Reddit's.
      const url = FrontFilter.getRedditUrl(tab?.url);
      const subreddit = url && FrontFilter.getSubredditPath(url.pathname);
      if (subreddit) list.add(subreddit.name);
      else showToast("No subreddit found on current tab", "error");
    } catch {
      showToast("Could not access current tab", "error");
    }
  }

  for (const [key, input] of Object.entries(switches)) {
    input.addEventListener("change", () => {
      // Sections are saved with their parent, as storage implies them.
      const sections = FrontFilter.SETTING_GROUPS[key] || [];
      for (const section of sections) switches[section].checked = input.checked;
      updateScrollControls();
      updateGroupControls();
      scheduleAutoSave([key, ...sections], true);
    });
  }

  scrollLimit.addEventListener("change", () => {
    const value = Number(scrollLimit.value);
    if (!Number.isSafeInteger(value) || value < 1) {
      showToast("Enter a positive whole number of posts", "error");
      scrollLimit.value = String(lastScrollLimit);
      return;
    }
    lastScrollLimit = value;
    scheduleAutoSave(["scrollLimit"], true);
  });
  scrollMode.addEventListener("change", () => scheduleAutoSave(["scrollMode"], true));
  colorTheme.addEventListener("change", () => {
    colorTheme.value = applyTheme(colorTheme.value);
    scheduleAutoSave(["theme"], true);
  });

  document.getElementById("add-current-subreddit")
    .addEventListener("click", () => addCurrentSubreddit(blockedList));
  document.getElementById("add-current-allowed-subreddit")
    .addEventListener("click", () => addCurrentSubreddit(allowedList));
  document.getElementById("export-config").addEventListener("click", exportConfig);
  document.getElementById("import-config").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const [file] = importFile.files;
    if (file) void importConfig(file);
    importFile.value = "";
  });

  // Settings changed elsewhere, such as by a Block button on Reddit, the
  // block page or another settings page, show here too. Otherwise a list
  // saved here would put back rules removed elsewhere and drop rules added.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !FrontFilter.STORAGE_KEYS.some((key) => Object.hasOwn(changes, key))) {
      return;
    }
    loadSettings().catch((error) => console.error("Could not reload FrontFilter settings:", error));
  });

  setControlsDisabled(true);
  loadSettings()
    .then(() => setControlsDisabled(false))
    .catch((error) => {
      showToast(`Could not load settings: ${error.message}`, "error");
    });
});
