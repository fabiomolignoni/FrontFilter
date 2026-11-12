/**
 * FrontFilter's settings page, shown as the toolbar popup and in a tab of
 * its own. Every change is saved as it is made.
 */

document.addEventListener("DOMContentLoaded", () => {
  const pageParams = new URLSearchParams(globalThis.location?.search);
  const standalone = pageParams.get("standalone") === "true";
  // In a tab of its own, the card shows the subreddit this page was opened
  // for: the current tab is the page itself.
  const standaloneCurrentSubreddit = FrontFilter.normalizeExactSubredditName(
    pageParams.get("currentSubreddit"),
  );
  // In a tab of its own, the page fills it, and offers no tab to open.
  const openInTab = document.getElementById("open-in-tab");
  function useTabLayout() {
    document.body.classList.add("standalone");
    openInTab.hidden = true;
  }
  if (standalone) useTabLayout();
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
  const importReview = {
    element: document.getElementById("import-review"),
    title: document.getElementById("import-review-title"),
    changes: document.getElementById("import-review-changes"),
    note: document.getElementById("import-review-note"),
    confirm: document.getElementById("import-confirm"),
    cancel: document.getElementById("import-cancel"),
  };
  const backupRestore = document.getElementById("backup-restore");
  const backupRestoreText = document.getElementById("backup-restore-text");
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
    // Says how many sections a mixed group hides, as its switch cannot.
    summary: Array.from(document.querySelectorAll(".group-summary"))
      .find((element) => element.getAttribute("data-group") === parent),
  }));

  const PAGE_SWITCHES = new Set([...FrontFilter.PAGE_ROUTES.map(({ key }) => key), "blockSubHome"]);

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
    if (ids.length > 1) return ids.map((id) => textOf(document.getElementById(id))).join(": ");
    const label = ids.length === 1 ? textOf(document.getElementById(ids[0])) : row;
    // The switches that block pages are named by the page alone.
    return PAGE_SWITCHES.has(key) ? `Block ${label}` : label;
  }

  // While settings are locked, the background saves them: what loosens
  // them waits (popup/lock-card.js).
  const lockCard = FrontFilter.createLockCard({
    showToast,
    labelOf,
    showLockSection: () => selectTab(document.getElementById("tab-settings")),
  });

  // The card for the Reddit page open in the current tab: its name, what
  // filters hide on it, and for a subreddit, what the rules do to it.
  const currentCard = {
    element: document.getElementById("current-page"),
    prefix: document.getElementById("current-page-prefix"),
    name: document.getElementById("current-page-name"),
    status: document.getElementById("current-page-status"),
    countsText: document.getElementById("current-page-hidden"),
    actions: document.getElementById("current-page-actions"),
    block: document.getElementById("add-current-subreddit"),
    allow: document.getElementById("add-current-allowed-subreddit"),
    // The page's tab, and its subreddit, if it is one.
    tabId: null,
    subreddit: "",
    // What filters hide on the page, as it last said, or null until it does.
    counts: null,
  };

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
    lockCard.setDisabled(disabled);
    updateDependentControls();
    updateGroupControls();
    updateCurrentCard();
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
        const partial = summary.getAttribute("data-partial") || `${hidden} of ${sections.length} hidden`;
        summary.textContent = parent.indeterminate ? partial : "";
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
    saveIndicator.textContent = "Saving…";
    saveIndicator.setAttribute("data-state", "saving");
    saveIndicator.classList.add("visible");
  }

  function showSaved(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = "Saved";
    saveIndicator.setAttribute("data-state", "saved");
    indicatorTimer = setTimeout(() => saveIndicator.classList.remove("visible"), 1200);
  }

  function showSaveFailed(saveId) {
    if (saveId !== latestSaveId) return;

    clearTimeout(indicatorTimer);
    saveIndicator.textContent = "Save failed";
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
    updateCurrentCard();
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
    enqueueStorageOperation(async () => {
      if (!lockCard.savesThroughLock()) return chrome.storage.local.set(settings);
      throughLock = true;
      lockCard.report(await saveThroughLock(settings));
    });
    saveQueue.then(
      () => {
        saved();
        showSaved(saveId);
        if (throughLock) reloadSettings();
      },
      (error) => {
        saved();
        showSaveFailed(saveId);
        showToast(`Save failed: ${error.message}`, "error");
        if (throughLock) reloadSettings();
      },
    );
    return saveQueue;
  }

  // Asks the background to save settings as the lock allows, with extra
  // values such as an import's backup, and returns what waits.
  async function saveThroughLock(settings, { extra, source } = {}) {
    const response = await chrome.runtime.sendMessage({
      action: "saveSettings", settings, ...(extra && { extra }), ...(source && { source }),
    });
    if (!response?.success) throw new Error(response?.error || "no answer");
    return response.result;
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
    clearTimeout(debounceTimer);
    debounceTimer = null;
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
    const snapshot = getSettingsSnapshot();
    const settings = Object.fromEntries(Array.from(pendingSaveKeys, (key) => [key, snapshot[key]]));
    pendingSaveKeys.clear();
    const write = lockCard.savesThroughLock()
      ? chrome.runtime.sendMessage({ action: "saveSettings", settings })
      : chrome.storage.local.set(settings);
    void write.catch(() => undefined);
  });

  // A list that takes exceptions shows them among its rules: each row is
  // either, as its badge says, and a + typed or pasted before a rule makes
  // it an exception. Exceptions are stored in a setting of their own.
  const ALLOW = "allow";
  const ALLOW_LABEL = "Allowed";
  // Rows for the same rule merge into the one that does most: an exception,
  // which overrides every rule, then a rule that blocks everywhere.
  const MODE_PRECEDENCE = { block: 0, home: 0, all: 1, [ALLOW]: 2 };

  // A list longer than this folds to its first rules, with a field that
  // searches it and a button that shows it all.
  const FOLD_AFTER = 8;
  const FOLDED_ROWS = 6;

  // Text as a list search compares it, ignoring case and accents.
  function foldText(text) {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  // Whether two lists' stored settings hold the same rules, in any order.
  function sameRules(settings, others) {
    return Object.keys(settings).every((key) => {
      const rules = new Set(settings[key].map((rule) => JSON.stringify(rule)));
      return rules.size === others[key].length
        && others[key].every((rule) => rules.has(JSON.stringify(rule)));
    });
  }

  // An editable list of filter rules, and with allowKey, of exceptions.
  // Each row is a draft that keeps what the user types until the field
  // loses focus; it is then normalized and merged into an earlier row for
  // the same rule. Saves store the normalized lists. Rules are blocked in
  // the first of blockModes unless the row's badge chooses another; with
  // storesModes, as subreddit rules are, each rule is stored with its mode.
  // A list pasted in a row adds a row for each of its entries. A long list
  // folds, but rows just added, merged into or pasted always show.
  function createEntryList({
    key, allowKey = null, title, listId, countId, addId, itemClass,
    normalizeList, normalizeAllowList = normalizeList,
    blockModes = [["block", ""]], storesModes = false, defaultMode = blockModes[0][0], modeLabel,
    getRuleKey = (value) => value.toLowerCase(), splitList = FrontFilter.splitList,
    placeholder, label, removeLabel, emptyMessage, invalidMessage, countNouns, searchLabel,
  }) {
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    const keys = allowKey ? [key, allowKey] : [key];
    // What a row's badge offers; a list with one choice has no badge.
    const modes = allowKey ? [...blockModes, [ALLOW, ALLOW_LABEL]] : blockModes;
    const blockMode = blockModes[0][0];
    let entries = [];
    let shown = false;
    let rows = new Map();
    let expanded = false;
    let query = "";
    const revealed = new Set();
    // The rule removed last, which the row left in its place can restore
    // until the list changes otherwise.
    let removed = null;

    const search = document.createElement("input");
    search.type = "search";
    search.className = "field list-search";
    search.placeholder = searchLabel;
    search.setAttribute("aria-label", searchLabel);
    search.setAttribute("aria-controls", listId);
    search.spellcheck = false;
    const tools = document.createElement("div");
    tools.className = "list-tools";
    tools.hidden = true;
    tools.append(search);
    listEl.before(tools);

    const noMatch = document.createElement("p");
    noMatch.className = "list-no-match";
    noMatch.setAttribute("role", "status");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "list-more";
    more.setAttribute("aria-controls", listId);
    const footer = document.createElement("div");
    footer.className = "list-footer";
    footer.hidden = true;
    footer.append(noMatch, more);
    listEl.parentElement.append(footer);

    function normalize(value, mode) {
      const [normalized] = (mode === ALLOW ? normalizeAllowList : normalizeList)([value]);
      return (storesModes && mode !== ALLOW ? normalized?.name : normalized) ?? "";
    }

    // A row as saves store it: while a + is being typed before its rule,
    // as the exception it makes.
    function ruleOf(entry) {
      return entry.exception
        ? { value: FrontFilter.parseException(entry.value).rule, mode: ALLOW }
        : entry;
    }

    // The list's settings, as saves store them.
    function stored(list = entries) {
      const rows = list.map(ruleOf);
      const rules = rows.filter((entry) => entry.mode !== ALLOW)
        .map(({ value, mode }) => (storesModes ? { name: value, mode } : value));
      const settings = { [key]: normalizeList(rules) };
      if (allowKey) {
        settings[allowKey] = normalizeAllowList(rows
          .filter((entry) => entry.mode === ALLOW)
          .map(({ value }) => value));
      }
      return settings;
    }

    // Rules and exceptions alike.
    function ruleCount(settings = stored()) {
      return keys.reduce((count, settingKey) => count + settings[settingKey].length, 0);
    }

    // Stored settings as rows.
    function entriesOf(settings) {
      return [
        ...settings[key].map((rule) => (storesModes
          ? { value: rule.name, mode: rule.mode }
          : { value: rule, mode: blockMode })),
        ...(allowKey ? settings[allowKey].map((value) => ({ value, mode: ALLOW })) : []),
      ];
    }

    function formatCount(count) {
      return `${count} ${count === 1 ? countNouns[0] : countNouns[1]}`;
    }

    // The count shows once there are rules; an empty list says so itself.
    function updateCount() {
      const count = ruleCount();
      countEl.textContent = formatCount(count);
      countEl.hidden = count === 0;
    }

    // While settings are locked, a rule saves once typed: each step of
    // typing it would be a change of its own, which may wait.
    function save(immediate = true) {
      if (!immediate && lockCard.savesThroughLock()) {
        for (const settingKey of keys) pendingSaveKeys.add(settingKey);
        return;
      }
      scheduleAutoSave(keys, immediate);
    }

    // Rules compare as their list does, case-insensitively unless it says
    // otherwise; a merged row takes the mode that does most of either row's.
    function merge(list) {
      const byRule = new Map();
      return list.filter((entry) => {
        const rule = getRuleKey(entry.value);
        const first = rule && byRule.get(rule);
        if (!first) {
          if (rule) byRule.set(rule, entry);
          return true;
        }
        if (MODE_PRECEDENCE[entry.mode] > MODE_PRECEDENCE[first.mode]) first.mode = entry.mode;
        return false;
      });
    }

    // Returns whether a row was merged.
    function mergeDuplicates() {
      const merged = merge(entries);
      const changed = merged.length !== entries.length;
      entries = merged;
      return changed;
    }

    function matches(entry, needle) {
      return foldText(entry.value).includes(needle);
    }

    // Shows the rows a search matches; otherwise, unless the list is short
    // or shown in full, its first rules. Empty drafts and revealed rows
    // always show.
    function updateVisibility() {
      const count = ruleCount();
      const long = count > FOLD_AFTER;
      if (!long && query) {
        query = "";
        search.value = "";
      }
      const needle = foldText(query.trim());
      const folded = long && !expanded && !needle;
      let ruleIndex = 0;
      let matched = 0;
      for (const entry of entries) {
        const row = rows.get(entry);
        if (!row) continue;
        let visible = true;
        if (entry.value) {
          if (needle) {
            if (matches(entry, needle)) matched += 1;
            else visible = revealed.has(entry);
          } else if (folded) {
            visible = ruleIndex < FOLDED_ROWS || revealed.has(entry);
          }
          ruleIndex += 1;
        }
        row.hidden = !visible;
      }
      tools.hidden = !long;
      more.hidden = !long || Boolean(needle);
      more.textContent = expanded ? "Show fewer" : `Show all ${count}`;
      more.setAttribute("aria-expanded", String(expanded));
      noMatch.hidden = !needle || matched > 0;
      noMatch.textContent = noMatch.hidden ? "" : `No ${countNouns[1]} match “${query.trim()}”`;
      footer.hidden = more.hidden && noMatch.hidden;
    }

    // Keeps rows in view, clearing a search that would hide them.
    function reveal(shownEntries) {
      for (const entry of shownEntries) revealed.add(entry);
      const needle = foldText(query.trim());
      if (needle && shownEntries.some((entry) => entry.value && !matches(entry, needle))) {
        query = "";
        search.value = "";
      }
      updateVisibility();
    }

    // Shows a row, and moves the focus to it unless told otherwise.
    function focus(value, animate, moveFocus = true) {
      const entry = value ? entries.find((other) => other.value === value) : entries[0];
      const item = entry && rows.get(entry);
      if (!item) return;
      reveal([entry]);
      if (animate) item.classList.add("pop-in");
      if (moveFocus) item.querySelector("input").focus();
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
      // The rule as last normalized: only a + typed since makes an
      // exception, so a rule stored with a + of its own keeps it. The badge
      // shows the exception as soon as the + is typed.
      let committed = entry.value;
      input.addEventListener("input", () => {
        entry.value = input.value;
        entry.exception = Boolean(allowKey) && input.value !== committed
          && FrontFilter.parseException(input.value).exception;
        showMode();
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
        const typed = entry.exception
          ? FrontFilter.parseException(input.value)
          : { rule: input.value, exception: false };
        const normalized = normalize(typed.rule, typed.exception ? ALLOW : entry.mode);
        if (invalidMessage && input.value.trim() && !normalized) {
          showToast(invalidMessage, "error");
        }
        if (normalized && typed.exception) entry.mode = ALLOW;
        delete entry.exception;
        showMode();
        entry.value = normalized;
        input.value = normalized;
        committed = normalized;
        if (mergeDuplicates()) {
          removed = null;
          render();
          focus(normalized, true);
        }
        save();
      });
      item.append(input);

      const select = modes.length > 1 ? document.createElement("select") : null;
      function showMode() {
        if (!select) return;
        const mode = ruleOf(entry).mode;
        select.value = mode;
        for (const option of select.children) option.selected = option.value === mode;
      }
      if (select) {
        select.className = "mode-badge";
        select.setAttribute("aria-label", modeLabel);
        select.disabled = controlsDisabled;
        for (const [mode, text] of modes) {
          const option = document.createElement("option");
          option.value = mode;
          option.textContent = text;
          select.append(option);
        }
        showMode();
        select.addEventListener("change", () => {
          entry.mode = modes.some(([mode]) => mode === select.value) ? select.value : defaultMode;
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
        // An empty draft has nothing to restore.
        removed = entry.value ? entry : null;
        render();
        undoRow?.querySelector("button").focus();
        save();
      });
      item.append(removeButton);
      return item;
    }

    // Where a removed rule was: a row that says so and can put it back.
    let undoRow = null;

    function createUndoRow(entry) {
      const row = document.createElement("div");
      row.className = "entry-undo";
      const message = document.createElement("span");
      message.className = "entry-undo-text";
      message.textContent = `Removed “${entry.value}”`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-undo-button";
      button.textContent = "Undo";
      button.setAttribute("aria-label", `Undo removing “${entry.value}”`);
      button.disabled = controlsDisabled;
      button.addEventListener("click", () => {
        if (removed !== entry) return;
        removed = null;
        entries.push(entry);
        // The same rule may have been added again meanwhile.
        mergeDuplicates();
        render();
        focus(entry.value, true);
        save();
      });
      row.append(message, button);
      return row;
    }

    // New drafts come first, then rules and exceptions in alphabetical order.
    function byRule(a, b) {
      if (!a.value || !b.value) return Number(Boolean(a.value)) - Number(Boolean(b.value));
      return a.value.localeCompare(b.value, undefined, { sensitivity: "base" });
    }

    function render() {
      updateCount();
      for (const entry of revealed) {
        if (!entries.includes(entry)) revealed.delete(entry);
      }
      undoRow = removed && createUndoRow(removed);
      if (entries.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = emptyMessage;
        rows = new Map();
        listEl.replaceChildren(undoRow || empty);
        updateVisibility();
        return;
      }
      entries.sort(byRule);
      rows = new Map(entries.map((entry) => [entry, createRow(entry)]));
      const items = Array.from(rows.values());
      if (undoRow) {
        // In the removed rule's place among the others.
        items.splice(entries.filter((entry) => byRule(entry, removed) < 0).length, 0, undoRow);
      }
      listEl.replaceChildren(...items);
      updateVisibility();
    }

    // Adds a row, a draft unless a value is given, in the list's default
    // mode or the one given. A rule added from elsewhere on the page shows
    // without taking the focus there.
    function add(value = "", { moveFocus = true, mode = defaultMode } = {}) {
      const normalized = normalize(value, mode);
      removed = null;
      entries.unshift({ value: normalized, mode });
      mergeDuplicates();
      render();
      focus(normalized, true, moveFocus);
      if (normalized) save();
    }

    // Adds a pasted list's entries in place of the row it was pasted in,
    // in that row's mode but for exceptions written with a +, and tells
    // how many rules are new. Entries that cannot be used are
    // left out; if none can, the row stays as it was.
    function addList(list, row) {
      const added = list.map((text) => {
        const { rule, exception } = allowKey
          ? FrontFilter.parseException(text)
          : { rule: text, exception: false };
        const mode = exception ? ALLOW : row.mode;
        return { value: normalize(rule, mode), mode };
      }).filter(({ value }) => value);
      if (added.length === 0) {
        showToast(invalidMessage, "error");
        return;
      }
      const others = entries.filter((other) => other !== row);
      const previous = new Set(others.filter((entry) => entry.value)
        .map((entry) => getRuleKey(entry.value)));
      removed = null;
      entries = [...added, ...others];
      mergeDuplicates();
      render();
      save();

      // Pasted rows came first, so the rows left for their rules are theirs.
      const pastedSet = new Set(added);
      const pastedEntries = entries.filter((entry) => pastedSet.has(entry));
      reveal(pastedEntries);
      const items = pastedEntries.map((entry) => rows.get(entry));
      for (const item of items) item.classList.add("pop-in");
      items[0]?.querySelector("input").focus();

      const newCount = pastedEntries.filter((entry) => !previous.has(getRuleKey(entry.value))).length;
      const skipped = list.length - added.length;
      const message = newCount > 0 ? `Added ${formatCount(newCount)}` : `No new ${countNouns[1]}`;
      if (skipped === 0) {
        showToast(message, newCount > 0 ? "success" : "info");
      } else {
        showToast(`${message}; ${skipped} ${skipped === 1 ? "entry" : "entries"} could not be used`, "error");
      }
    }

    // Shows stored rules. A list that already shows them, in any order,
    // stays as it is; new rows that are still empty stay in any case. A
    // rule stored as an exception too shows once, as the exception it is.
    function show(settings) {
      const shownEntries = merge(entriesOf(settings));
      if (shown && sameRules(stored(shownEntries), stored())) return;
      shown = true;
      removed = null;
      entries = [...entries.filter((entry) => !entry.value), ...shownEntries];
      render();
    }

    search.addEventListener("input", () => {
      query = search.value;
      updateVisibility();
    });
    // Escape clears the search rather than closing the popup.
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !search.value) return;
      event.preventDefault();
      search.value = "";
      query = "";
      updateVisibility();
    });
    more.addEventListener("click", () => {
      expanded = !expanded;
      if (!expanded) revealed.clear();
      updateVisibility();
      if (!expanded) more.scrollIntoView?.({ block: "nearest" });
    });

    document.getElementById(addId).addEventListener("click", () => add());
    return {
      keys,
      title,
      add,
      show,
      stored,
      formatCount,
      updateCount,
    };
  }

  const subredditList = createEntryList({
    key: "blockedSubreddits",
    allowKey: "allowedSubreddits",
    title: "Subreddits",
    listId: "subreddit-list",
    searchLabel: "Search subreddits",
    countId: "subreddit-count",
    addId: "add-subreddit",
    itemClass: "subreddit-item",
    normalizeList: FrontFilter.normalizeBlockedSubreddits,
    normalizeAllowList: FrontFilter.normalizeAllowedSubreddits,
    // Rules block a front page (HOME) or everything (ALL). The stored names
    // are kept; these read better beside Reddit's own Home feed and r/all.
    blockModes: [["home", "Front page"], ["all", "Everywhere"]],
    storesModes: true,
    // New rows block everywhere, as the Block buttons on Reddit do.
    defaultMode: "all",
    modeLabel: "Block or allow",
    placeholder: "Subreddit, wildcard, or Reddit URL",
    label: "Subreddit, wildcard, or Reddit URL",
    removeLabel: "Remove subreddit rule",
    emptyMessage: "No subreddits blocked or allowed yet",
    invalidMessage: "Enter a subreddit name, a pattern with *, or a Reddit URL",
    countNouns: ["rule", "rules"],
  });
  const KEYWORD_INVALID_MESSAGE = "Enter a keyword, or a valid regular expression between slashes";
  const entryLists = [
    subredditList,
    createEntryList({
      key: "blockedTitleKeywords",
      allowKey: "allowedKeywords",
      title: "Keywords",
      listId: "keyword-list",
      searchLabel: "Search keywords",
      countId: "keyword-count",
      addId: "add-keyword",
      itemClass: "keyword-item",
      normalizeList: FrontFilter.normalizeTitleKeywords,
      getRuleKey: FrontFilter.getKeywordKey,
      splitList: (text) => FrontFilter.splitList(text, { keywords: true }),
      blockModes: [["block", "Hidden"]],
      modeLabel: "Hide or allow",
      placeholder: "Keyword, phrase, or /regex/",
      label: "Keyword, phrase, or regular expression",
      removeLabel: "Remove keyword",
      emptyMessage: "No keywords filtered yet",
      invalidMessage: KEYWORD_INVALID_MESSAGE,
      countNouns: ["keyword", "keywords"],
    }),
    createEntryList({
      key: "blockedFlairs",
      allowKey: "allowedFlairs",
      title: "Post flairs",
      listId: "flair-list",
      searchLabel: "Search flairs",
      countId: "flair-count",
      addId: "add-flair",
      itemClass: "flair-item",
      normalizeList: FrontFilter.normalizeBlockedFlairs,
      blockModes: [["block", "Hidden"]],
      modeLabel: "Hide or allow",
      placeholder: "Flair, e.g. Meme or *politic*",
      label: "Post flair",
      removeLabel: "Remove flair",
      emptyMessage: "No flairs filtered yet",
      invalidMessage: "Flairs can be at most 100 characters long",
      countNouns: ["flair", "flairs"],
    }),
    createEntryList({
      key: "blockedUsers",
      title: "Users",
      listId: "blocked-user-list",
      searchLabel: "Search users",
      countId: "blocked-user-count",
      addId: "add-blocked-user",
      itemClass: "user-item",
      normalizeList: FrontFilter.normalizeBlockedUsers,
      placeholder: "Username, u/name, or profile URL",
      label: "Username, u/name, or profile URL",
      removeLabel: "Remove user",
      emptyMessage: "No users filtered yet",
      invalidMessage: "Enter a username, such as u/name, or a profile URL",
      countNouns: ["user", "users"],
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
    showSetting("redirectUrl", (url) => {
      // So does an address still being typed, unless the stored one changed.
      if (url !== lastRedirectUrl) redirectUrl.value = url;
      lastRedirectUrl = url;
    });
    updateDependentControls();
    updateGroupControls();
    updateCurrentCard();
  }

  // Reads can finish out of order: an older one never replaces a newer one.
  async function loadSettings() {
    const read = ++lastRead;
    const stored = await chrome.storage.local.get([
      ...FrontFilter.STORAGE_KEYS,
      FrontFilter.IMPORT_BACKUP_KEY,
      FrontFilter.settingsLock.STORAGE_KEY,
    ]);
    if (read < lastShownRead) return;
    lastShownRead = read;
    lockCard.show(stored[FrontFilter.settingsLock.STORAGE_KEY]);
    showSettings(FrontFilter.coerceSettings(stored), read);
    showBackup(stored[FrontFilter.IMPORT_BACKUP_KEY]);
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

  // A configuration file's settings, as the version that exported them
  // meant them, or nothing when it holds none that can be used.
  async function readConfig(file) {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      showToast("Invalid config: expected a JSON object", "error");
      return null;
    }

    // Files exported by earlier versions keep their meaning.
    const imported = Object.fromEntries(
      Object.entries(FrontFilter.upgradeSettings(data))
        .filter(([key]) => FrontFilter.STORAGE_KEYS.includes(key)),
    );
    if (Object.keys(imported).length === 0) {
      showToast("Invalid config: no recognized keys", "error");
      return null;
    }

    const invalidKeys = FrontFilter.getInvalidSettingKeys(imported);
    if (invalidKeys.length > 0) {
      showToast(`Invalid config values: ${invalidKeys.join(", ")}`, "error");
      return null;
    }
    return imported;
  }

  // Stored settings not yet upgraded are upgraded with an import.
  async function readStoredSettings() {
    return FrontFilter.upgradeSettings(await chrome.storage.local.get([
      ...FrontFilter.STORAGE_KEYS,
      FrontFilter.SETTINGS_VERSION_KEY,
    ]));
  }

  // What an import changes: the size of each list it replaces, its rules
  // and exceptions together, and how many other settings it changes.
  // Lists compare in any order.
  function describeImport(current, imported) {
    const before = FrontFilter.coerceSettings(current);
    const after = FrontFilter.coerceSettings({ ...current, ...imported });
    const sorted = (value) => JSON.stringify(
      Array.isArray(value) ? value.map((item) => JSON.stringify(item)).sort() : value,
    );
    const changes = [];
    const described = new Set();
    let others = 0;
    for (const key of Object.keys(imported)) {
      if (sorted(before[key]) === sorted(after[key])) continue;
      const list = entryLists.find((other) => other.keys.includes(key));
      if (!list) {
        others += 1;
        continue;
      }
      if (described.has(list)) continue;
      described.add(list);
      const size = (settings) => list.keys.reduce((total, listKey) => total + settings[listKey].length, 0);
      const count = list.formatCount(size(after));
      changes.push(size(before) === size(after)
        ? `${list.title}: ${count}, replaced`
        : `${list.title}: ${size(before)} → ${count}`);
    }
    if (others > 0) {
      const noun = others === 1 ? "setting" : "settings";
      changes.push(changes.length > 0 ? `${others} other ${noun}` : `${others} ${noun}`);
    }
    return changes;
  }

  // An import waits for confirmation, after showing what it would change.
  let pendingImport = null;
  const IMPORT_NOTE = FrontFilter.normalizeText(importReview.note.textContent);
  const IMPORT_NOTE_LOCKED = "Lists in the file replace yours, but while settings are locked, "
    + "what loosens them waits. You can restore your current settings afterwards.";

  async function reviewImport(file) {
    try {
      const imported = await readConfig(file);
      if (!imported) return;
      await flushPendingSave();
      const changes = describeImport(await readStoredSettings(), imported);
      pendingImport = changes.length > 0 ? imported : null;
      importReview.title.textContent = changes.length > 0
        ? "Import this file?"
        : "This file matches your settings";
      importReview.changes.replaceChildren(...changes.map((change) => {
        const item = document.createElement("li");
        item.textContent = change;
        return item;
      }));
      importReview.note.textContent = lockCard.isLocked() ? IMPORT_NOTE_LOCKED : IMPORT_NOTE;
      importReview.note.hidden = changes.length === 0;
      importReview.confirm.hidden = changes.length === 0;
      importReview.cancel.textContent = changes.length > 0 ? "Cancel" : "Close";
      importReview.element.hidden = false;
      importReview.title.focus();
    } catch (error) {
      showToast(`Import failed: ${error.message}`, "error");
    }
  }

  function closeImportReview() {
    pendingImport = null;
    importReview.element.hidden = true;
    importConfigButton.focus();
  }

  // Settings in the file replace their current values; others stay. The
  // settings it replaces are kept, in the same write, to restore them.
  async function applyImport() {
    const imported = pendingImport;
    if (!imported) return;
    pendingImport = null;
    importReview.element.hidden = true;
    setControlsDisabled(true);
    try {
      await flushPendingSave();
      let result = null;
      await enqueueStorageOperation(async () => {
        const current = await readStoredSettings();
        const extra = {
          [FrontFilter.SETTINGS_VERSION_KEY]: FrontFilter.SETTINGS_VERSION,
          [FrontFilter.IMPORT_BACKUP_KEY]: backupOf(current, "import"),
        };
        if (lockCard.savesThroughLock()) {
          result = await saveThroughLock(imported, { extra, source: "import" });
          return;
        }
        await chrome.storage.local.set({
          ...FrontFilter.coerceSettings({ ...current, ...imported }),
          ...extra,
        });
      });
      await loadSettings();
      if (!lockCard.report(result)) showToast("Configuration imported!", "success");
    } catch (error) {
      showToast(`Import failed: ${error.message}`, "error");
    } finally {
      setControlsDisabled(false);
    }
    importConfigButton.focus();
  }

  function backupOf(settings, replacedBy) {
    return {
      replacedBy,
      savedAt: Date.now(),
      settings: {
        ...FrontFilter.coerceSettings(settings),
        [FrontFilter.SETTINGS_VERSION_KEY]: FrontFilter.SETTINGS_VERSION,
      },
    };
  }

  // Restoring swaps the settings with the backup, so a restore can be
  // undone the same way.
  async function restoreBackup() {
    setControlsDisabled(true);
    try {
      await flushPendingSave();
      let result = null;
      await enqueueStorageOperation(async () => {
        const key = FrontFilter.IMPORT_BACKUP_KEY;
        const { [key]: backup } = await chrome.storage.local.get(key);
        if (!backup?.settings) throw new Error("no saved settings to restore");
        const current = await readStoredSettings();
        const settings = FrontFilter.coerceSettings(FrontFilter.upgradeSettings(backup.settings));
        const extra = {
          [FrontFilter.SETTINGS_VERSION_KEY]: FrontFilter.SETTINGS_VERSION,
          [key]: backupOf(current, "restore"),
        };
        if (lockCard.savesThroughLock()) {
          result = await saveThroughLock(settings, { extra, source: "restore" });
          return;
        }
        await chrome.storage.local.set({ ...settings, ...extra });
      });
      await loadSettings();
      if (!lockCard.report(result)) showToast("Settings restored", "success");
    } catch (error) {
      showToast(`Restore failed: ${error.message}`, "error");
    } finally {
      setControlsDisabled(false);
    }
  }

  function showBackup(backup) {
    const savedAt = Number(backup?.savedAt);
    backupRestore.hidden = !backup?.settings || !Number.isFinite(savedAt);
    if (backupRestore.hidden) return;
    const when = new Date(savedAt).toLocaleString(undefined, {
      dateStyle: "medium", timeStyle: "short",
    });
    const event = backup.replacedBy === "restore" ? "your restore" : "your import";
    backupRestoreText.textContent = `Your settings before ${event} of ${when}`;
  }

  // The current tab and its address, if it shows Reddit: browsers give
  // only the URLs of tabs FrontFilter can access, Reddit's.
  async function findCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = FrontFilter.getRedditUrl(tab?.url);
    return url ? { id: tab.id, url } : null;
  }

  // The subreddit this page was opened for, or that the current tab shows.
  async function findCurrentSubreddit() {
    if (standaloneCurrentSubreddit) return standaloneCurrentSubreddit;
    const tab = await findCurrentTab();
    return (tab && FrontFilter.getSubredditPath(tab.url.pathname)?.name) || "";
  }

  // Adds a rule for the current subreddit, in the mode given, and returns
  // whether a subreddit was found to add.
  async function addCurrentSubreddit(mode, message) {
    try {
      const subreddit = await findCurrentSubreddit();
      if (subreddit) {
        subredditList.add(subreddit, { moveFocus: false, mode });
        // While locked, an exception may wait, which its save tells.
        if (mode !== ALLOW || !lockCard.isLocked()) showToast(message(subreddit), "success");
        return true;
      }
      showToast("No subreddit found on current tab", "error");
    } catch {
      showToast("Could not access current tab", "error");
    }
    return false;
  }

  // Whether the page has a content script that listens: one loaded before
  // FrontFilter was installed, updated or reloaded has none, as browsers
  // add none to pages already open.
  async function pageListens(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: "countHidden" });
      return true;
    } catch {
      return false;
    }
  }

  // Blocking the subreddit in front sends its page to the block page. Its
  // content script does so once the rule is saved; a page without one is
  // reloaded, once the navigation rules block it, which also gives it one.
  async function blockCurrentSubreddit() {
    const { tabId } = currentCard;
    const listens = tabId === null || await pageListens(tabId);
    const added = await addCurrentSubreddit(
      "all", (subreddit) => `r/${subreddit} blocked everywhere`,
    );
    if (!added || listens) return;
    try {
      await flushPendingSave();
    } catch {
      // The rule was not saved, and the save says so.
      return;
    }
    try {
      // Without the rules, the reloaded page's content script blocks it.
      await chrome.runtime.sendMessage({ action: "syncNavigationRules" }).catch(() => undefined);
      await chrome.tabs.reload(tabId);
    } catch (error) {
      console.error("Could not reload the blocked page:", error);
    }
  }

  // What the rules do to a subreddit: one an exception allows stays open,
  // and an exact name or a pattern may block it everywhere or on its front
  // page.
  function describeSubreddit(name) {
    const { blockedSubreddits, allowedSubreddits } = subredditList.stored();
    const exceptions = allowedSubreddits
      .filter((pattern) => FrontFilter.matchesSubredditPattern(pattern, name));
    if (exceptions.length > 0) {
      const by = exceptions.includes(name) ? "" : ` by ${exceptions[0]}`;
      return { text: `Allowed${by}, so it stays open`, allowed: true };
    }
    const rules = blockedSubreddits
      .filter((rule) => FrontFilter.matchesSubredditPattern(rule.name, name));
    const rule = rules.find((other) => other.mode === "all") || rules[0];
    const by = rule && rule.name !== name ? ` by ${rule.name}` : "";
    if (rule?.mode === "all") return { text: `Blocked everywhere${by}`, everywhere: true };
    if (rule) return { text: `Front page blocked${by}` };
    if (switches.blockSubHome.checked) return { text: "Front page blocked, like every subreddit's" };
    return { text: "Not blocked" };
  }

  // A Reddit page other than a subreddit, by the name the settings and
  // statistics give it, and the prefix of a profile.
  function nameOfPage(pathname) {
    const user = FrontFilter.getProfileUser(pathname);
    if (user) return { prefix: "u/", name: `u/${user}` };
    const route = FrontFilter.PAGE_ROUTES
      .find(({ path }) => new RegExp(`^${path}$`, "i").test(pathname));
    return { prefix: "", name: route ? FrontFilter.stats.describeTarget(`page:${route.page}`) : "Reddit" };
  }

  const numberFormat = new Intl.NumberFormat();
  const formatNumber = (count) => numberFormat.format(count);

  // What filters hide on the page, as the card says it.
  function describeCounts({ posts, comments }) {
    const parts = [
      posts > 0 && `${formatNumber(posts)} ${posts === 1 ? "post" : "posts"}`,
      comments > 0 && `${formatNumber(comments)} ${comments === 1 ? "comment" : "comments"}`,
    ].filter(Boolean);
    return parts.length > 0 ? `${parts.join(" and ")} hidden on this page` : "Nothing hidden on this page";
  }

  // The card shows on a subreddit, and on any other Reddit page that says
  // what filters hide on it. A subreddit's buttons are off where they
  // would change nothing: an allowed subreddit stays open whatever blocks it.
  function updateCurrentCard() {
    const { subreddit, counts } = currentCard;
    currentCard.element.hidden = !subreddit && !counts;
    currentCard.countsText.hidden = !counts;
    if (counts) currentCard.countsText.textContent = describeCounts(counts);
    currentCard.status.hidden = !subreddit;
    currentCard.actions.hidden = !subreddit;
    if (!subreddit) return;
    const state = describeSubreddit(subreddit);
    currentCard.status.textContent = state.text;
    currentCard.block.disabled = controlsDisabled || Boolean(state.everywhere || state.allowed);
    currentCard.allow.disabled = controlsDisabled || Boolean(state.allowed);
  }

  // The page's content script counts what filters hide on it. It answers
  // nothing where it cannot count every post, as in Old Reddit or search
  // results, nor where it does not run, as on a page loaded before
  // FrontFilter was.
  async function readCounts(tabId) {
    try {
      const counts = await chrome.tabs.sendMessage(tabId, { action: "countHidden" });
      const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
      if (!isCount(counts?.posts) || !isCount(counts?.comments)) return null;
      return { posts: counts.posts, comments: counts.comments };
    } catch {
      return null;
    }
  }

  // The count keeps up with the page while the popup is open, as Reddit
  // loads posts and settings change, for as long as the page answers.
  const COUNTS_REFRESH = 1000;
  async function refreshCounts() {
    const counts = await readCounts(currentCard.tabId);
    if (JSON.stringify(counts) !== JSON.stringify(currentCard.counts)) {
      currentCard.counts = counts;
      updateCurrentCard();
    }
    if (counts) setTimeout(refreshCounts, COUNTS_REFRESH);
  }

  async function showCurrentPage() {
    let tab = null;
    try {
      // In a tab of its own, the current tab is this page.
      if (!standalone) tab = await findCurrentTab();
    } catch {
      // Without the tab, the card shows nothing of it.
    }
    const subreddit = standaloneCurrentSubreddit
      || (tab && FrontFilter.getSubredditPath(tab.url.pathname)?.name) || "";
    let page = { prefix: "", name: "" };
    if (subreddit) page = { prefix: "r/", name: `r/${subreddit}` };
    else if (tab) page = nameOfPage(tab.url.pathname);
    const { prefix, name } = page;
    Object.assign(currentCard, { tabId: tab?.id ?? null, subreddit });
    currentCard.prefix.textContent = prefix;
    currentCard.name.textContent = name;
    // A long name is cut short on screen, and whole here.
    currentCard.name.setAttribute("title", name);
    currentCard.block.setAttribute("aria-label", `Block ${name}`);
    currentCard.allow.setAttribute("aria-label", `Allow ${name}`);
    updateCurrentCard();
    if (tab) await refreshCounts();
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

  currentCard.block.addEventListener("click", blockCurrentSubreddit);
  currentCard.allow.addEventListener("click", () => addCurrentSubreddit(
    ALLOW, (subreddit) => `r/${subreddit} allowed`,
  ));
  document.getElementById("export-config").addEventListener("click", exportConfig);
  // Saves what is being typed, opens the page in a tab, for the same
  // subreddit, and closes the popup.
  openInTab.addEventListener("click", async () => {
    await flushPendingSave().catch(() => undefined);
    const subreddit = currentCard.subreddit;
    try {
      const response = await chrome.runtime.sendMessage({
        action: "openSettings", currentSubreddit: subreddit,
      });
      if (!response?.success) throw new Error(response?.error);
    } catch {
      await chrome.tabs.create({ url: chrome.runtime.getURL(FrontFilter.settingsPagePath(subreddit)) });
    }
    globalThis.close?.();
  });
  const importConfigButton = document.getElementById("import-config");
  importConfigButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => {
    const [file] = importFile.files;
    if (file) void reviewImport(file);
    importFile.value = "";
  });
  importReview.confirm.addEventListener("click", applyImport);
  importReview.cancel.addEventListener("click", closeImportReview);
  document.getElementById("restore-backup").addEventListener("click", restoreBackup);

  // Settings changed elsewhere, such as by a Block button on Reddit, the
  // block page or another settings page, show here too. Otherwise a list
  // saved here would put back rules removed elsewhere and drop rules added.
  chrome.storage.onChanged.addListener((changes, area) => {
    const watched = [
      ...FrontFilter.STORAGE_KEYS,
      FrontFilter.IMPORT_BACKUP_KEY,
      FrontFilter.settingsLock.STORAGE_KEY,
    ];
    if (area !== "local" || !watched.some((key) => Object.hasOwn(changes, key))) {
      return;
    }
    loadSettings().catch((error) => console.error("Could not reload FrontFilter settings:", error));
  });

  const statsTab = FrontFilter.createStatsTab({ showToast });

  void showCurrentPage();
  void statsTab.load();
  setControlsDisabled(true);
  loadSettings()
    .then(() => setControlsDisabled(false))
    .catch((error) => {
      showToast(`Could not load settings: ${error.message}`, "error");
    });
});
