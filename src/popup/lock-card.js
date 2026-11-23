/**
 * The settings page's settings lock: locks the settings until a date, after
 * a warning that says what the lock does, then shows until when, what
 * waits, and when it applies, and changes or ends the lock. The background
 * keeps the lock (shared/settings-lock.js), so this page asks it for every
 * change while one is on.
 */

FrontFilter.createLockCard = function ({ showToast, labelOf, showLockSection }) {
  const LOCK = FrontFilter.settingsLock;
  const { t, plural, locale } = FrontFilter.i18n;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // The longest a timer waits: 2^31 - 1 ms, about 24 days.
  const MAX_TIMEOUT = 2 ** 31 - 1;
  const byId = (id) => document.getElementById(id);
  const card = {
    heading: byId("lock-heading"),
    state: byId("lock-state"),
    text: byId("lock-text"),
    grace: byId("lock-grace"),
    fields: byId("lock-fields"),
    until: byId("lock-until"),
    delay: byId("lock-delay"),
    start: byId("lock-start"),
    change: byId("lock-change"),
    end: byId("lock-end"),
    save: byId("lock-save"),
    editCancel: byId("lock-edit-cancel"),
    confirm: byId("lock-confirm"),
    confirmTitle: byId("lock-confirm-title"),
    confirmDetails: byId("lock-confirm-details"),
    acknowledge: byId("lock-acknowledge"),
    acknowledgeText: byId("lock-acknowledge-text"),
    confirmButton: byId("lock-confirm-button"),
    confirmCancel: byId("lock-confirm-cancel"),
    pending: byId("lock-pending"),
    pendingList: byId("lock-pending-list"),
    banner: byId("lock-banner"),
    bannerText: byId("lock-banner-text"),
    bannerDetails: byId("lock-banner-details"),
  };
  // The lock as last read, null without one.
  let lock = null;
  let editing = false;
  let disabled = false;
  // The lock's settings the warning describes, while it shows.
  let confirming = null;
  // Asked once per lock read: the background applies what came due.
  let updateAsked = false;
  // Shows the card again when time changes it.
  let timer = 0;

  for (const delay of LOCK.DELAYS) {
    const option = document.createElement("option");
    option.value = delay === null ? "end" : String(delay);
    option.textContent = delay === null ? t("lockDelayUntilEnd") : formatDuration(delay);
    card.delay.append(option);
  }

  // A length of time, in its largest unit that reads well.
  function formatDuration(ms) {
    const hours = Math.round(ms / HOUR);
    if (hours >= 48) return plural("lockDays", Math.round(ms / DAY));
    if (hours === 24) return plural("lockDays", 1);
    if (hours >= 1) return plural("lockHours", hours);
    return plural("lockMinutes", Math.max(1, Math.round(ms / MINUTE)));
  }

  // A time, with its year when it is not this year's.
  function formatTime(time) {
    const date = new Date(time);
    return date.toLocaleString(locale, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
    });
  }

  // A time as a datetime-local field holds it, in local time.
  function toFieldValue(time) {
    const date = new Date(time);
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function readUntil() {
    const { value } = card.until;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)
      ? new Date(value).getTime()
      : Number.NaN;
  }

  function readDelay() {
    if (card.delay.value === "end") return null;
    const delay = Number(card.delay.value);
    return LOCK.DELAYS.includes(delay) ? delay : LOCK.DEFAULT_DELAY;
  }

  function showDelay(delay) {
    card.delay.value = delay === null ? "end" : String(delay);
  }

  // A week from now, at the next full hour.
  function defaultUntil(now) {
    const date = new Date(now + 7 * DAY);
    date.setMinutes(0, 0, 0);
    date.setHours(date.getHours() + 1);
    return date.getTime();
  }

  // Why an end cannot be used, or nothing.
  function untilProblem(until, now) {
    if (!Number.isFinite(until)) return t("lockChooseEnd");
    if (until - now < LOCK.MIN_DURATION) return t("lockChooseFuture");
    return "";
  }

  function isLocked() {
    return LOCK.isActive(lock, Date.now());
  }

  // Saves go through the background while a lock is stored, even one just
  // over: the background applies what waited first, then the save.
  function savesThroughLock() {
    return Boolean(lock);
  }

  // What a change that waits does, in words.
  function describeChange({ key, value, entry }) {
    const shown = value ?? entry;
    if (key === LOCK.UNTIL) return value === 0 ? t("lockChangeEnd") : t("lockChangeEndOn", formatTime(value));
    if (key === LOCK.DELAY) {
      return value === null ? t("lockChangeDelayUntilEnd") : t("lockChangeDelay", formatDuration(value));
    }
    switch (key) {
      case "blockedSubreddits":
        return value ? t("lockChangeSubredditFront", shown.name) : t("lockChangeSubredditRemove", shown.name);
      case "allowedSubreddits": return t("lockChangeSubredditAllow", shown);
      case "blockedUsers": return t("lockChangeUserRemove", shown);
      case "blockedTitleKeywords": return t("lockChangeKeywordRemove", shown);
      case "allowedKeywords": return t("lockChangeKeywordAllow", shown);
      case "blockedFlairs": return t("lockChangeFlairRemove", shown);
      case "allowedFlairs": return t("lockChangeFlairAllow", shown);
      case "scrollLimit": return plural("lockChangeScrollLimit", value, labelOf(key));
      case "commentLimit": return plural("lockChangeCommentLimit", value, labelOf(key));
      case "scrollMode":
      case "commentLimitMode":
        return t("lockChangeLimitMode", labelOf(key));
      default: return t("lockChangeTurnOff", labelOf(key));
    }
  }

  // What a request does: one change, a switch with its sections, or what
  // an import or a restore loosens.
  function describeRequest({ changes, source }) {
    const [first, ...others] = changes;
    const sections = FrontFilter.SETTING_GROUPS[first.key] || [];
    if (others.every((change) => sections.includes(change.key))) return describeChange(first);
    if (source === "import") return plural("lockChangesFromImport", changes.length);
    if (source === "restore") return plural("lockChangesFromRestore", changes.length);
    return plural("lockChangeAndMore", others.length, describeChange(first));
  }

  // Until when a change waits, as a sentence ends.
  function describeWhen(due) {
    return due >= lock?.until ? t("lockWhenEnds", formatTime(due)) : t("lockWhen", formatTime(due));
  }

  // Tells what a save through the lock left waiting, if anything, and
  // returns whether it did.
  function report(result) {
    if (result?.refused?.length > 0) {
      showToast(t("lockRefused", formatTime(lock?.until)), "error");
      return true;
    }
    const waiting = result?.waiting ?? [];
    if (waiting.length === 0) return false;
    const when = describeWhen(Math.max(...waiting.map((change) => change.due)));
    showToast(waiting.length === 1
      ? t("lockChangeWaits", describeChange(waiting[0]), when)
      : plural("lockChangesWait", waiting.length, when));
    return true;
  }

  // Asks the background for a change to the lock, with the card's controls
  // off until it answers, and shows the card again.
  async function ask(message) {
    disabled = true;
    updateControls();
    try {
      return await FrontFilter.askBackground(message);
    } finally {
      disabled = false;
      render();
    }
  }

  function renderPending(now) {
    const requests = (lock?.pending ?? [])
      .map((request) => ({ request, due: LOCK.appliesAt(lock, request) }))
      .sort((a, b) => a.due - b.due || a.request.id - b.request.id);
    card.pending.hidden = requests.length === 0;
    card.pendingList.replaceChildren(...requests.map(({ request, due }) => {
      const item = document.createElement("li");
      item.className = "lock-pending-item";
      const text = document.createElement("span");
      text.className = "lock-pending-text";
      const change = document.createElement("span");
      change.className = "lock-pending-change";
      const description = describeRequest(request);
      change.textContent = description;
      const when = document.createElement("span");
      when.className = "lock-pending-when";
      when.textContent = due <= now ? t("lockAppliesNow") : t("lockWaits", describeWhen(due));
      text.append(change, when);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-secondary lock-pending-cancel";
      cancel.textContent = t("commonCancel");
      cancel.setAttribute("aria-label", t("lockCancelChange", description));
      cancel.disabled = disabled;
      cancel.addEventListener("click", () => cancelRequest(request.id));
      item.append(text, cancel);
      return item;
    }));
  }

  function render() {
    const now = Date.now();
    const locked = LOCK.isActive(lock, now);
    if (!locked) editing = false;
    if (locked) closeConfirm({ moveFocus: false });
    const waiting = lock?.pending.length ?? 0;
    card.state.hidden = !locked;
    if (locked) card.state.textContent = t("lockLockedUntil", formatTime(lock.until));
    else card.text.textContent = t("lockIntro");
    card.fields.hidden = locked && !editing;
    card.start.hidden = locked;
    card.change.hidden = !locked || editing;
    card.save.hidden = !editing;
    card.editCancel.hidden = !editing;
    card.banner.hidden = !locked;
    if (locked) {
      card.bannerText.textContent = waiting > 0
        ? plural("lockBannerWaiting", waiting, formatTime(lock.until))
        : t("lockLockedUntil", formatTime(lock.until));
    }
    renderPending(now);
    renderTimed(now);
    updateControls();
  }

  // What time changes while the lock lasts, shown again when it next does:
  // what a loosening change would wait, which is until the lock ends once
  // that comes before its delay; End lock, which goes then; and, in a new
  // lock's grace period, the minutes left to end it at once.
  function renderTimed(now) {
    clearTimeout(timer);
    const locked = LOCK.isActive(lock, now);
    card.end.hidden = !locked || editing || !LOCK.canEnd(lock, now);
    const graceLeft = locked ? LOCK.endsAtOnceUntil(lock, now) - now : 0;
    card.grace.hidden = graceLeft <= 0;
    if (!locked) return;
    const waitsToEnd = lock.delay === null || now + lock.delay >= lock.until;
    card.text.textContent = waitsToEnd
      ? t("lockLockedTextUntilEnd")
      : t("lockLockedText", formatDuration(lock.delay));
    const changes = [];
    if (!waitsToEnd) changes.push(lock.until - lock.delay - now);
    if (graceLeft > 0) {
      const minutes = Math.ceil(graceLeft / MINUTE);
      card.grace.textContent = t("lockGrace", plural("lockMinutes", minutes));
      changes.push(graceLeft - (minutes - 1) * MINUTE);
    }
    if (changes.length > 0) {
      timer = setTimeout(() => renderTimed(Date.now()), Math.min(...changes, MAX_TIMEOUT));
    }
  }

  function updateControls() {
    for (const control of [card.until, card.delay, card.start, card.change, card.end, card.save,
      card.editCancel, card.acknowledge, card.confirmCancel, card.bannerDetails]) {
      control.disabled = disabled;
    }
    card.confirmButton.disabled = disabled || !card.acknowledge.checked;
    for (const button of card.pendingList.querySelectorAll("button")) button.disabled = disabled;
  }

  // Shows the stored lock. One whose time has come asks the background,
  // once, to apply what is due.
  function show(value) {
    const wasLocked = isLocked();
    lock = LOCK.normalizeLock(value);
    if (lock && LOCK.nextUpdate(lock) <= Date.now()) {
      if (!updateAsked) {
        updateAsked = true;
        void FrontFilter.askBackground({ action: "updateLock" }).catch((error) => {
          console.error("Could not update the settings lock:", error);
        });
      }
    } else {
      updateAsked = false;
    }
    // Without a lock, the fields offer a new one: a week, by default.
    if (!isLocked() && !confirming && (wasLocked || !card.until.value)) {
      card.until.value = toFieldValue(defaultUntil(Date.now()));
      showDelay(LOCK.DEFAULT_DELAY);
    }
    render();
  }

  // The warning says what the lock will do, and locks only once its box is
  // checked.
  function openConfirm() {
    const now = Date.now();
    const until = readUntil();
    const delay = readDelay();
    const problem = untilProblem(until, now);
    if (problem) {
      showToast(problem, "error");
      card.until.focus();
      return;
    }
    confirming = { until, delay };
    const duration = formatDuration(until - now);
    const waitsToEnd = delay === null || now + delay >= until;
    const wait = waitsToEnd ? "" : formatDuration(delay);
    card.confirmTitle.textContent = t("lockConfirmTitle", duration);
    const details = [
      t("lockConfirmUntil", formatTime(until)),
      t("lockConfirmStricter"),
      waitsToEnd ? t("lockConfirmLooserUntilEnd") : t("lockConfirmLooser", wait),
      waitsToEnd ? t("lockConfirmNoEarlyEnd") : t("lockConfirmEarlyEnd", wait),
      t("lockConfirmGrace", formatDuration(LOCK.GRACE_PERIOD)),
      t("lockConfirmFree"),
    ];
    card.confirmDetails.replaceChildren(...details.map((detail) => {
      const item = document.createElement("li");
      item.textContent = detail;
      return item;
    }));
    card.acknowledgeText.textContent = waitsToEnd
      ? t("lockAcknowledgeUntil", formatTime(until))
      : t("lockAcknowledgeWait", wait);
    card.acknowledge.checked = false;
    card.confirmButton.textContent = t("lockConfirmButton", duration);
    card.confirm.hidden = false;
    updateControls();
    card.confirmTitle.focus();
  }

  function closeConfirm({ moveFocus = true } = {}) {
    if (card.confirm.hidden) return;
    confirming = null;
    card.confirm.hidden = true;
    card.acknowledge.checked = false;
    if (moveFocus) card.start.focus();
  }

  async function startLock() {
    if (!confirming || !card.acknowledge.checked) return;
    const { until, delay } = confirming;
    // The warning may have stayed open past the end it shows.
    const problem = untilProblem(until, Date.now());
    if (problem) {
      showToast(problem, "error");
      closeConfirm();
      return;
    }
    try {
      const result = await ask({ action: "startLock", until, delay });
      lock = LOCK.normalizeLock(result?.lock) ?? lock;
      confirming = null;
      card.confirm.hidden = true;
      render();
      showToast(t("lockStarted", formatTime(until)), "success");
    } catch (error) {
      showToast(t("lockStartFailed", error.message), "error");
    }
    card.heading.focus();
  }

  // Saves the lock's end or delay through the lock itself.
  async function saveLock(settings, done) {
    try {
      const result = await ask({ action: "saveSettings", settings });
      if (!report(result)) done(result);
      return true;
    } catch (error) {
      showToast(t("lockChangeFailed", error.message), "error");
      return false;
    }
  }

  function startEditing() {
    editing = true;
    card.until.value = toFieldValue(lock.until);
    showDelay(lock.delay);
    render();
    card.until.focus();
  }

  function stopEditing() {
    editing = false;
    render();
    card.change.focus();
  }

  async function saveEdit() {
    const until = readUntil();
    const delay = readDelay();
    const now = Date.now();
    const problem = untilProblem(until, now);
    if (problem) {
      showToast(problem, "error");
      card.until.focus();
      return;
    }
    const settings = {};
    // The field holds minutes: an end it shows unchanged stays as it is.
    if (toFieldValue(until) !== toFieldValue(lock.until)) settings[LOCK.UNTIL] = until;
    if (delay !== lock.delay) settings[LOCK.DELAY] = delay;
    if (Object.keys(settings).length === 0) {
      stopEditing();
      return;
    }
    if (await saveLock(settings, () => showToast(t("lockChanged"), "success"))) stopEditing();
  }

  async function endLock() {
    await saveLock({ [LOCK.UNTIL]: 0 }, (result) => {
      if (!result?.locked) showToast(t("lockEnded"), "success");
    });
    card.heading.focus();
  }

  async function cancelRequest(id) {
    try {
      const result = await ask({ action: "cancelLockedChange", id });
      showToast(result?.cancelled ? t("lockChangeCancelled") : t("lockChangeAlreadyApplied"),
        result?.cancelled ? "success" : "info");
    } catch (error) {
      showToast(t("lockCancelFailed", error.message), "error");
    }
    card.heading.focus();
  }

  card.start.addEventListener("click", openConfirm);
  card.confirmCancel.addEventListener("click", () => closeConfirm());
  card.confirmButton.addEventListener("click", startLock);
  card.acknowledge.addEventListener("change", updateControls);
  // A warning about other values than the fields' would mislead.
  for (const field of [card.until, card.delay]) {
    field.addEventListener("change", () => closeConfirm({ moveFocus: false }));
  }
  // Escape cancels rather than closing the popup.
  card.confirm.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeConfirm();
  });
  card.change.addEventListener("click", startEditing);
  card.editCancel.addEventListener("click", stopEditing);
  card.save.addEventListener("click", saveEdit);
  card.end.addEventListener("click", endLock);
  card.bannerDetails.addEventListener("click", () => {
    showLockSection();
    card.heading.focus();
  });

  return {
    isLocked,
    savesThroughLock,
    report,
    show,
    setDisabled(value) {
      disabled = value;
      updateControls();
    },
  };
};
