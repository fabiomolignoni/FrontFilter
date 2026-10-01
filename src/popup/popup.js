/**
 * FrontFilter - Popup Script
 * Handles settings, import/export, and auto-save.
 */

document.addEventListener("DOMContentLoaded", () => {
  const pageParams = new URLSearchParams(globalThis.location?.search);
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
      document.getElementById(tab.getAttribute("aria-controls")).hidden =
        !selected;
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      let nextIndex;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft")
        nextIndex = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[nextIndex]);
      tabs[nextIndex].focus();
    });
  }

  const blockedListEl = document.getElementById("blocked-list");
  const blockedCount = document.getElementById("blocked-count");
  const addBtn = document.getElementById("add-subreddit");
  const addCurrent = document.getElementById("add-current-subreddit");
  const addCurrentAllowed = document.getElementById(
    "add-current-allowed-subreddit",
  );
  const saveIndicator = document.getElementById("save-indicator");
  const toast = document.getElementById("toast");
  const exportBtn = document.getElementById("export-config");
  const importBtn = document.getElementById("import-config");
  const importFile = document.getElementById("import-file");
  const scrollLimit = document.getElementById("scroll-limit");
  const scrollMode = document.getElementById("scroll-mode");
  const colorTheme = document.getElementById("color-theme");

  const checkboxIds = {
    blockHomepage: "block-homepage",
    blockPopular: "block-popular",
    blockExplore: "block-explore",
    blockNews: "block-news",
    blockSubHome: "block-sub-home",
    hideComments: "hide-comments",
    hideCommentReplies: "hide-comment-replies",
    disableAutoplay: "disable-autoplay",
    hideSuggestedCommunities: "hide-suggested-communities",
    hideSuggestedPosts: "hide-suggested-posts",
    hideAds: "hide-ads",
    hideSocialSignals: "hide-social-signals",
    hideVotes: "hide-votes",
    hideKarma: "hide-karma",
    hideAwards: "hide-awards",
    hideAvatars: "hide-avatars",
    hideUsernames: "hide-usernames",
    hideNavbar: "hide-navbar",
    hideNavbarMenu: "hide-navbar-menu",
    hideNavbarSearch: "hide-navbar-search",
    hideNavbarChat: "hide-navbar-chat",
    hideNavbarNotifications: "hide-navbar-notifications",
    hideNavbarProfile: "hide-navbar-profile",
    hideNavbarOthers: "hide-navbar-others",
    hideLeftSidebar: "hide-left-sidebar",
    hideLeftSidebarGames: "hide-left-sidebar-games",
    hideLeftSidebarCustomFeeds: "hide-left-sidebar-custom-feeds",
    hideLeftSidebarRecent: "hide-left-sidebar-recent",
    hideLeftSidebarCommunities: "hide-left-sidebar-communities",
    hideLeftSidebarResources: "hide-left-sidebar-resources",
    hideRelatedPosts: "hide-right-sidebar",
    showBlockSubredditButton: "show-block-subreddit-button",
    limitInfiniteScroll: "limit-infinite-scroll",
  };
  const checkboxes = Object.fromEntries(
    Object.entries(checkboxIds).map(([key, id]) => [
      key,
      document.getElementById(id),
    ]),
  );

  let blockedEntries = [];
  let toastTimer = null;
  let indicatorTimer = null;
  let debounceTimer = null;
  const pendingSaveKeys = new Set();
  let saveQueue = Promise.resolve();
  let latestSaveId = 0;
  let controlsDisabled = false;
  let lastScrollLimit = FrontFilter.DEFAULT_SETTINGS.scrollLimit;
  // A parent switch checks and locks its sections. These parents also turn
  // their sections off with them; turning off "Hide comments" leaves replies
  // hidden until their own switch is turned off.
  const sectionsFollowParent = new Set(["hideNavbar", "hideLeftSidebar", "hideSocialSignals"]);
  const settingGroups = [
    { id: "comments", parentKey: "hideComments", describe: () => "Replies hidden" },
    {
      id: "navbar",
      parentKey: "hideNavbar",
      describe: (count, total) => `${count} of ${total} sections hidden`,
    },
    {
      id: "left-sidebar",
      parentKey: "hideLeftSidebar",
      describe: (count, total) => `${count} of ${total} sections hidden`,
    },
    {
      id: "social",
      parentKey: "hideSocialSignals",
      describe: (count, total) => `${count} of ${total} hidden`,
    },
  ].map((group) => ({
    ...group,
    childKeys: FrontFilter.SETTING_GROUPS[group.parentKey],
    toggle: document.getElementById(`${group.id}-toggle`),
    options: document.getElementById(`${group.id}-options`),
    summary: document.getElementById(`${group.id}-summary`),
  }));

  // Sub-options start collapsed; the summary keeps hidden choices visible.
  for (const { toggle, options } of settingGroups) {
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      options.hidden = !expanded;
    });
  }

  function updateGroupSummaries() {
    for (const { parentKey, childKeys, describe, summary } of settingGroups) {
      const count = childKeys.filter((key) => checkboxes[key].checked).length;
      summary.hidden = checkboxes[parentKey].checked || count === 0;
      summary.textContent = summary.hidden ? "" : describe(count, childKeys.length);
    }
  }

  function setControlsDisabled(disabled) {
    controlsDisabled = disabled;
    for (const control of [
      ...Object.values(checkboxes),
      addBtn,
      addCurrent,
      addCurrentAllowed,
      ...Object.values(textLists).map((list) => list.addButton),
      exportBtn,
      importBtn,
      importFile,
      scrollLimit,
      scrollMode,
      colorTheme,
    ]) {
      control.disabled = disabled;
    }

    blockedListEl
      .querySelectorAll("input, select, button")
      .forEach((control) => {
        control.disabled = disabled;
      });
    for (const list of Object.values(textLists)) {
      list.listEl
        .querySelectorAll("input, button")
        .forEach((control) => {
          control.disabled = disabled;
        });
    }
    updateScrollControls();
    updateGroupControls();
    updateGroupSummaries();
  }

  function updateScrollControls() {
    const disabled =
      controlsDisabled || !checkboxes.limitInfiniteScroll.checked;
    scrollLimit.disabled = disabled;
    scrollMode.disabled = disabled;
  }

  function updateGroupControls() {
    for (const { parentKey, childKeys } of settingGroups) {
      const parentChecked = checkboxes[parentKey].checked;
      for (const key of childKeys) {
        if (parentChecked) checkboxes[key].checked = true;
        checkboxes[key].disabled = controlsDisabled || parentChecked;
      }
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
    saveIndicator.textContent = "Saving...";
    saveIndicator.classList.add("visible");
  }

  function showSaved(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = "Saved";
    indicatorTimer = setTimeout(
      () => saveIndicator.classList.remove("visible"),
      1200,
    );
  }

  function showSaveFailed(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = "Save failed";
    saveIndicator.classList.add("visible");
  }

  function getCheckboxSettings() {
    return Object.fromEntries(
      Object.entries(checkboxes).map(([key, checkbox]) => [
        key,
        checkbox.checked,
      ]),
    );
  }

  function getSettingsSnapshot() {
    return {
      ...getCheckboxSettings(),
      blockedSubreddits: FrontFilter.normalizeBlockedSubreddits(blockedEntries),
      ...Object.fromEntries(
        Object.values(textLists).map((list) => [list.key, list.values()]),
      ),
      scrollLimit: lastScrollLimit,
      scrollMode: scrollMode.value === "button" ? "button" : "fixed",
      theme: FrontFilter.normalizeTheme(colorTheme.value),
    };
  }

  function queueSave(keys) {
    const saveId = ++latestSaveId;
    const snapshot = getSettingsSnapshot();
    const settings = Object.fromEntries(
      Array.from(keys, (key) => [key, snapshot[key]]),
    );
    updateBlockedCount();
    for (const list of Object.values(textLists)) list.updateCount();
    showSaving();

    enqueueStorageWrite(settings);
    saveQueue.then(
      () => showSaved(saveId),
      (error) => {
        showSaveFailed(saveId);
        showToast(`Save failed: ${error.message}`, "error");
      },
    );
    return saveQueue;
  }

  function enqueueStorageWrite(settings) {
    return enqueueStorageOperation(() => chrome.storage.local.set(settings));
  }

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
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    queuePendingSave();

    await saveQueue;
  }

  function sortDraftEntries(draftEntries, key, options) {
    draftEntries.sort((a, b) => {
      if (!a[key] && !b[key]) return 0;
      if (!a[key]) return -1;
      if (!b[key]) return 1;
      return a[key].localeCompare(b[key], undefined, options);
    });
  }

  function appendEmptyState(container, message) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("span");
    icon.textContent = "-";
    empty.appendChild(icon);
    empty.appendChild(document.createTextNode(message));
    container.appendChild(empty);
  }

  function createRemoveButton(ariaLabel) {
    const button = document.createElement("button");
    button.className = "remove-btn";
    button.title = "Remove";
    button.setAttribute("aria-label", ariaLabel);
    button.textContent = "x";
    button.disabled = controlsDisabled;
    return button;
  }

  function focusListInput(container, itemSelector, normalizedValue, animate) {
    const items = container.querySelectorAll(itemSelector);
    const target = normalizedValue
      ? Array.from(items).find(
          (item) => item.querySelector("input").value === normalizedValue,
        )
      : items[0];

    if (!target) return;
    if (animate) target.classList.add("pop-in");
    target.querySelector("input").focus();
  }

  function setCount(element, count, singular, plural) {
    element.textContent = `${count} ${count === 1 ? singular : plural}`;
  }

  function updateBlockedCount() {
    const count = FrontFilter.normalizeBlockedSubreddits(blockedEntries).length;
    setCount(blockedCount, count, "rule", "rules");
  }

  function renderList() {
    blockedListEl.innerHTML = "";
    updateBlockedCount();

    if (blockedEntries.length === 0) {
      appendEmptyState(blockedListEl, "No subreddits blocked yet");
      return;
    }

    sortDraftEntries(blockedEntries, "name");
    blockedEntries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "blocked-item";

      const input = document.createElement("input");
      input.type = "text";
      input.value = entry.name;
      input.placeholder = "Subreddit, wildcard, or Reddit URL";
      input.setAttribute("aria-label", "Subreddit, wildcard, or Reddit URL");
      input.spellcheck = false;
      input.disabled = controlsDisabled;

      const select = document.createElement("select");
      select.className = "mode-badge";
      select.setAttribute("aria-label", "Block mode");
      select.disabled = controlsDisabled;
      for (const mode of ["home", "all"]) {
        const option = document.createElement("option");
        option.value = mode;
        option.textContent = mode.toUpperCase();
        option.selected = entry.mode === mode;
        select.appendChild(option);
      }

      const removeBtn = createRemoveButton("Remove subreddit rule");

      input.addEventListener("input", (event) => {
        entry.name = event.target.value;
        scheduleAutoSave(["blockedSubreddits"]);
      });
      input.addEventListener("blur", (event) => {
        const normalizedName = FrontFilter.normalizeSubredditName(
          event.target.value,
        );
        entry.name = normalizedName;
        event.target.value = normalizedName;
        if (mergeDuplicateEntries()) {
          renderList();
          focusEntry(normalizedName, true);
        }
        scheduleAutoSave(["blockedSubreddits"], true);
      });
      select.addEventListener("change", (event) => {
        entry.mode = event.target.value === "all" ? "all" : "home";
        scheduleAutoSave(["blockedSubreddits"], true);
      });
      removeBtn.addEventListener("click", () => {
        const entryIndex = blockedEntries.indexOf(entry);
        if (entryIndex < 0) return;
        blockedEntries.splice(entryIndex, 1);
        renderList();
        scheduleAutoSave(["blockedSubreddits"], true);
      });

      item.appendChild(input);
      item.appendChild(select);
      item.appendChild(removeBtn);
      blockedListEl.appendChild(item);
    });
  }

  function focusEntry(name, animate) {
    const normalizedName = FrontFilter.normalizeSubredditName(name);
    focusListInput(blockedListEl, ".blocked-item", normalizedName, animate);
  }

  // One rule per subreddit, as storage keeps them: a repeated name merges
  // into its first row, which becomes ALL if either row was.
  function mergeDuplicateEntries() {
    const byName = new Map();
    const merged = blockedEntries.filter((entry) => {
      const first = entry.name && byName.get(entry.name);
      if (!first) {
        if (entry.name) byName.set(entry.name, entry);
        return true;
      }
      if (entry.mode === "all") first.mode = "all";
      return false;
    });
    const changed = merged.length !== blockedEntries.length;
    blockedEntries = merged;
    return changed;
  }

  function addEntry(name = "", mode = "all", animate = true) {
    const normalizedName = FrontFilter.normalizeSubredditName(name);
    blockedEntries.unshift({
      name: normalizedName,
      mode: mode === "all" ? "all" : "home",
    });
    mergeDuplicateEntries();
    renderList();
    focusEntry(normalizedName, animate);

    if (normalizedName) scheduleAutoSave(["blockedSubreddits"], true);
  }

  // Plain text filter lists share one editor: drafts keep what the user
  // typed until the field loses focus, and saves store the normalized list.
  function createTextList({
    key, listId, countId, addId, itemClass, normalizeList, placeholder, label,
    removeLabel, emptyMessage, invalidMessage, countNouns, sortOptions,
  }) {
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    const addButton = document.getElementById(addId);
    let entries = [];
    const normalize = (value) => normalizeList([value])[0] || "";
    const values = () => normalizeList(entries.map((entry) => entry.value));
    const updateCount = () => setCount(countEl, values().length, ...countNouns);

    function render() {
      listEl.innerHTML = "";
      updateCount();

      if (entries.length === 0) {
        appendEmptyState(listEl, emptyMessage);
        return;
      }

      sortDraftEntries(entries, "value", sortOptions);
      entries.forEach((entry) => {
        const item = document.createElement("div");
        item.className = itemClass;

        const input = document.createElement("input");
        input.type = "text";
        input.value = entry.value;
        input.placeholder = placeholder;
        input.setAttribute("aria-label", label);
        input.spellcheck = false;
        input.disabled = controlsDisabled;

        const removeBtn = createRemoveButton(removeLabel);

        input.addEventListener("input", (event) => {
          entry.value = event.target.value;
          scheduleAutoSave([key]);
        });
        input.addEventListener("blur", (event) => {
          const normalized = normalize(event.target.value);
          if (invalidMessage && event.target.value.trim() && !normalized) {
            showToast(invalidMessage, "error");
          }
          entry.value = normalized;
          event.target.value = normalized;
          scheduleAutoSave([key], true);
        });
        removeBtn.addEventListener("click", () => {
          const entryIndex = entries.indexOf(entry);
          if (entryIndex < 0) return;
          entries.splice(entryIndex, 1);
          render();
          scheduleAutoSave([key], true);
        });

        item.appendChild(input);
        item.appendChild(removeBtn);
        listEl.appendChild(item);
      });
    }

    function add(value = "", animate = true) {
      const normalized = normalize(value);
      entries.unshift({ value: normalized });
      render();
      focusListInput(listEl, `.${itemClass}`, normalized, animate);
      if (normalized) scheduleAutoSave([key], true);
    }

    addButton.addEventListener("click", () => add());
    return {
      key,
      listEl,
      addButton,
      add,
      values,
      updateCount,
      load(list) {
        entries = list.map((value) => ({ value }));
        render();
      },
    };
  }

  const textLists = Object.fromEntries([
    {
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
      invalidMessage: "Whitelist entries must be exact subreddit names",
      countNouns: ["exception", "exceptions"],
    },
    {
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
      sortOptions: { sensitivity: "base" },
    },
    {
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
      countNouns: ["flair", "flairs"],
      sortOptions: { sensitivity: "base" },
    },
  ].map((options) => [options.key, createTextList(options)]));

  async function loadSettings() {
    const result = FrontFilter.coerceSettings(
      await chrome.storage.local.get(FrontFilter.STORAGE_KEYS),
    );

    blockedEntries = result.blockedSubreddits;
    scrollLimit.value = String(result.scrollLimit);
    lastScrollLimit = result.scrollLimit;
    scrollMode.value = result.scrollMode;
    colorTheme.value = FrontFilter.applyTheme(result.theme);
    Object.entries(checkboxes).forEach(([key, checkbox]) => {
      checkbox.checked = result[key];
    });
    renderList();
    for (const list of Object.values(textLists)) list.load(result[list.key]);
  }

  async function exportConfig() {
    try {
      await flushPendingSave();
      const data = FrontFilter.coerceSettings(
        await chrome.storage.local.get(FrontFilter.STORAGE_KEYS),
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
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

  async function importConfig(file) {
    setControlsDisabled(true);
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        showToast("Invalid config: expected a JSON object", "error");
        return;
      }

      const filtered = Object.fromEntries(
        Object.entries(data).filter(([key]) =>
          FrontFilter.STORAGE_KEYS.includes(key),
        ),
      );

      if (Object.keys(filtered).length === 0) {
        showToast("Invalid config: no recognized keys", "error");
        return;
      }

      const invalidKeys = FrontFilter.getInvalidSettingKeys(filtered);
      if (invalidKeys.length > 0) {
        showToast(`Invalid config values: ${invalidKeys.join(", ")}`, "error");
        return;
      }

      await flushPendingSave();
      await enqueueStorageOperation(async () => {
        const current = await chrome.storage.local.get(FrontFilter.STORAGE_KEYS);
        await chrome.storage.local.set(
          FrontFilter.coerceSettings({ ...current, ...filtered }),
        );
      });
      await loadSettings();
      showToast("Configuration imported!", "success");
    } catch (error) {
      showToast(`Import failed: ${error.message}`, "error");
    } finally {
      setControlsDisabled(false);
    }
  }

  Object.entries(checkboxes).forEach(([key, checkbox]) => {
    checkbox.addEventListener("change", () => {
      // Sections are saved with their parent, as storage implies them.
      const sections = FrontFilter.SETTING_GROUPS[key] || [];
      if (sectionsFollowParent.has(key)) {
        for (const section of sections) checkboxes[section].checked = checkbox.checked;
      }
      updateScrollControls();
      updateGroupControls();
      updateGroupSummaries();
      scheduleAutoSave([key, ...sections], true);
    });
  });

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
    colorTheme.value = FrontFilter.applyTheme(colorTheme.value);
    scheduleAutoSave(["theme"], true);
  });

  addBtn.addEventListener("click", () => addEntry());

  async function addCurrentSubreddit(addEntryCallback) {
    try {
      if (standaloneCurrentSubreddit) {
        addEntryCallback(standaloneCurrentSubreddit);
        return;
      }

      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.url) return;

      const url = FrontFilter.getRedditUrl(tab.url);
      const subreddit = url && FrontFilter.getSubredditPath(url.pathname);
      subreddit
        ? addEntryCallback(subreddit.name)
        : showToast("No subreddit found on current tab", "error");
    } catch {
      showToast("Could not access current tab", "error");
    }
  }

  addCurrent.addEventListener("click", () => addCurrentSubreddit(addEntry));
  addCurrentAllowed.addEventListener("click", () =>
    addCurrentSubreddit((name) => textLists.allowedSubreddits.add(name))
  );

  exportBtn.addEventListener("click", exportConfig);
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) importConfig(file);
    importFile.value = "";
  });

  setControlsDisabled(true);
  loadSettings()
    .then(() => setControlsDisabled(false))
    .catch((error) => {
      showToast(`Could not load settings: ${error.message}`, "error");
    });
});
