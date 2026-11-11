const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { runScripts } = require("./helpers");

function loadStats() {
  const context = vm.createContext({ URL, URLSearchParams });
  runScripts(context, ["shared/core.js", "shared/stats.js"]);
  return context.FrontFilter.stats;
}

const STATS = loadStats();
const MINUTE = 60 * 1000;
// Wednesday, November 11, 2026, at noon, local time.
const NOW = new Date(2026, 10, 11, 12).getTime();
const at = (day, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const plain = (value) => JSON.parse(JSON.stringify(value));

// Adds records in order, each at its time.
function build(records) {
  return records.reduce((stats, [time, record]) => STATS.addRecord(stats, record, time), undefined);
}

test("names days by their local calendar date, across months and daylight saving", () => {
  assert.equal(STATS.dayKey(NOW), "2026-11-11");
  assert.equal(STATS.dayKey(new Date(2026, 0, 1, 0, 0).getTime()), "2026-01-01");
  assert.equal(STATS.shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(STATS.shiftDay("2026-12-31", 1), "2027-01-01");
  // Days stay whole where clocks change, in March and October in Europe.
  assert.equal(STATS.shiftDay("2026-03-29", 1), "2026-03-30");
  assert.equal(STATS.shiftDay("2026-10-25", -1), "2026-10-24");
});

test("adds time and counts, with totals since counting began", () => {
  const stats = build([
    [at(10, 9), { time: 2 * MINUTE, posts: { keywords: 3, nsfw: 1 }, blocked: { "page:homepage": 1 } }],
    [at(11, 9), { time: MINUTE, comments: { users: 2 }, blocked: { "subreddit:news": 2 } }],
  ]);
  assert.equal(stats.since, at(10, 9));
  assert.deepEqual(plain(stats.days["2026-11-10"]), {
    time: 2 * MINUTE, visits: 1, blocked: { "page:homepage": 1 },
    posts: { keywords: 3, nsfw: 1 }, comments: {},
  });
  assert.deepEqual(plain(stats.days["2026-11-11"]), {
    time: MINUTE, visits: 1, blocked: { "subreddit:news": 2 },
    posts: {}, comments: { users: 2 },
  });
  assert.deepEqual(plain(stats.totals), { time: 3 * MINUTE, visits: 2, blocked: 3, posts: 4, comments: 2 });
});

test("starts a new visit only after 10 minutes without time on Reddit", () => {
  const stats = build([
    [at(11, 9, 1), { time: MINUTE }],
    // Its minute began right as the last ended: the same visit.
    [at(11, 9, 2), { time: MINUTE }],
    // 9 minutes away.
    [at(11, 9, 12), { time: MINUTE }],
    // 11 minutes away.
    [at(11, 9, 24), { time: MINUTE }],
    // Counts alone start no visit.
    [at(11, 10), { posts: { ads: 1 } }],
    [at(11, 10, 1), { time: MINUTE }],
  ]);
  assert.equal(stats.days["2026-11-11"].visits, 3);
  assert.equal(stats.totals.visits, 3);
  assert.equal(stats.lastActiveAt, at(11, 10, 1));
});

test("leaves out what a page could not have recorded", () => {
  const stats = build([[NOW, {
    time: 2 * 60 * MINUTE,
    posts: { keywords: -1, unknown: 5, ads: "3", nsfw: 2.7 },
    comments: { nsfw: 1, keywords: Infinity },
    blocked: { "page:settings": 1, "subreddit:News": 1, "user:a b": 1, "page:popular": 1 },
  }]]);
  const day = stats.days["2026-11-11"];
  // A page sends its time at least every minute: longer is capped.
  assert.equal(day.time, 15 * MINUTE);
  assert.deepEqual(plain(day.posts), { nsfw: 2 });
  assert.deepEqual(plain(day.comments), {});
  assert.deepEqual(plain(day.blocked), { "page:popular": 1 });

  for (const record of [undefined, null, [], { time: 0 }, { posts: { unknown: 1 } }]) {
    assert.equal(STATS.isEmptyRecord(record), true, JSON.stringify(record));
    assert.deepEqual(plain(STATS.addRecord(undefined, record, NOW)).days, {});
  }
});

test("keeps daily figures for 30 days, and the totals for good", () => {
  const records = [];
  for (let day = 0; day < 40; day += 1) {
    records.push([NOW - day * 24 * 60 * MINUTE, { posts: { ads: 1 } }]);
  }
  const stats = build(records.reverse());
  const days = Object.keys(stats.days).sort();
  assert.equal(days.length, 30);
  assert.equal(days[0], "2026-10-13");
  assert.equal(days.at(-1), "2026-11-11");
  assert.equal(stats.totals.posts, 40);
});

test("counts blocked pages past 100 a day together", () => {
  const blocked = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`subreddit:sub${index}`, 1]));
  const stats = build([[NOW, { blocked }], [NOW, { blocked: { "subreddit:sub0": 1, "subreddit:new": 2 } }]]);
  const day = stats.days["2026-11-11"];
  assert.equal(Object.keys(day.blocked).length, 101);
  assert.equal(day.blocked.other, 7);
  assert.equal(day.blocked["subreddit:sub0"], 2);
  assert.equal(stats.totals.blocked, 108);
});

test("reads malformed or later statistics without failing", () => {
  for (const stored of [undefined, null, "stats", [], { days: [] }, { days: { soon: {} }, totals: "x" }]) {
    const stats = STATS.normalizeStats(stored);
    assert.deepEqual(plain(stats.days), {}, JSON.stringify(stored));
    assert.deepEqual(plain(stats.totals), { time: 0, visits: 0, blocked: 0, posts: 0, comments: 0 });
  }
  const stats = STATS.normalizeStats({
    since: NOW, futureField: true,
    days: { "2026-11-11": { time: MINUTE, visits: "2", blocked: { "page:x": 1 }, posts: { ads: 1, later: 2 } } },
  });
  assert.equal("futureField" in stats, false);
  assert.deepEqual(plain(stats.days["2026-11-11"]), {
    time: MINUTE, visits: 0, blocked: {}, posts: { ads: 1 }, comments: {},
  });
});

function pageRoute(page) {
  return { type: "page", page };
}

test("names blocked pages by what they belong to", () => {
  const { blockedTarget, describeTarget } = STATS;
  assert.equal(blockedTarget({ type: "page", page: "homepage" }), "page:homepage");
  assert.equal(blockedTarget({ type: "page", page: "unknown" }), "other");
  assert.equal(blockedTarget({ type: "subreddit", subreddit: "News", filter: "new*" }), "subreddit:news");
  // Navigation rules cannot name a pattern's subreddit: the address does.
  assert.equal(blockedTarget({ type: "subreddit" }, "/r/AskReddit/top/"), "subreddit:askreddit");
  assert.equal(blockedTarget({ type: "user", user: "Spez" }), "user:spez");
  // Every subreddit's front page counts as the one it was.
  assert.equal(blockedTarget(pageRoute("subhome"), "/r/pics/"), "subreddit:pics");
  assert.equal(blockedTarget(pageRoute("subhome"), ""), "page:subhome");
  assert.equal(blockedTarget(null), "other");

  assert.equal(describeTarget("page:homepage"), "Homepage");
  assert.equal(describeTarget("page:subhome"), "Subreddit front pages");
  assert.equal(describeTarget("subreddit:news"), "r/news");
  assert.equal(describeTarget("user:spez"), "u/spez");
  assert.equal(describeTarget("other"), "Other pages");
});

test("summarizes today, the last 7 days and what they blocked and hid", () => {
  const records = [];
  // Counting began late on November 1.
  records.push([at(1, 23), { time: MINUTE }]);
  for (let day = 2; day <= 10; day += 1) {
    records.push([at(day), { time: (day <= 3 ? 5 : 10) * MINUTE }]);
  }
  records.push([at(11, 9), { time: 5 * MINUTE }]);
  records.push([at(5), { blocked: { "page:homepage": 2, "subreddit:news": 3 } }]);
  records.push([at(11), { blocked: { "page:homepage": 2 }, posts: { keywords: 4, ads: 1 }, comments: { keywords: 2 } }]);
  // Before the last 7 days.
  records.push([at(4), { blocked: { "user:spez": 9 }, posts: { nsfw: 9 } }]);
  const summary = STATS.summarize(build(records), NOW);

  assert.equal(summary.since, at(1, 23));
  assert.deepEqual(plain(summary.days.map(({ key }) => key)), [
    "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11",
  ]);
  assert.equal(summary.days[0].date.getDate(), 5);
  assert.deepEqual(plain(summary.today), {
    key: "2026-11-11", date: summary.today.date.toISOString(), whole: true,
    time: 5 * MINUTE, visits: 1, blocked: 2, posts: 5, comments: 2, hidden: 7,
  });
  assert.deepEqual(plain(summary.week), {
    time: 65 * MINUTE, visits: 7, blocked: 7, posts: 5, comments: 2, hidden: 7,
  });
  // The daily average leaves out today; the week before had not been
  // counted in full.
  assert.equal(summary.average, 10 * MINUTE);
  assert.equal(summary.previousAverage, null);
  assert.equal(summary.change, null);
  assert.deepEqual(plain(summary.blocked), [
    { target: "page:homepage", label: "Homepage", count: 4 },
    { target: "subreddit:news", label: "r/news", count: 3 },
  ]);
  assert.deepEqual(plain(summary.hidden), [
    { reason: "keywords", label: "Keywords", posts: 4, comments: 2, count: 6 },
    { reason: "ads", label: "Ads", posts: 1, comments: 0, count: 1 },
  ]);
  assert.deepEqual(plain(summary.totals), { time: 86 * MINUTE, visits: 11, blocked: 16, posts: 14, comments: 2 });
});

test("compares the daily average with a week before counted in full", () => {
  // Counting began on November 1, then 12 minutes a day to the 11th.
  const records = [[at(1), { posts: { ads: 1 } }]];
  for (let day = 2; day <= 11; day += 1) records.push([at(day), { time: 12 * MINUTE }]);
  const stats = build(records);

  // On the 8th: November 2 to 7, and a week before begun on November 1.
  let summary = STATS.summarize(stats, at(8));
  assert.equal(summary.average, 12 * MINUTE);
  assert.equal(summary.previousAverage, null);
  assert.equal(summary.change, null);

  // On the 16th: November 10 to 15, 2 days of 6, against November 3 to 9.
  summary = STATS.summarize(stats, at(16));
  assert.equal(summary.average, 4 * MINUTE);
  assert.equal(summary.previousAverage, 12 * MINUTE);
  assert.equal(Math.round(summary.change * 100), -67);

  // On the 22nd: no time, against 3 days of November 9 to 15.
  summary = STATS.summarize(stats, at(22));
  assert.equal(summary.average, 0);
  assert.equal(summary.previousAverage, (3 * 12 * MINUTE) / 7);
  assert.equal(summary.change, -1);
});

test("summarizes no statistics as empty days", () => {
  const summary = STATS.summarize(undefined, NOW);
  assert.equal(summary.since, null);
  assert.equal(summary.days.length, 7);
  assert.equal(summary.days.every(({ time, hidden }) => time === 0 && hidden === 0), true);
  // Counting has not begun: no day of the week was counted in full.
  assert.equal(summary.average, null);
  assert.equal(summary.change, null);
  assert.deepEqual(plain(summary.blocked), []);
  assert.deepEqual(plain(summary.hidden), []);
});

test("formats durations in minutes, then hours", () => {
  const cases = [
    [0, "0 min", "0m"],
    [20 * 1000, "< 1 min", "<1m"],
    [59 * 1000, "< 1 min", "<1m"],
    [38 * MINUTE + 30 * 1000, "38 min", "38m"],
    [60 * MINUTE, "1 h", "1h"],
    [65 * MINUTE, "1 h 5 min", "1h 5m"],
    [9 * 60 * MINUTE + 59 * MINUTE, "9 h 59 min", "9h 59m"],
    [10 * 60 * MINUTE + 30 * MINUTE, "10 h", "10h"],
    [-5, "0 min", "0m"],
  ];
  for (const [ms, full, compact] of cases) {
    assert.equal(STATS.formatDuration(ms), full, String(ms));
    assert.equal(STATS.formatDuration(ms, { compact: true }), compact, String(ms));
  }
});
