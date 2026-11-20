/**
 * The settings page's lists of rules: subreddits, keywords, flairs and
 * users (popup.js). Each list edits one setting, or two when it takes
 * exceptions, and asks the page to save them.
 */
FrontFilter.entryList = (() => {
  const { t, plural } = FrontFilter.i18n;
  // A list that takes exceptions shows them among its rules: each row is
  // either, as its badge says, and a + typed or pasted before a rule makes
  // it an exception. Exceptions are stored in a setting of their own.
  const ALLOW = "allow";
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
  //
  // The page saves the list's settings when asked to, at once or once
  // typing pauses, tells whether its controls are disabled, and shows the
  // list's messages. The list's own texts name what it holds: its count,
  // what a pasted list added, and what a search found, take the number or
  // the search.
  function create({
    key, allowKey = null, title, listId, countId, addId, itemClass,
    normalizeList, normalizeAllowList = normalizeList,
    blockModes = [["block", ""]], storesModes = false, defaultMode = blockModes[0][0], modeLabel,
    getRuleKey = (value) => value.toLowerCase(), splitList = FrontFilter.splitList,
    placeholder, label, removeLabel, emptyMessage, invalidMessage, searchLabel,
    countText, addedText, noneNewText, noMatchText,
  }, { saveSettings, isDisabled, showToast }) {
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    const keys = allowKey ? [key, allowKey] : [key];
    // What a row's badge offers; a list with one choice has no badge.
    const modes = allowKey ? [...blockModes, [ALLOW, t("listModeAllowed")]] : blockModes;
    const blockMode = blockModes[0][0];
    let entries = [];
    let shown = false;
    let rows = new Map();
    let expanded = false;
    let query = "";
    const revealed = new Set();
    // The rule removed last, which the row left in its place can restore
    // until the list changes otherwise, and that row.
    let removed = null;
    let undoRow = null;

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
      const listed = list.map(ruleOf);
      const rules = listed.filter((entry) => entry.mode !== ALLOW)
        .map(({ value, mode }) => (storesModes ? { name: value, mode } : value));
      const settings = { [key]: normalizeList(rules) };
      if (allowKey) {
        settings[allowKey] = normalizeAllowList(listed
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

    // The count shows once there are rules; an empty list says so itself.
    function updateCount() {
      const count = ruleCount();
      countEl.textContent = countText(count);
      countEl.hidden = count === 0;
    }

    // Typing saves once it pauses; other changes save at once.
    function save(immediate = true) {
      saveSettings(keys, immediate);
    }

    // Rules compare as their list does, case-insensitively unless it says
    // otherwise; a merged row takes the mode that does most of either row's.
    function merge(list) {
      const firstByRule = new Map();
      return list.filter((entry) => {
        const rule = getRuleKey(entry.value);
        const first = rule && firstByRule.get(rule);
        if (!first) {
          if (rule) firstByRule.set(rule, entry);
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
      more.textContent = expanded ? t("listShowFewer") : plural("listShowAll", count);
      more.setAttribute("aria-expanded", String(expanded));
      noMatch.hidden = !needle || matched > 0;
      noMatch.textContent = noMatch.hidden ? "" : noMatchText(query.trim());
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
      input.disabled = isDisabled();
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
        select.disabled = isDisabled();
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
      removeButton.title = t("listRemove");
      removeButton.setAttribute("aria-label", removeLabel);
      removeButton.textContent = "×";
      removeButton.disabled = isDisabled();
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
    function createUndoRow(entry) {
      const row = document.createElement("div");
      row.className = "entry-undo";
      const message = document.createElement("span");
      message.className = "entry-undo-text";
      message.textContent = t("listRemoved", entry.value);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-undo-button";
      button.textContent = t("commonUndo");
      button.setAttribute("aria-label", t("listUndoRemove", entry.value));
      button.disabled = isDisabled();
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
      return a.value.localeCompare(b.value, FrontFilter.i18n.locale, { sensitivity: "base" });
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
      const message = newCount > 0 ? addedText(newCount) : noneNewText;
      if (skipped === 0) {
        showToast(message, newCount > 0 ? "success" : "info");
      } else {
        showToast(plural("listSkipped", skipped, message), "error");
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
      countText,
      updateCount,
    };
  }

  return Object.freeze({ ALLOW, create });
})();
