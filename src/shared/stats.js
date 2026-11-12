/**
 * FrontFilter's statistics: how long Reddit is used each day, in how many
 * visits, which pages FrontFilter blocked, and how many posts and comments
 * its filters hid, and why. They are kept on the device only, under a key
 * of their own: they are not settings, so exports never include them. The
 * background script is their only writer (background/main.js); pages send
 * it records, which it adds here.
 */
FrontFilter.stats = (() => {
  const STORAGE_KEY = "stats";
  // Daily figures are kept this long; totals since counting began stay.
  const DAYS_KEPT = 30;
  // A visit ends after this long without time on Reddit.
  const VISIT_GAP = 10 * 60 * 1000;
  // Pages send their time at least every minute, so a longer record is not
  // one of theirs.
  const MAX_RECORD_TIME = 15 * 60 * 1000;
  const MAX_RECORD_COUNT = 10000;
  // Blocked pages are counted by what they belong to; past this many in a
  // day, others count together.
  const MAX_DAILY_TARGETS = 100;
  const OTHER_TARGET = "other";
  // Why posts and comments were hidden. When several filters hide one, the
  // first of these counts it: your own rules, then whole kinds of posts.
  const POST_REASONS = Object.freeze([
    "subreddits", "users", "keywords", "flairs", "nsfw", "spoilers", "suggested", "ads",
  ]);
  const COMMENT_REASONS = Object.freeze(["users", "keywords"]);
  const REASON_LABELS = Object.freeze({
    subreddits: "Subreddits",
    users: "Users",
    keywords: "Keywords",
    flairs: "Flairs",
    nsfw: "NSFW",
    spoilers: "Spoilers",
    suggested: "Suggested posts",
    ads: "Ads",
  });
  const PAGE_LABELS = Object.freeze({
    homepage: "Homepage",
    popular: "Popular",
    explore: "Explore",
    news: "News",
    subhome: "Subreddit front pages",
  });
  const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const TARGET_PATTERN = new RegExp(`^(?:page:(?:${Object.keys(PAGE_LABELS).join("|")})`
    + `|subreddit:[a-z0-9_]{1,50}|user:[a-z0-9_-]{1,20}|${OTHER_TARGET})$`);

  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const sum = (values) => values.reduce((total, value) => total + value, 0);

  // Days are local calendar days, as YYYY-MM-DD, which sort as text.
  function dayKey(time) {
    const date = new Date(time);
    return [
      String(date.getFullYear()).padStart(4, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function dayDate(key) {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  // Calendar arithmetic, so that days stay whole across daylight saving.
  function shiftDay(key, offset) {
    const date = dayDate(key);
    date.setDate(date.getDate() + offset);
    return dayKey(date.getTime());
  }

  // Counts by name, keeping the names allowed.
  function normalizeCounts(value, isAllowed, max = Infinity) {
    const counts = {};
    if (!isObject(value)) return counts;
    for (const [name, amount] of Object.entries(value)) {
      const number = Math.min(count(amount), max);
      if (number > 0 && isAllowed(name)) counts[name] = number;
    }
    return counts;
  }

  const isPostReason = (name) => POST_REASONS.includes(name);
  const isCommentReason = (name) => COMMENT_REASONS.includes(name);
  const isTarget = (name) => TARGET_PATTERN.test(name);

  function normalizeDay(value) {
    const day = isObject(value) ? value : {};
    return {
      time: count(day.time),
      visits: count(day.visits),
      blocked: normalizeCounts(day.blocked, isTarget),
      posts: normalizeCounts(day.posts, isPostReason),
      comments: normalizeCounts(day.comments, isCommentReason),
    };
  }

  function emptyTotals() {
    return { time: 0, visits: 0, blocked: 0, posts: 0, comments: 0 };
  }

  // Stored statistics as this version reads them: anything else, such as
  // values from a later version, is left out.
  function normalizeStats(value) {
    const stored = isObject(value) ? value : {};
    const totals = isObject(stored.totals) ? stored.totals : {};
    const days = {};
    if (isObject(stored.days)) {
      for (const [key, day] of Object.entries(stored.days)) {
        if (DAY_KEY_PATTERN.test(key)) days[key] = normalizeDay(day);
      }
    }
    return {
      since: count(stored.since),
      lastActiveAt: count(stored.lastActiveAt),
      totals: Object.fromEntries(Object.keys(emptyTotals()).map((key) => [key, count(totals[key])])),
      days,
    };
  }

  // A record a page sends: time on Reddit, and counts of hidden posts and
  // comments by reason and of blocked pages by what they belong to.
  function normalizeRecord(value) {
    const record = isObject(value) ? value : {};
    return {
      time: Math.min(count(record.time), MAX_RECORD_TIME),
      posts: normalizeCounts(record.posts, isPostReason, MAX_RECORD_COUNT),
      comments: normalizeCounts(record.comments, isCommentReason, MAX_RECORD_COUNT),
      blocked: normalizeCounts(record.blocked, isTarget, MAX_RECORD_COUNT),
    };
  }

  function isEmptyRecord(record) {
    const { time, posts, comments, blocked } = normalizeRecord(record);
    return time === 0 && [posts, comments, blocked].every((counts) => Object.keys(counts).length === 0);
  }

  function addCounts(target, counts) {
    for (const [name, amount] of Object.entries(counts)) target[name] = (target[name] || 0) + amount;
    return sum(Object.values(counts));
  }

  // The statistics with a record added at the given time. Time starts a
  // new visit when Reddit was not used for a while before it.
  function addRecord(stored, value, now = Date.now()) {
    const stats = normalizeStats(stored);
    const record = normalizeRecord(value);
    if (isEmptyRecord(record)) return stats;

    if (!stats.since) stats.since = now;
    const key = dayKey(now);
    const day = stats.days[key] ?? (stats.days[key] = normalizeDay());

    if (record.time > 0) {
      if (now - record.time - stats.lastActiveAt > VISIT_GAP) {
        day.visits += 1;
        stats.totals.visits += 1;
      }
      stats.lastActiveAt = Math.max(stats.lastActiveAt, now);
      day.time += record.time;
      stats.totals.time += record.time;
    }
    stats.totals.posts += addCounts(day.posts, record.posts);
    stats.totals.comments += addCounts(day.comments, record.comments);
    for (const [target, amount] of Object.entries(record.blocked)) {
      const known = Object.hasOwn(day.blocked, target)
        || Object.keys(day.blocked).length < MAX_DAILY_TARGETS;
      const name = known ? target : OTHER_TARGET;
      day.blocked[name] = (day.blocked[name] || 0) + amount;
      stats.totals.blocked += amount;
    }

    const oldest = shiftDay(key, 1 - DAYS_KEPT);
    for (const dayKeyStored of Object.keys(stats.days)) {
      if (dayKeyStored < oldest) delete stats.days[dayKeyStored];
    }
    return stats;
  }

  // What a blocked page belongs to: a main page, a subreddit or a user. A
  // subreddit's front page, blocked with every other, counts as that
  // subreddit when its address names it.
  function blockedTarget(route, pathname = "") {
    if (route?.type === "user") {
      const user = FrontFilter.normalizeUserName(route.user);
      return user ? `user:${user}` : OTHER_TARGET;
    }
    const pathSubreddit = FrontFilter.getSubredditPath(pathname)?.name || "";
    if (route?.type === "subreddit" || route?.page === "subhome") {
      const subreddit = FrontFilter.normalizeExactSubredditName(route.subreddit || pathSubreddit);
      if (subreddit) return `subreddit:${subreddit}`;
    }
    return route?.type === "page" && Object.hasOwn(PAGE_LABELS, route.page)
      ? `page:${route.page}`
      : OTHER_TARGET;
  }

  function describeTarget(target) {
    const [type, name] = target.split(/:(.*)/s);
    if (type === "page") return PAGE_LABELS[name] || "Other pages";
    if (type === "subreddit") return `r/${name}`;
    if (type === "user") return `u/${name}`;
    return "Other pages";
  }

  function dayTotals(day = normalizeDay()) {
    const posts = sum(Object.values(day.posts));
    const comments = sum(Object.values(day.comments));
    return {
      time: day.time,
      visits: day.visits,
      blocked: sum(Object.values(day.blocked)),
      posts,
      comments,
      hidden: posts + comments,
    };
  }

  const byCount = (a, b) => b.count - a.count || a.label.localeCompare(b.label);

  // What the Stats tab shows: today, each of the last 7 days, and what they
  // blocked and hid. The daily average leaves out today, which is not over,
  // and the day counting began, which may have started late; the week
  // before counts only when it was counted in full.
  function summarize(stored, now = Date.now()) {
    const stats = normalizeStats(stored);
    const today = dayKey(now);
    const firstKey = stats.since ? dayKey(stats.since) : today;
    const dayAt = (offset) => {
      const key = shiftDay(today, offset);
      return { key, date: dayDate(key), whole: key > firstKey, ...dayTotals(stats.days[key]) };
    };
    const days = Array.from({ length: 7 }, (_, index) => dayAt(index - 6));
    const previous = Array.from({ length: 7 }, (_, index) => dayAt(index - 13));
    const averageOf = (list) => (list.length ? sum(list.map(({ time }) => time)) / list.length : null);
    const average = averageOf(days.slice(0, -1).filter(({ whole }) => whole));
    const previousAverage = previous.every(({ whole }) => whole) ? averageOf(previous) : null;

    const blocked = {};
    const posts = {};
    const comments = {};
    for (const { key } of days) {
      const day = stats.days[key];
      if (!day) continue;
      addCounts(blocked, day.blocked);
      addCounts(posts, day.posts);
      addCounts(comments, day.comments);
    }
    const week = Object.fromEntries(Object.keys(dayTotals()).map((name) =>
      [name, sum(days.map((day) => day[name]))]));

    return {
      since: stats.since || null,
      today: days.at(-1),
      days,
      week,
      average,
      previousAverage,
      // The change from the week before, as a fraction of it.
      change: average !== null && previousAverage > 0
        ? (average - previousAverage) / previousAverage
        : null,
      blocked: Object.entries(blocked)
        .map(([target, amount]) => ({ target, label: describeTarget(target), count: amount }))
        .sort(byCount),
      hidden: POST_REASONS
        .map((reason) => ({
          reason,
          label: REASON_LABELS[reason],
          posts: posts[reason] || 0,
          comments: comments[reason] || 0,
          count: (posts[reason] || 0) + (comments[reason] || 0),
        }))
        .filter((entry) => entry.count > 0)
        .sort(byCount),
      totals: stats.totals,
    };
  }

  // Durations as the Stats tab shows them: 0 min, < 1 min, 38 min, 1 h 5 min,
  // and in whole hours from 10 hours, grouped as the tab's counts are:
  // 1,234 h. Compact, for the chart: 38m, 1h 5m.
  function formatDuration(ms, { compact = false } = {}) {
    const minutes = Math.floor(count(ms) / 60000);
    const [h, m] = compact ? ["h", "m"] : [" h", " min"];
    if (ms > 0 && minutes === 0) return compact ? `<1${m}` : `< 1${m}`;
    if (minutes < 60) return `${minutes}${m}`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours >= 10 || rest === 0
      ? `${hours.toLocaleString()}${h}`
      : `${hours}${h} ${rest}${m}`;
  }

  return Object.freeze({
    STORAGE_KEY,
    DAYS_KEPT,
    VISIT_GAP,
    POST_REASONS,
    COMMENT_REASONS,
    REASON_LABELS,
    dayKey,
    shiftDay,
    normalizeStats,
    normalizeRecord,
    isEmptyRecord,
    addRecord,
    blockedTarget,
    describeTarget,
    summarize,
    formatDuration,
  });
})();
