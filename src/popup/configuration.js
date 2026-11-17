/**
 * The settings page's configuration backup (popup.js): exports the settings
 * to a file, imports one after showing what it would change, and keeps the
 * settings an import or a restore replaced, to put them back.
 *
 * The page gives the lists of rules, to describe what an import changes,
 * and its own saving: imports and restores run after what it is saving, and
 * through the lock while settings are locked.
 */
FrontFilter.createConfigurationCard = function ({
  standalone, entryLists, lockCard, showToast,
  flushPendingSave, enqueueStorageOperation, saveThroughLock, loadSettings,
  setControlsDisabled, openSettingsTab,
}) {
  const VERSION_KEY = FrontFilter.SETTINGS_VERSION_KEY;
  const BACKUP_KEY = FrontFilter.IMPORT_BACKUP_KEY;
  const byId = (id) => document.getElementById(id);
  const importButton = byId("import-config");
  const importFile = byId("import-file");
  const review = {
    element: byId("import-review"),
    title: byId("import-review-title"),
    changes: byId("import-review-changes"),
    note: byId("import-review-note"),
    confirm: byId("import-confirm"),
    cancel: byId("import-cancel"),
  };
  const backupRestore = byId("backup-restore");
  const backupRestoreText = byId("backup-restore-text");
  const IMPORT_NOTE = FrontFilter.normalizeText(review.note.textContent);
  const IMPORT_NOTE_LOCKED = "Lists in the file replace yours, but while settings are locked, "
    + "what loosens them waits. You can restore your current settings afterwards.";
  // An import waits for confirmation, after showing what it would change.
  let pendingImport = null;

  async function exportConfig() {
    try {
      await flushPendingSave();
      const data = {
        // Imports read the file's keywords as this version wrote them.
        [VERSION_KEY]: FrontFilter.SETTINGS_VERSION,
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

  function readStoredSettings() {
    return chrome.storage.local.get(FrontFilter.STORAGE_KEYS);
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

  async function reviewImport(file) {
    try {
      const imported = await readConfig(file);
      if (!imported) return;
      await flushPendingSave();
      const changes = describeImport(await readStoredSettings(), imported);
      pendingImport = changes.length > 0 ? imported : null;
      review.title.textContent = changes.length > 0
        ? "Import this file?"
        : "This file matches your settings";
      review.changes.replaceChildren(...changes.map((change) => {
        const item = document.createElement("li");
        item.textContent = change;
        return item;
      }));
      review.note.textContent = lockCard.isLocked() ? IMPORT_NOTE_LOCKED : IMPORT_NOTE;
      review.note.hidden = changes.length === 0;
      review.confirm.hidden = changes.length === 0;
      review.cancel.textContent = changes.length > 0 ? "Cancel" : "Close";
      review.element.hidden = false;
      review.title.focus();
    } catch (error) {
      showToast(`Import failed: ${error.message}`, "error");
    }
  }

  function closeImportReview() {
    pendingImport = null;
    review.element.hidden = true;
    importButton.focus();
  }

  // A backup holds settings as an export does, with their version.
  function backupOf(settings, replacedBy) {
    return {
      replacedBy,
      savedAt: Date.now(),
      settings: {
        ...FrontFilter.coerceSettings(settings),
        [VERSION_KEY]: FrontFilter.SETTINGS_VERSION,
      },
    };
  }

  // Replaces settings with those an import or a restore brings, read once
  // its turn to write has come. The settings they replace are kept, in the
  // same write, to restore them; others stay. Returns what the lock left
  // waiting, if settings are locked.
  async function replaceSettings(source, readChanges) {
    setControlsDisabled(true);
    try {
      await flushPendingSave();
      let result = null;
      await enqueueStorageOperation(async () => {
        const changes = await readChanges();
        const current = await readStoredSettings();
        const extra = { [BACKUP_KEY]: backupOf(current, source) };
        if (lockCard.savesThroughLock()) {
          result = await saveThroughLock(changes, { extra, source });
          return;
        }
        await chrome.storage.local.set({
          ...FrontFilter.coerceSettings({ ...current, ...changes }),
          ...extra,
        });
      });
      await loadSettings();
      return result;
    } finally {
      setControlsDisabled(false);
    }
  }

  // Settings in the file replace their current values.
  async function applyImport() {
    const imported = pendingImport;
    if (!imported) return;
    pendingImport = null;
    review.element.hidden = true;
    try {
      const result = await replaceSettings("import", () => imported);
      if (!lockCard.report(result)) showToast("Configuration imported!", "success");
    } catch (error) {
      showToast(`Import failed: ${error.message}`, "error");
    }
    importButton.focus();
  }

  // Restoring swaps the settings with the backup, so a restore can be
  // undone the same way.
  async function restoreBackup() {
    try {
      const result = await replaceSettings("restore", async () => {
        const { [BACKUP_KEY]: backup } = await chrome.storage.local.get(BACKUP_KEY);
        if (!backup?.settings) throw new Error("no saved settings to restore");
        // A backup kept since an earlier version keeps its meaning.
        return FrontFilter.coerceSettings(FrontFilter.upgradeSettings(backup.settings));
      });
      if (!lockCard.report(result)) showToast("Settings restored", "success");
    } catch (error) {
      showToast(`Restore failed: ${error.message}`, "error");
    }
  }

  // Offers the settings the last import or restore replaced, if any.
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

  byId("export-config").addEventListener("click", exportConfig);
  // A file picker can close the popup, as Firefox's always does, and the
  // import with it: the popup imports from a tab of its own.
  importButton.addEventListener("click", () => {
    if (standalone) importFile.click();
    else void openSettingsTab({ importing: true });
  });
  importFile.addEventListener("change", () => {
    const [file] = importFile.files;
    if (file) void reviewImport(file);
    importFile.value = "";
  });
  review.confirm.addEventListener("click", applyImport);
  review.cancel.addEventListener("click", closeImportReview);
  byId("restore-backup").addEventListener("click", restoreBackup);

  return {
    showBackup,
    // Opened to import, the page points at its Import button.
    focusImport: () => importButton.focus(),
  };
};
