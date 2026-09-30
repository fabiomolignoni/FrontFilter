const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const context = vm.createContext({ FrontFilter: {} });
vm.runInContext(
  readFileSync(join(__dirname, "..", "..", "src", "content", "feed-window.js"), "utf8"),
  context,
);
const create = context.FrontFilter.createFeedWindow;
const eligible = ({ ad, blocked }) => !ad && !blocked;
const posts = (start, count) => Array.from({ length: count }, (_, i) => ({ id: String(start + i) }));
const shown = (feed) => Array.from(feed.snapshot().allowed);

test("fixed mode counts only organic, unfiltered results and ignores oversized batches", () => {
  const feed = create(3, "fixed");
  feed.update([{ id: "ad", ad: true }, { id: "blocked", blocked: true }, ...posts(1, 8)], eligible);
  assert.deepEqual(shown(feed), ["1", "2", "3"]);
  assert.equal(feed.next(), false);
  feed.update(posts(9, 20), eligible);
  assert.deepEqual(shown(feed), ["1", "2", "3"]);
});

test("initial results appear progressively while the quota stays fixed", () => {
  const feed = create(4, "fixed");
  feed.update(posts(1, 2), eligible);
  assert.deepEqual(shown(feed), ["1", "2"]);
  assert.equal(feed.snapshot().pending, true);
  feed.update([{ id: "ad", ad: true }, { id: "bad", blocked: true }], eligible);
  assert.deepEqual(shown(feed), ["1", "2"]);
  feed.update(posts(3, 5), eligible);
  assert.deepEqual(shown(feed), ["1", "2", "3", "4"]);
});

test("one click authorizes exactly one group and reveals its buffered results immediately", () => {
  const feed = create(3, "button");
  feed.update(posts(1, 4), eligible);
  assert.equal(feed.next(), true);
  assert.deepEqual(shown(feed), ["1", "2", "3", "4"]);
  assert.equal(feed.next(), false, "double clicks while loading cannot increase the target");
  feed.update(posts(5, 10), eligible);
  assert.deepEqual(shown(feed), ["1", "2", "3", "4", "5", "6"]);
  feed.next();
  assert.deepEqual(shown(feed), posts(1, 9).map(({ id }) => id));
});

test("rerenders, duplicates, and temporarily unmounted cards do not change the quota", () => {
  const feed = create(3, "button");
  feed.update([...posts(1, 4), ...posts(1, 2)], eligible);
  feed.update(posts(4, 2), eligible);
  assert.deepEqual(shown(feed), ["1", "2", "3"]);
  feed.update(posts(1, 2), eligible);
  assert.deepEqual(shown(feed), ["1", "2", "3"]);
});

test("changing filters reevaluates stored results and fills the same quota", () => {
  const feed = create(3, "fixed");
  feed.update(posts(1, 6), eligible);
  feed.update([], ({ id }) => Number(id) > 2);
  assert.deepEqual(shown(feed), ["3", "4", "5"]);
  feed.update([], eligible);
  assert.deepEqual(shown(feed), ["1", "2", "3"]);
});

test("late classification removes a newly blocked post before replenishing", () => {
  const feed = create(3, "fixed");
  feed.update(posts(1, 3), eligible);
  feed.update([{ id: "2", blocked: true }], eligible);
  assert.deepEqual(shown(feed), ["1", "3"]);
  assert.equal(feed.snapshot().pending, true);
  feed.update(posts(4, 4), eligible);
  assert.deepEqual(shown(feed), ["1", "3", "4"]);
});

test("end of feed releases a partial group explicitly and prevents further expansion", () => {
  const feed = create(3, "button");
  feed.update(posts(1, 5), eligible);
  feed.next();
  feed.end();
  assert.deepEqual(shown(feed), ["1", "2", "3", "4", "5"]);
  assert.equal(feed.snapshot().ended, true);
  assert.equal(feed.next(), false);
});

test("known end of feed can still expand into buffered remaining results", () => {
  const feed = create(3, "button");
  feed.update(posts(1, 5), eligible);
  feed.end();
  assert.deepEqual(shown(feed), ["1", "2", "3"]);
  assert.equal(feed.snapshot().canAdvance, true);
  feed.next();
  assert.deepEqual(shown(feed), ["1", "2", "3", "4", "5"]);
});

test("empty or completely filtered finite feeds terminate without inventing results", () => {
  const feed = create(3, "fixed");
  feed.update([{ id: "ad", ad: true }], eligible);
  feed.end();
  assert.deepEqual(shown(feed), []);
  assert.equal(feed.snapshot().pending, false);
});

test("batch size one and independent feed sessions keep their own counts", () => {
  const first = create(1, "button");
  first.update(posts(1, 3), eligible);
  first.next();
  const second = create(1, "button");
  second.update(posts(10, 5), eligible);
  assert.deepEqual(shown(first), ["1", "2"]);
  assert.deepEqual(shown(second), ["10"]);
});

test("a large quota does not hold back available posts in either mode", () => {
  for (const mode of ["fixed", "button"]) {
    const feed = create(100, mode);
    feed.update(posts(1, 20), eligible);
    assert.deepEqual(shown(feed), posts(1, 20).map(({ id }) => id));
    assert.equal(feed.snapshot().target, 100);
    assert.equal(feed.next(), false);
    feed.update(posts(21, 150), eligible);
    assert.equal(shown(feed).length, 100);
  }
});
