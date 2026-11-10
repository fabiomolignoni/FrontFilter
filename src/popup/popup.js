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
  const colorTheme = document.getElementById("color-theme");
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
      countId: "scroll-limit", modeId: "scroll-mode", noun: "posts",
    },
    {
      switchKey: "limitComments", countKey: "commentLimit", modeKey: "commentLimitMode",
      countId: "comment-limit", modeId: "comment-limit-mode", noun: "comments",
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
    updateDependentControls();
    updateGroupControls();
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
      ...Object.fromEntries(limits.flatMap(({ countKey, modeKey, mode, lastCount }) => [
        [countKey, lastCount], [modeKey, mode.value],
      ])),
      theme: colorTheme.value,
      redirectUrl: lastRedirectUrl,
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
  // A list pasted in a row adds a row for each of its entries.
  function createEntryList({
    key, listId, countId, addId, itemClass, normalizeList, modes = false,
    getRuleKey = (value) => value.toLowerCase(), splitList = FrontFilter.splitList,
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

    function values(list = entries) {
      return normalizeList(list.map(({ value, mode }) => (modes ? { name: value, mode } : value)));
    }

    function formatCount(count) {
      return `${count} ${count === 1 ? countNouns[0] : countNouns[1]}`;
    }

    function updateCount() {
      countEl.textContent = formatCount(values().length);
    }

    function save(immediate = true) {
      scheduleAutoSave([key], immediate);
    }

    // Rules compare as their list does, case-insensitively unless it says
    // otherwise; a merged row is in ALL mode if either row was. Returns
    // whether a row was merged.
    function mergeDuplicates() {
      const byRule = new Map();
      const merged = entries.filter((entry) => {
        const rule = getRuleKey(entry.value);
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
      // A single entry pastes as usual. A list replaces the row, with what
      // the row already holds around the place it is pasted.
      input.addEventListener("paste", (event) => {
        const pasted = event.clipboardData?.getData("text/plain") ?? "";
        if (splitList(pasted).length < 2) return;
        event.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        addList(splitList(input.value.slice(0, start) + pasted + input.value.slice(end)), entry);
      });
      input.addEventListener("blur", () => {
        // Some browsers blur a row that a pasted list removed.
        if (!entries.includes(entry)) return;
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

    // Adds a pasted list's entries in place of the row it was pasted in,
    // in that row's mode, and tells how many rules are new. Entries that
    // cannot be used are left out; if none can, the row stays as it was.
    function addList(list, row) {
      const added = list.map(normalize).filter(Boolean);
      if (added.length === 0) {
        showToast(invalidMessage, "error");
        return;
      }
      const others = entries.filter((other) => other !== row);
      const previousCount = values(others).length;
      entries = [...added.map((value) => ({ value, mode: row.mode })), ...others];
      mergeDuplicates();
      render();
      save();

      const pasted = new Set(added);
      const items = Array.from(listEl.querySelectorAll(`.${itemClass}`))
        .filter((item) => pasted.has(item.querySelector("input").value));
      for (const item of items) item.classList.add("pop-in");
      items[0]?.querySelector("input").focus();

      const newCount = values().length - previousCount;
      const skipped = list.length - added.length;
      const message = newCount > 0 ? `Added ${formatCount(newCount)}` : `No new ${countNouns[1]}`;
      if (skipped === 0) {
        showToast(message, newCount > 0 ? "success" : "info");
      } else {
        showToast(`${message}; ${skipped} ${skipped === 1 ? "entry" : "entries"} could not be used`, "error");
      }
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
  const KEYWORD_INVALID_MESSAGE = "Enter a keyword, or a valid regular expression between slashes";
  const splitKeywordList = (text) => FrontFilter.splitList(text, { keywords: true });
  const entryLists = [
    blockedList,
    allowedList,
    createEntryList({
      key: "blockedUsers",
      listId: "blocked-user-list",
      countId: "blocked-user-count",
      addId: "add-blocked-user",
      itemClass: "user-item",
      normalizeList: FrontFilter.normalizeBlockedUsers,
      placeholder: "Username, u/name, or profile URL",
      label: "Username, u/name, or profile URL",
      removeLabel: "Remove user",
      emptyMessage: "No users blocked yet",
      invalidMessage: "Enter a username, such as u/name, or a profile URL",
      countNouns: ["user", "users"],
    }),
    createEntryList({
      key: "blockedTitleKeywords",
      listId: "title-keyword-list",
      countId: "title-keyword-count",
      addId: "add-title-keyword",
      itemClass: "keyword-item",
      normalizeList: FrontFilter.normalizeTitleKeywords,
      getRuleKey: FrontFilter.getKeywordKey,
      splitList: splitKeywordList,
      placeholder: "Keyword, phrase, or /regex/",
      label: "Keyword, phrase, or regular expression",
      removeLabel: "Remove keyword",
      emptyMessage: "No keywords filtered yet",
      invalidMessage: KEYWORD_INVALID_MESSAGE,
      countNouns: ["keyword", "keywords"],
    }),
    createEntryList({
      key: "allowedKeywords",
      listId: "allowed-keyword-list",
      countId: "allowed-keyword-count",
      addId: "add-allowed-keyword",
      itemClass: "allowed-keyword-item",
      normalizeList: FrontFilter.normalizeTitleKeywords,
      getRuleKey: FrontFilter.getKeywordKey,
      splitList: splitKeywordList,
      placeholder: "Keyword, phrase, or /regex/",
      label: "Allowed keyword, phrase, or regular expression",
      removeLabel: "Remove keyword exception",
      emptyMessage: "No keyword exceptions yet",
      invalidMessage: KEYWORD_INVALID_MESSAGE,
      countNouns: ["exception", "exceptions"],
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
    for (const limit of limits) {
      showSetting(limit.countKey, (value) => {
        // A number still being typed stays unless the stored one changed.
        if (value !== limit.lastCount) limit.count.value = String(value);
        limit.lastCount = value;
      });
      showSetting(limit.modeKey, (mode) => { limit.mode.value = mode; });
    }
    showSetting("theme", (theme) => { colorTheme.value = applyTheme(theme); });
    showSetting("redirectUrl", (url) => {
      // So does an address still being typed, unless the stored one changed.
      if (url !== lastRedirectUrl) redirectUrl.value = url;
      lastRedirectUrl = url;
    });
    updateDependentControls();
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
      const data = {
        // Imports read the file's keywords as this version wrote them.
        [FrontFilter.SETTINGS_VERSION_KEY]: FrontFilter.SETTINGS_VERSION,
        ...FrontFilter.coerceSettings(await chrome.storage.local.get(FrontFilter.STORAGE_KEYS)),
      };
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

      // Files exported by earlier versions keep their meaning.
      const imported = Object.fromEntries(
        Object.entries(FrontFilter.upgradeSettings(data))
          .filter(([key]) => FrontFilter.STORAGE_KEYS.includes(key)),
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
        // Stored settings not yet upgraded are upgraded with the import.
        const current = FrontFilter.upgradeSettings(await chrome.storage.local.get([
          ...FrontFilter.STORAGE_KEYS,
          FrontFilter.SETTINGS_VERSION_KEY,
        ]));
        await chrome.storage.local.set({
          ...FrontFilter.coerceSettings({ ...current, ...imported }),
          [FrontFilter.SETTINGS_VERSION_KEY]: FrontFilter.SETTINGS_VERSION,
        });
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
      updateDependentControls();
      updateGroupControls();
      scheduleAutoSave([key, ...sections], true);
    });
  }

  for (const limit of limits) {
    limit.count.addEventListener("change", () => {
      const value = Number(limit.count.value);
      if (!Number.isSafeInteger(value) || value < 1) {
        showToast(`Enter a positive whole number of ${limit.noun}`, "error");
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
      showToast("Enter a website address, such as example.com", "error");
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
