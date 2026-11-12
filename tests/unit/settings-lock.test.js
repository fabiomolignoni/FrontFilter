const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { runScripts } = require("./helpers");

function loadLock() {
  const context = vm.createContext({ URL, URLSearchParams });
  runScripts(context, ["shared/core.js", "shared/settings-lock.js"]);
  return context.FrontFilter.settingsLock;
}

const LOCK = loadLock();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 12, 10);
const plain = (value) => JSON.parse(JSON.stringify(value));

// A lock that has run past its grace period, with what waits in it.
function lockedSince(settings = {}, { until = NOW + 7 * DAY, delay = DAY, pending = [] } = {}) {
  return {
    ...settings,
    settingsLock: { until, delay, lastId: pending.length, pending, recent: [] },
  };
}

// Stores what an operation returns, as the background does.
function apply(stored, operation) {
  const next = { ...stored, ...plain(operation.set) };
  for (const key of operation.remove) delete next[key];
  return next;
}

// Saves changes through the lock and returns the stored values with its answer.
function save(stored, settings, now = NOW, options = {}) {
  const operation = LOCK.save(stored, { settings, ...options }, now);
  return { stored: apply(stored, operation), result: plain(operation.result), set: plain(operation.set) };
}

function waitingChanges(stored) {
  return plain(stored.settingsLock.pending.flatMap(({ changes }) => changes));
}

test("applies changes that block or hide more at once, and keeps loosening ones waiting", () => {
  const before = lockedSince({ hideNsfw: true, hideSpoilers: false });
  const { stored, result } = save(before, { hideSpoilers: true, hideNsfw: false });

  assert.equal(stored.hideSpoilers, true);
  assert.equal(stored.hideNsfw, true);
  assert.deepEqual(waitingChanges(stored), [{ key: "hideNsfw", value: false }]);
  assert.deepEqual(result.waiting, [{ key: "hideNsfw", value: false, due: NOW + DAY }]);
  assert.deepEqual(result.refused, []);
  assert.equal(result.locked, true);
});

test("leaves the settings no impulse would loosen free", () => {
  const free = {
    hideAds: true,
    hideAwards: true,
    hideAvatars: true,
    hideUsernames: true,
    hideLeftSidebarResources: true,
    showBlockSubredditButton: true,
    hideBlockPageSettingsButton: true,
    redirectBlockedPages: true,
    pauseStatistics: true,
  };
  const before = lockedSince({ ...free, redirectUrl: "https://example.com/", theme: "dark" });
  const loosened = {
    ...Object.fromEntries(Object.keys(free).map((key) => [key, false])),
    redirectUrl: "",
    theme: "light",
  };
  const { stored, result } = save(before, loosened);
  for (const [key, value] of Object.entries(loosened)) assert.equal(stored[key], value, key);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(plain(LOCK.FREE_SETTINGS).sort(), Object.keys(loosened).sort());

  // Votes and karma, social rewards, stay locked with the other sections.
  const social = lockedSince({ hideVotes: true, hideKarma: true, hideAvatars: true });
  const { result: socialResult } = save(social, { hideVotes: false, hideKarma: false, hideAvatars: false });
  assert.deepEqual(socialResult.waiting.map(({ key }) => key), ["hideVotes", "hideKarma"]);
});

test("applies a free section at once while its locked switch waits", () => {
  const before = lockedSince({ hideSocialSignals: true });
  const sections = {
    hideVotes: false, hideKarma: false, hideAwards: false, hideAvatars: false, hideUsernames: false,
  };
  const { stored } = save(before, { hideSocialSignals: false, ...sections });
  // The switch still hides every section until its change applies.
  assert.equal(stored.hideSocialSignals, true);
  assert.equal(stored.hideAvatars, false);
  assert.deepEqual(waitingChanges(stored).map(({ key }) => key), ["hideSocialSignals", "hideVotes", "hideKarma"]);
});

test("adds rules at once, and keeps removed rules until their removal applies", () => {
  const before = lockedSince({
    blockedSubreddits: [{ name: "*", mode: "all" }, { name: "news", mode: "all" }],
    blockedTitleKeywords: ["election"],
    blockedUsers: ["spez"],
  });
  const { stored, result } = save(before, {
    // news is edited into worldnews: the new rule applies, news stays.
    blockedSubreddits: [{ name: "*", mode: "all" }, { name: "worldnews", mode: "all" }],
    blockedTitleKeywords: ["Election", "ai"],
    blockedUsers: [],
  });

  assert.deepEqual(plain(stored.blockedSubreddits), [
    { name: "*", mode: "all" }, { name: "worldnews", mode: "all" }, { name: "news", mode: "all" },
  ]);
  // A keyword spelt otherwise is the same rule.
  assert.deepEqual(plain(stored.blockedTitleKeywords), ["Election", "ai"]);
  assert.deepEqual(plain(stored.blockedUsers), ["spez"]);
  assert.deepEqual(result.waiting.map(({ key, rule, value }) => [key, rule, value]), [
    ["blockedSubreddits", "news", null],
    ["blockedUsers", "spez", null],
  ]);
  // A removed rule is kept with its change, which names it.
  assert.deepEqual(waitingChanges(stored)[0].entry, { name: "news", mode: "all" });
});

test("treats Everywhere as stricter than Front page", () => {
  const before = lockedSince({
    blockedSubreddits: [{ name: "news", mode: "all" }, { name: "pics", mode: "home" }],
  });
  const { stored, result } = save(before, {
    blockedSubreddits: [{ name: "news", mode: "home" }, { name: "pics", mode: "all" }],
  });
  assert.deepEqual(plain(stored.blockedSubreddits), [
    { name: "news", mode: "all" }, { name: "pics", mode: "all" },
  ]);
  assert.deepEqual(result.waiting.map(({ rule, value }) => [rule, value]), [
    ["news", { name: "news", mode: "home" }],
  ]);
});

test("keeps added exceptions waiting, whatever they match, and removes exceptions at once", () => {
  const before = lockedSince({
    blockedSubreddits: [{ name: "*", mode: "all" }],
    allowedSubreddits: ["askscience"],
    allowedKeywords: ["ai art"],
    allowedFlairs: [],
  });
  const { stored, result } = save(before, {
    allowedSubreddits: ["askreddit"],
    allowedKeywords: ["ai art", "spoiler-free"],
    allowedFlairs: ["Discussion"],
  });
  assert.deepEqual(plain(stored.allowedSubreddits), []);
  assert.deepEqual(plain(stored.allowedKeywords), ["ai art"]);
  assert.deepEqual(plain(stored.allowedFlairs), []);
  assert.deepEqual(result.waiting.map(({ key, value }) => [key, value]), [
    ["allowedSubreddits", "askreddit"],
    ["allowedKeywords", "spoiler-free"],
    ["allowedFlairs", "Discussion"],
  ]);
  // The three wait together, as one request.
  assert.equal(stored.settingsLock.pending.length, 1);
});

test("locks the limits' options only while their switch is on", () => {
  const on = lockedSince({ limitInfiniteScroll: true, scrollLimit: 25, scrollMode: "fixed" });
  let { stored, result } = save(on, { scrollLimit: 50, scrollMode: "button" });
  assert.equal(stored.scrollLimit, 25);
  assert.equal(stored.scrollMode, "fixed");
  assert.deepEqual(result.waiting.map(({ key, value }) => [key, value]), [
    ["scrollLimit", 50], ["scrollMode", "button"],
  ]);

  ({ stored } = save(on, { scrollLimit: 10 }));
  assert.equal(stored.scrollLimit, 10);

  const off = lockedSince({ limitComments: false, commentLimit: 10 });
  ({ stored, result } = save(off, { commentLimit: 40, commentLimitMode: "button" }));
  assert.equal(stored.commentLimit, 40);
  assert.equal(stored.commentLimitMode, "button");
  assert.deepEqual(result.waiting, []);
});

test("keeps a switch and its sections waiting together", () => {
  const before = lockedSince({ hideNavbar: true });
  const sections = Object.fromEntries(
    ["hideNavbarMenu", "hideNavbarSearch", "hideNavbarChat", "hideNavbarNotifications",
      "hideNavbarProfile", "hideNavbarOthers"].map((key) => [key, false]),
  );
  const { stored } = save(before, { hideNavbar: false, ...sections });
  assert.equal(stored.hideNavbar, true);
  assert.equal(stored.settingsLock.pending.length, 1);
  assert.deepEqual(waitingChanges(stored).map(({ key }) => key), ["hideNavbar", ...Object.keys(sections)]);
});

test("lets a change made while locked be taken back at once, in the grace period only", () => {
  const before = lockedSince({ hideSuggestedPosts: false, blockedSubreddits: [] });
  let { stored } = save(before, {
    hideSuggestedPosts: true,
    blockedSubreddits: [{ name: "fnuny", mode: "all" }],
  });
  assert.equal(stored.hideSuggestedPosts, true);

  // A misclick and a typo, fixed at once.
  let result;
  ({ stored, result } = save(stored, {
    hideSuggestedPosts: false,
    blockedSubreddits: [{ name: "funny", mode: "all" }],
  }, NOW + 5 * MINUTE));
  assert.equal(stored.hideSuggestedPosts, false);
  assert.deepEqual(plain(stored.blockedSubreddits), [{ name: "funny", mode: "all" }]);
  assert.deepEqual(result.waiting, []);

  // After the grace period, taking funny back waits.
  ({ stored, result } = save(stored, { blockedSubreddits: [] }, NOW + 20 * MINUTE));
  assert.deepEqual(plain(stored.blockedSubreddits), [{ name: "funny", mode: "all" }]);
  assert.equal(result.waiting.length, 1);
});

test("measures a change in the grace period against the settings before it", () => {
  const before = lockedSince({ limitInfiniteScroll: true, scrollLimit: 25 });
  let { stored } = save(before, { scrollLimit: 10 });
  let result;
  // Back up to 20 is still stricter than 25.
  ({ stored, result } = save(stored, { scrollLimit: 20 }, NOW + MINUTE));
  assert.equal(stored.scrollLimit, 20);
  ({ stored, result } = save(stored, { scrollLimit: 30 }, NOW + 2 * MINUTE));
  assert.equal(stored.scrollLimit, 20);
  assert.deepEqual(result.waiting.map(({ value }) => value), [30]);
});

test("replaces what waits for a setting with its latest change, and keeps a repeated one's time", () => {
  const before = lockedSince({ limitInfiniteScroll: true, scrollLimit: 25, hideNsfw: true });
  let { stored } = save(before, { scrollLimit: 50, hideNsfw: false });
  let result;

  // The same change again waits as it did.
  ({ stored, result } = save(stored, { hideNsfw: false }, NOW + HOUR));
  assert.deepEqual(result.waiting, [{ key: "hideNsfw", value: false, due: NOW + DAY }]);
  assert.equal(stored.settingsLock.pending.length, 1);

  // Another value replaces it, and waits from now.
  ({ stored, result } = save(stored, { scrollLimit: 40 }, NOW + HOUR));
  assert.deepEqual(waitingChanges(stored), [
    { key: "hideNsfw", value: false }, { key: "scrollLimit", value: 40 },
  ]);
  assert.deepEqual(result.waiting, [{ key: "scrollLimit", value: 40, due: NOW + HOUR + DAY }]);

  // A stricter value replaces it too, and applies.
  ({ stored } = save(stored, { scrollLimit: 10 }, NOW + 2 * HOUR));
  assert.equal(stored.scrollLimit, 10);
  assert.deepEqual(waitingChanges(stored), [{ key: "hideNsfw", value: false }]);
});

test("cancels what waits for a rule only when the rule itself changes", () => {
  const before = lockedSince({
    blockedSubreddits: [{ name: "news", mode: "home" }, { name: "pics", mode: "all" }],
  });
  // pics is removed: its removal waits.
  let { stored } = save(before, { blockedSubreddits: [{ name: "news", mode: "home" }] });
  assert.equal(waitingChanges(stored).length, 1);

  // The page saves the list as it shows it, pics included: still waiting.
  ({ stored } = save(stored, {
    blockedSubreddits: [{ name: "news", mode: "home" }, { name: "pics", mode: "all" }, { name: "tv", mode: "all" }],
  }, NOW + MINUTE));
  assert.equal(waitingChanges(stored).length, 1);

  // Changing news changes nothing for pics either.
  ({ stored } = save(stored, {
    blockedSubreddits: [{ name: "news", mode: "all" }, { name: "pics", mode: "all" }, { name: "tv", mode: "all" }],
  }, NOW + 2 * MINUTE));
  assert.deepEqual(waitingChanges(stored).map(({ rule }) => rule), ["pics"]);
});

test("applies what is due in order, then everything once the lock ends, which removes it", () => {
  let stored = lockedSince({ hideNsfw: true, blockedSubreddits: [{ name: "news", mode: "all" }] });
  ({ stored } = save(stored, { hideNsfw: false }));
  ({ stored } = save(stored, { blockedSubreddits: [] }, NOW + HOUR));

  stored = apply(stored, LOCK.update(stored, {}, NOW + DAY));
  assert.equal(stored.hideNsfw, false);
  assert.deepEqual(plain(stored.blockedSubreddits), [{ name: "news", mode: "all" }]);
  assert.equal(LOCK.nextUpdate(LOCK.normalizeLock(stored.settingsLock)), NOW + HOUR + DAY);
  stored = apply(stored, LOCK.update(stored, {}, NOW + HOUR + DAY));
  assert.deepEqual(plain(stored.blockedSubreddits), []);

  // A day from then is after the lock: the exception applies as it ends.
  let result;
  ({ stored, result } = save(stored, { allowedSubreddits: ["askreddit"] }, NOW + 6 * DAY + 12 * HOUR));
  assert.equal(result.waiting[0].due, NOW + 7 * DAY);
  stored = apply(stored, LOCK.update(stored, {}, NOW + 7 * DAY - 1));
  assert.deepEqual(plain(stored.allowedSubreddits), []);
  const update = LOCK.update(stored, {}, NOW + 7 * DAY);
  assert.deepEqual(plain(update.remove), ["settingsLock"]);
  stored = apply(stored, update);
  assert.deepEqual(plain(stored.allowedSubreddits), ["askreddit"]);
  assert.equal(stored.settingsLock, undefined);
});

test("writes nothing when nothing is due", () => {
  const stored = lockedSince({}, { pending: [] });
  const update = LOCK.update(stored, {}, NOW + HOUR);
  assert.deepEqual(plain(update.set), {});
  assert.deepEqual(plain(update.remove), []);
  assert.deepEqual(plain(LOCK.update({ hideAds: true }, {}, NOW)), {
    set: {}, remove: [], lock: null, result: {},
  });
});

test("keeps a rule gone meanwhile gone, and adds an exception once", () => {
  let stored = lockedSince({
    blockedSubreddits: [{ name: "news", mode: "all" }],
    allowedSubreddits: [],
  });
  ({ stored } = save(stored, {
    blockedSubreddits: [{ name: "news", mode: "home" }],
    allowedSubreddits: ["askreddit"],
  }));
  // A one-click block's undo removes news, and the exception is added too.
  stored = { ...stored, blockedSubreddits: [], allowedSubreddits: ["askreddit"] };
  stored = apply(stored, LOCK.update(stored, {}, NOW + DAY));
  assert.deepEqual(plain(stored.blockedSubreddits), []);
  assert.deepEqual(plain(stored.allowedSubreddits), ["askreddit"]);
});

test("locks the settings for a time and a delay that can be used", () => {
  const started = LOCK.start({}, { until: NOW + 7 * DAY, delay: null }, NOW);
  assert.deepEqual(plain(started.set.settingsLock), {
    until: NOW + 7 * DAY,
    delay: null,
    lastId: 0,
    pending: [],
    recent: [{ key: "lockUntil", before: 0, at: NOW }, { key: "lockDelay", before: 0, at: NOW }],
  });
  assert.equal(LOCK.isActive(LOCK.normalizeLock(started.set.settingsLock), NOW), true);
  // However far away the end is.
  const far = LOCK.start({}, { until: NOW + 10 * 366 * DAY, delay: DAY }, NOW);
  assert.equal(far.set.settingsLock.until, NOW + 10 * 366 * DAY);

  const refusals = [
    [{ until: NOW + 30 * 1000, delay: DAY }, /in the future/],
    [{ until: "tomorrow", delay: DAY }, /when the lock ends/],
    [{ until: NOW + DAY, delay: 5 * MINUTE }, /how long changes wait/],
  ];
  for (const [message, error] of refusals) {
    assert.throws(() => LOCK.start({}, message, NOW), error);
  }
  assert.throws(() => LOCK.start(apply({}, started), { until: NOW + DAY, delay: DAY }, NOW),
    /already locked/);
  // Once a lock has ended, another can start.
  assert.doesNotThrow(() => LOCK.start(apply({}, started), { until: NOW + 9 * DAY, delay: DAY }, NOW + 8 * DAY));
  assert.deepEqual(plain(LOCK.DELAYS), [HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY, null]);
});

test("ends a new lock at once in its grace period, and later only after its delay", () => {
  let stored = apply({ hideNsfw: true }, LOCK.start({ hideNsfw: true }, { until: NOW + 7 * DAY, delay: DAY }, NOW));
  assert.equal(LOCK.canEnd(LOCK.normalizeLock(stored.settingsLock), NOW + 5 * MINUTE), true);
  const ended = save(stored, { lockUntil: 0 }, NOW + 5 * MINUTE);
  assert.equal(ended.stored.settingsLock, undefined);
  assert.equal(ended.result.locked, false);

  const later = save(stored, { lockUntil: 0 }, NOW + HOUR);
  assert.equal(later.stored.settingsLock.until, NOW + 7 * DAY);
  assert.deepEqual(later.result.waiting, [{ key: "lockUntil", value: 0, due: NOW + HOUR + DAY }]);
  // Once that applies, the lock ends, and what waited applies with it.
  stored = save(later.stored, { hideNsfw: false }, NOW + 2 * HOUR).stored;
  stored = apply(stored, LOCK.update(stored, {}, NOW + HOUR + DAY));
  assert.equal(stored.settingsLock, undefined);
  assert.equal(stored.hideNsfw, false);
});

test("extends a lock at once, and shortens or softens it only after its delay", () => {
  const before = lockedSince({}, { until: NOW + 7 * DAY, delay: DAY });
  let { stored, result } = save(before, { lockUntil: NOW + 14 * DAY, lockDelay: 3 * DAY });
  assert.equal(stored.settingsLock.until, NOW + 14 * DAY);
  assert.equal(stored.settingsLock.delay, 3 * DAY);
  assert.deepEqual(result.waiting, []);

  // A longer delay applies to changes asked for after it.
  ({ stored, result } = save(stored, { lockUntil: NOW + 10 * DAY, lockDelay: HOUR }, NOW + 20 * MINUTE));
  assert.equal(stored.settingsLock.until, NOW + 14 * DAY);
  assert.deepEqual(result.waiting.map(({ key, due }) => [key, due]), [
    ["lockUntil", NOW + 20 * MINUTE + 3 * DAY], ["lockDelay", NOW + 20 * MINUTE + 3 * DAY],
  ]);
  // However far.
  ({ stored } = save(stored, { lockUntil: NOW + 10 * 366 * DAY }, NOW + 30 * MINUTE));
  assert.equal(stored.settingsLock.until, NOW + 10 * 366 * DAY);
  assert.deepEqual(waitingChanges(stored).map(({ key }) => key), ["lockDelay"]);
});

test("refuses to end or soften a lock when that could only apply once it is over", () => {
  // Changes wait until the lock ends.
  const strict = lockedSince({}, { delay: null });
  let { stored, result } = save(strict, { lockUntil: 0, lockDelay: HOUR });
  assert.deepEqual(result.refused.map(({ key }) => key), ["lockUntil", "lockDelay"]);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(stored.settingsLock.pending, []);
  assert.equal(LOCK.canEnd(LOCK.normalizeLock(strict.settingsLock), NOW), false);

  // A delay that ends after the lock does.
  const ending = lockedSince({}, { until: NOW + 12 * HOUR, delay: DAY });
  ({ result } = save(ending, { lockUntil: 0 }));
  assert.equal(result.refused.length, 1);
  assert.equal(LOCK.canEnd(LOCK.normalizeLock(ending.settingsLock), NOW), false);

  // Settings still wait until the end of such a lock.
  ({ result } = save(lockedSince({ hideNsfw: true }, { delay: null }), { hideNsfw: false }));
  assert.deepEqual(result.waiting, [{ key: "hideNsfw", value: false, due: NOW + 7 * DAY }]);
});

test("cancels a request, which tightens and so applies at once", () => {
  let stored = lockedSince({ hideNsfw: true, hideComments: true });
  ({ stored } = save(stored, { hideNsfw: false }));
  ({ stored } = save(stored, { hideComments: false }, NOW + MINUTE));
  const [first] = stored.settingsLock.pending;
  const cancelled = LOCK.cancel(stored, { id: first.id }, NOW + 2 * MINUTE);
  assert.deepEqual(plain(cancelled.result), { cancelled: true });
  stored = apply(stored, cancelled);
  assert.deepEqual(waitingChanges(stored), [{ key: "hideComments", value: false }]);
  assert.deepEqual(plain(LOCK.cancel(stored, { id: first.id }, NOW).result), { cancelled: false });
  // Ids are not used again.
  ({ stored } = save(stored, { hideNsfw: false }, NOW + 3 * MINUTE));
  assert.deepEqual(stored.settingsLock.pending.map(({ id }) => id), [2, 3]);
});

test("saves settings as they are without a lock, with only the extra values it knows", () => {
  const { set, result } = save({ hideNsfw: true }, { hideNsfw: false, lockUntil: 0, unknown: 1 }, NOW, {
    extra: { importBackup: { settings: {} }, settingsVersion: 2, settingsLock: { until: 1 } },
  });
  assert.deepEqual(set, { hideNsfw: false, importBackup: { settings: {} }, settingsVersion: 2 });
  assert.deepEqual(result, { locked: false, waiting: [], refused: [] });
});

test("names an import's or a restore's changes as theirs", () => {
  const before = lockedSince({ hideNsfw: true, blockedUsers: ["spez"] });
  const { stored } = save(before, { hideNsfw: false, blockedUsers: [] }, NOW, {
    source: "import",
    extra: { settingsVersion: 2 },
  });
  assert.equal(stored.settingsLock.pending[0].source, "import");
  assert.equal(stored.settingsVersion, 2);
  const other = save(before, { hideNsfw: false }, NOW, { source: "elsewhere" }).stored;
  assert.equal("source" in other.settingsLock.pending[0], false);
});

test("reads only locks it can use", () => {
  assert.equal(LOCK.normalizeLock(undefined), null);
  assert.equal(LOCK.normalizeLock({ until: "soon" }), null);
  assert.deepEqual(plain(LOCK.normalizeLock({
    until: NOW,
    delay: 12345,
    pending: [
      { id: 4, at: NOW, due: null, changes: [{ key: "hideNsfw", value: false }] },
      { id: 5, at: NOW, due: NOW, changes: [{ key: "notASetting", value: false }] },
      { id: 6, at: NOW, due: NOW, changes: [{ key: "blockedUsers", value: null }] },
    ],
    recent: [{ key: "hideAds", at: NOW }],
  })), {
    until: NOW,
    delay: DAY,
    lastId: 4,
    pending: [{ id: 4, at: NOW, due: null, changes: [{ key: "hideNsfw", value: false }] }],
    recent: [],
  });
});

test("applies what waited before a save made once the lock is over, which then wins", () => {
  let stored = lockedSince({ hideNsfw: true, hideSpoilers: true });
  ({ stored } = save(stored, { hideNsfw: false, hideSpoilers: false }));
  // The lock ended a moment ago, and its alarm has not rung yet.
  const { stored: after, result } = save(stored, { hideNsfw: true }, NOW + 7 * DAY + 1000);
  assert.equal(after.settingsLock, undefined);
  assert.equal(after.hideNsfw, true);
  assert.equal(after.hideSpoilers, false);
  assert.equal(result.locked, false);
});
