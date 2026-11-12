/**
 * The settings lock: a commitment, until a date the user chooses, to keep
 * the settings at least as strict as they are. While it lasts, changes that
 * block or hide as much or more apply at once, and changes that loosen the
 * settings wait the delay chosen with the lock, or until it ends. The
 * lock's own end and delay change in the same way, so the lock cannot be
 * ended or softened at once either. Settings that block and hide nothing,
 * such as the theme, stay free.
 *
 * The background keeps the lock and, while one is on, writes the settings
 * the settings page asks it to (background/main.js). A one-click block's
 * undo, offered on Reddit for a few seconds, still writes directly: it only
 * takes back a click.
 *
 * The lock helps against impulses; it is no security boundary. A browser
 * lets its user remove FrontFilter, or edit its storage, at any time.
 */
FrontFilter.settingsLock = (() => {
  const STORAGE_KEY = "settingsLock";
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // How long a change that loosens the settings waits; null waits until
  // the lock ends.
  const DELAYS = Object.freeze([HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY, null]);
  const DEFAULT_DELAY = DAY;
  const MIN_DURATION = MINUTE;
  // A year at most: a mistyped year must not lock the settings for decades.
  const MAX_DURATION = 366 * DAY;
  // For this long, a change made while locked can be taken back at once,
  // so that a typo or a misclick costs no wait; so can a new lock.
  const GRACE_PERIOD = 10 * MINUTE;
  // The lock's own settings, which its changes name as they name settings.
  const UNTIL = "lockUntil";
  const DELAY = "lockDelay";
  const LOCK_SETTINGS = Object.freeze([UNTIL, DELAY]);
  // Stored with the settings an import or a restore writes, whose changes
  // that wait are described as theirs.
  const EXTRA_KEYS = Object.freeze([FrontFilter.IMPORT_BACKUP_KEY, FrontFilter.SETTINGS_VERSION_KEY]);
  const SOURCES = Object.freeze(["import", "restore"]);

  // Settings that change nothing FrontFilter blocks or hides, free while
  // locked: the redirect only chooses where blocked pages lead.
  const FREE_SETTINGS = Object.freeze([
    "theme",
    "pauseStatistics",
    "showBlockSubredditButton",
    "redirectBlockedPages",
    "redirectUrl",
  ]);
  const keywordRule = (keyword) => FrontFilter.getKeywordKey(keyword);
  const flairRule = (flair) => flair.toLowerCase();
  const nameRule = (name) => name;
  // Lists of rules that block or hide, each rule known by what its list
  // compares: removing one loosens them, and so does a subreddit rule that
  // goes from Everywhere to Front page.
  const RULE_LISTS = Object.freeze({
    blockedSubreddits: (entry) => entry.name,
    blockedUsers: nameRule,
    blockedTitleKeywords: keywordRule,
    blockedFlairs: flairRule,
  });
  // Lists of exceptions: adding one loosens them, whatever it matches.
  const EXCEPTION_LISTS = Object.freeze({
    allowedSubreddits: nameRule,
    allowedKeywords: keywordRule,
    allowedFlairs: flairRule,
  });
  // The limits' options matter only while their switch is on: then a
  // smaller number, or stopping at the limit, is stricter.
  const LIMIT_OPTIONS = Object.freeze({
    scrollLimit: Object.freeze({ switchKey: "limitInfiniteScroll" }),
    commentLimit: Object.freeze({ switchKey: "limitComments" }),
    scrollMode: Object.freeze({ switchKey: "limitInfiniteScroll", strict: "fixed" }),
    commentLimitMode: Object.freeze({ switchKey: "limitComments", strict: "fixed" }),
  });

  function getRuleOf(key) {
    if (Object.hasOwn(RULE_LISTS, key)) return RULE_LISTS[key];
    return Object.hasOwn(EXCEPTION_LISTS, key) ? EXCEPTION_LISTS[key] : null;
  }

  const isSettingKey = (key) => FrontFilter.STORAGE_KEYS.includes(key);
  const isTime = (value) => Number.isFinite(value) && value >= 0;
  const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const pick = (values, keys) => Object.fromEntries(keys
    .filter((key) => Object.hasOwn(values, key))
    .map((key) => [key, values[key]]));
  const delayRank = (delay) => (delay === null ? Infinity : delay);

  // Whether changing a setting, or one of a list's rules, from one value to
  // another loosens it. A rule is null where its list lacks it, and the
  // lock's end is 0, and its delay 0, where there is no lock. Limits'
  // options are read with the settings given.
  function loosens(key, from, to, settings) {
    if (FREE_SETTINGS.includes(key)) return false;
    if (Object.hasOwn(RULE_LISTS, key)) {
      return from !== null && (to === null || (from.mode === "all" && to.mode !== "all"));
    }
    if (Object.hasOwn(EXCEPTION_LISTS, key)) return from === null && to !== null;
    if (Object.hasOwn(LIMIT_OPTIONS, key)) {
      const { switchKey, strict } = LIMIT_OPTIONS[key];
      if (!settings[switchKey]) return false;
      return strict ? from === strict && to !== strict : to > from;
    }
    if (key === UNTIL) return to < from;
    if (key === DELAY) return delayRank(to) < delayRank(from);
    // Any other setting is a switch that blocks or hides while it is on.
    return from === true && to !== true;
  }

  // What a change, or a record of one, is about: a setting, or a rule.
  function targetOf({ key, rule }) {
    return rule === undefined ? key : `${key}\n${rule}`;
  }

  function isChange(change) {
    if (!change || typeof change !== "object") return false;
    if (LOCK_SETTINGS.includes(change.key)) return true;
    if (!isSettingKey(change.key)) return false;
    return getRuleOf(change.key) ? typeof change.rule === "string" : change.rule === undefined;
  }

  function isRequest(request) {
    return Boolean(request) && typeof request === "object"
      && Number.isSafeInteger(request.id) && isTime(request.at)
      && (request.due === null || isTime(request.due))
      && Array.isArray(request.changes) && request.changes.every(isChange);
  }

  function isRecord(record) {
    return isChange(record) && isTime(record.at) && Object.hasOwn(record, "before");
  }

  // The stored lock, or null when there is none. Each change that waits is
  // part of a request: what one save asked for, which applies, or is
  // cancelled, as a whole. Recent records keep, for the grace period, what
  // the changes made while locked replaced.
  function normalizeLock(value) {
    if (!value || typeof value !== "object" || !isTime(value.until)) return null;
    const pending = Array.isArray(value.pending) ? value.pending.filter(isRequest) : [];
    const ids = pending.map(({ id }) => id);
    return {
      until: value.until,
      delay: DELAYS.includes(value.delay) ? value.delay : DEFAULT_DELAY,
      lastId: Math.max(Number.isSafeInteger(value.lastId) ? value.lastId : 0, 0, ...ids),
      pending,
      recent: Array.isArray(value.recent) ? value.recent.filter(isRecord) : [],
    };
  }

  function readLock(stored) {
    return normalizeLock(stored?.[STORAGE_KEY]);
  }

  function isActive(lock, now) {
    return Boolean(lock) && lock.until > now;
  }

  // When a request applies: once its delay has passed, or the lock ended.
  function appliesAt(lock, request) {
    return request.due === null ? lock.until : Math.min(request.due, lock.until);
  }

  // When the lock next has something to do.
  function nextUpdate(lock) {
    return Math.min(lock.until, ...lock.pending.map((request) => appliesAt(lock, request)));
  }

  function findRecent(lock, target, now) {
    return lock.recent.find((record) =>
      targetOf(record) === target && now - record.at < GRACE_PERIOD);
  }

  function findPending(lock, target) {
    for (const request of lock.pending) {
      const change = request.changes.find((other) => targetOf(other) === target);
      if (change) return { request, change };
    }
    return null;
  }

  function removePending(lock, target) {
    for (const request of lock.pending) {
      request.changes = request.changes.filter((change) => targetOf(change) !== target);
    }
  }

  // Whether ending the lock now would apply at once, in its grace period,
  // or could wait for its delay before the lock ends by itself.
  function canEnd(lock, now) {
    if (!isActive(lock, now)) return false;
    const recent = findRecent(lock, UNTIL, now);
    if (recent && !loosens(UNTIL, recent.before, 0)) return true;
    return lock.delay !== null && now + lock.delay < lock.until;
  }

  // Applies a change to stored values, or to the lock, in place. A rule
  // that went meanwhile stays gone, and an exception is added once.
  function applyChange(values, lock, change) {
    const { key, value } = change;
    if (key === UNTIL) {
      if (isTime(value)) lock.until = value;
      return;
    }
    if (key === DELAY) {
      if (DELAYS.includes(value)) lock.delay = value;
      return;
    }
    const ruleOf = getRuleOf(key);
    if (!ruleOf) {
      values[key] = value;
      return;
    }
    const list = FrontFilter.coerceSettings(values)[key];
    const index = list.findIndex((entry) => ruleOf(entry) === change.rule);
    if (value === null) {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) {
      list[index] = value;
    } else if (Object.hasOwn(EXCEPTION_LISTS, key)) {
      list.push(value);
    }
    values[key] = FrontFilter.coerceSettings({ [key]: list })[key];
  }

  // Applies the requests that are due, in the order they were made, and
  // every request once the lock is over, which ends it. Returns the
  // settings to store and the lock, null once it has ended.
  function settle(stored, lock, now) {
    if (!lock) return { settings: {}, lock: null };
    const values = pick(stored, FrontFilter.STORAGE_KEYS);
    const written = new Set();
    const next = copy(lock);
    for (;;) {
      const over = next.until <= now;
      const due = next.pending.filter((request) => over || (request.due !== null && request.due <= now));
      if (due.length === 0) break;
      next.pending = next.pending.filter((request) => !due.includes(request));
      for (const request of due.sort((a, b) => a.at - b.at || a.id - b.id)) {
        for (const change of request.changes) {
          applyChange(values, next, change);
          if (!LOCK_SETTINGS.includes(change.key)) written.add(change.key);
        }
      }
    }
    const settings = pick(values, Array.from(written));
    return { settings, lock: next.until <= now ? null : next };
  }

  function checkUntil(until, now) {
    if (!isTime(until)) throw new RangeError("Choose when the lock ends");
    if (until - now > MAX_DURATION) throw new RangeError("A lock can last a year at most");
  }

  function checkDelay(delay) {
    if (!DELAYS.includes(delay)) throw new RangeError("Choose how long changes wait");
  }

  // Splits changes asked for while locked. Those that block or hide as
  // much or more apply at once, and so do those that only take back, in
  // the grace period, a change made while locked; the others wait. A
  // change to a setting or to a rule replaces what waits for it, but a
  // change that waits already keeps its time. Changes to the lock's own
  // end or delay that could only apply once it is over are refused.
  function split(stored, lock, changes, now, source) {
    const before = FrontFilter.coerceSettings(stored);
    const settingKeys = Object.keys(changes).filter(isSettingKey);
    const after = FrontFilter.coerceSettings({ ...stored, ...pick(changes, settingKeys) });
    const next = copy(lock);
    next.recent = next.recent.filter((record) => now - record.at < GRACE_PERIOD);
    const settings = {};
    const loosening = new Map();
    // What the save changed, and the settings it names: changes to them
    // replace what waits for them.
    const edited = new Set();

    // Returns whether a change applies now, and records it for the grace
    // period when it tightens.
    function decide(key, rule, from, to) {
      const target = targetOf({ key, rule });
      if (rule === undefined) edited.add(target);
      if (sameValue(from, to)) return true;
      edited.add(target);
      const ruleField = rule === undefined ? {} : { rule };
      if (!loosens(key, from, to, before)) {
        if (loosens(key, to, from, before) && !findRecent(next, target, now)) {
          next.recent.push({ key, ...ruleField, before: from, at: now });
        }
        return true;
      }
      const recent = findRecent(next, target, now);
      if (recent && !loosens(key, recent.before, to, before)) return true;
      // A removed rule is kept with its change, to describe it.
      loosening.set(target, { key, ...ruleField, value: to, ...(to === null && { entry: from }) });
      return false;
    }

    // The lock's own settings first: a longer delay applies to this save.
    if (Object.hasOwn(changes, UNTIL)) {
      checkUntil(changes[UNTIL], now);
      if (decide(UNTIL, undefined, next.until, changes[UNTIL])) next.until = changes[UNTIL];
    }
    if (Object.hasOwn(changes, DELAY)) {
      checkDelay(changes[DELAY]);
      if (decide(DELAY, undefined, next.delay, changes[DELAY])) next.delay = changes[DELAY];
    }

    for (const key of settingKeys) {
      const ruleOf = getRuleOf(key);
      if (!ruleOf) {
        if (decide(key, undefined, before[key], after[key])) settings[key] = after[key];
        continue;
      }
      const from = new Map(before[key].map((entry) => [ruleOf(entry), entry]));
      const to = new Map(after[key].map((entry) => [ruleOf(entry), entry]));
      const kept = new Map(to);
      for (const rule of new Set([...from.keys(), ...to.keys()])) {
        if (decide(key, rule, from.get(rule) ?? null, to.get(rule) ?? null)) continue;
        // Until its change applies, the rule stays as it was.
        if (from.has(rule)) kept.set(rule, from.get(rule));
        else kept.delete(rule);
      }
      settings[key] = FrontFilter.coerceSettings({ [key]: Array.from(kept.values()) })[key];
    }

    const due = next.delay === null ? null : now + next.delay;
    const waiting = [];
    const refused = [];
    const changesToWait = [];
    for (const target of edited) {
      const change = loosening.get(target);
      const existing = findPending(next, target);
      if (change && existing && sameValue(existing.change.value, change.value)) {
        waiting.push({ ...existing.change, due: appliesAt(next, existing.request) });
        continue;
      }
      if (change && LOCK_SETTINGS.includes(change.key) && (due === null || due >= next.until)) {
        refused.push(change);
        continue;
      }
      if (existing) removePending(next, target);
      if (change) changesToWait.push(change);
    }
    next.pending = next.pending.filter((request) => request.changes.length > 0);
    if (changesToWait.length > 0) {
      next.lastId += 1;
      const request = { id: next.lastId, at: now, due, changes: changesToWait };
      if (source) request.source = source;
      next.pending.push(request);
      const applies = appliesAt(next, request);
      waiting.push(...changesToWait.map((change) => ({ ...change, due: applies })));
    }
    return { settings, lock: next, waiting, refused };
  }

  // What an operation stores: the settings, and the lock when it changed,
  // or its removal once it has ended.
  function finish(stored, settings, lock, result) {
    const set = { ...settings };
    const previous = stored?.[STORAGE_KEY];
    if (lock && !sameValue(lock, previous)) set[STORAGE_KEY] = lock;
    const remove = !lock && previous !== undefined ? [STORAGE_KEY] : [];
    return { set, remove, lock, result };
  }

  // The operations the background runs, one at a time, on the stored
  // settings and lock. Each returns what to store, and its answer.

  // Locks the settings, until a time and with a delay. For the grace
  // period, the lock can be ended at once.
  function start(stored, { until, delay } = {}, now) {
    const settled = settle(stored, readLock(stored), now);
    if (isActive(settled.lock, now)) throw new Error("Settings are already locked");
    checkUntil(until, now);
    if (until - now < MIN_DURATION) throw new RangeError("Choose a time in the future");
    checkDelay(delay);
    const lock = {
      until,
      delay,
      lastId: 0,
      pending: [],
      recent: [{ key: UNTIL, before: 0, at: now }, { key: DELAY, before: 0, at: now }],
    };
    return finish(stored, settled.settings, lock, { lock });
  }

  // Saves settings, and the lock's end or delay, as the lock allows: what
  // waits is answered, with when it applies. Without a lock, the settings
  // are saved as they are. Extra values, such as an import's backup, are
  // stored with them.
  function save(stored, { settings: changes = {}, extra = {}, source } = {}, now) {
    const settled = settle(stored, readLock(stored), now);
    const values = { ...stored, ...settled.settings };
    const extras = pick(extra ?? {}, EXTRA_KEYS);
    const requested = changes && typeof changes === "object" ? changes : {};
    if (!isActive(settled.lock, now)) {
      const keys = Object.keys(requested).filter(isSettingKey);
      const coerced = FrontFilter.coerceSettings({ ...values, ...pick(requested, keys) });
      const settings = { ...settled.settings, ...pick(coerced, keys), ...extras };
      return finish(stored, settings, settled.lock, { locked: false, waiting: [], refused: [] });
    }
    const result = split(values, settled.lock, requested, now, SOURCES.includes(source) ? source : "");
    // A lock ended in its grace period applies what waited.
    const after = settle({ ...values, ...result.settings }, result.lock, now);
    const settings = { ...settled.settings, ...result.settings, ...after.settings, ...extras };
    return finish(stored, settings, after.lock, {
      locked: Boolean(after.lock),
      waiting: result.waiting,
      refused: result.refused,
    });
  }

  // Cancels a request that waits, which tightens and so applies at once.
  function cancel(stored, { id } = {}, now) {
    const lock = readLock(stored);
    if (!lock) return finish(stored, {}, null, { cancelled: false });
    const pending = lock.pending.filter((request) => request.id !== id);
    const settled = settle(stored, { ...lock, pending }, now);
    return finish(stored, settled.settings, settled.lock, {
      cancelled: pending.length < lock.pending.length,
    });
  }

  // Applies what is due, and ends the lock once it is over.
  function update(stored, _message, now) {
    const settled = settle(stored, readLock(stored), now);
    return finish(stored, settled.settings, settled.lock, {});
  }

  return Object.freeze({
    STORAGE_KEY,
    UNTIL,
    DELAY,
    DELAYS,
    DEFAULT_DELAY,
    MIN_DURATION,
    MAX_DURATION,
    GRACE_PERIOD,
    FREE_SETTINGS,
    appliesAt,
    canEnd,
    isActive,
    loosens,
    nextUpdate,
    normalizeLock,
    readLock,
    start,
    save,
    cancel,
    update,
  });
})();
