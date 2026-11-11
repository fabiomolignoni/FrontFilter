/**
 * The settings page's Stats tab: today's figures, the last 7 days and the
 * statistics' own controls. It shows the statistics as stored, and again
 * whenever they change or the tab is opened. Its switch is a setting like
 * any other, which popup.js saves.
 */
FrontFilter.createStatsTab = function ({ showToast }) {
  const STATS = FrontFilter.stats;
  const byId = (id) => document.getElementById(id);
  const tiles = ["time", "visits", "blocked", "hidden"].map((name) => ({
    name, value: byId(`stat-${name}`), week: byId(`stat-${name}-week`),
  }));
  const chart = byId("time-chart");
  const readout = { label: byId("chart-readout-label"), value: byId("chart-readout-value") };
  const change = byId("chart-change");
  const blockedRanking = byId("blocked-ranking");
  const hiddenRanking = byId("hidden-ranking");
  const paused = byId("stats-paused");
  const since = byId("stats-since");
  const reset = {
    button: byId("reset-stats"),
    confirm: byId("reset-stats-confirm"),
    question: byId("reset-stats-question"),
    remove: byId("reset-stats-delete"),
    cancel: byId("reset-stats-cancel"),
  };
  // A ranking of blocked pages shows its first; the others count together.
  const RANKED = 5;
  const numbers = new Intl.NumberFormat();
  let summary = STATS.summarize(undefined);
  let loadId = 0;
  // The day the chart's readout shows, or -1 for its summary, and the day
  // that keyboard focus enters the chart on: today, at first.
  let shownDay = -1;
  let focusDay = summary.days.length - 1;

  const formatCount = (count) => numbers.format(count);
  const formatCounted = (count, one, other) => `${formatCount(count)} ${count === 1 ? one : other}`;
  const formatDay = (date, weekday = "long") =>
    date.toLocaleDateString(undefined, { weekday, month: "short", day: "numeric" });

  function element(tagName, className, text) {
    const created = document.createElement(tagName);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  }

  function renderTiles() {
    const format = {
      time: (ms) => STATS.formatDuration(ms),
      visits: formatCount,
      blocked: formatCount,
      hidden: formatCount,
    };
    for (const { name, value, week } of tiles) {
      value.textContent = format[name](summary.today[name]);
      week.textContent = `${format[name](summary.week[name])} in 7 days`;
    }
  }

  // The readout says what the pointer or the focus is on, and otherwise
  // the daily average, or today's time until there is one.
  function showDay(index) {
    shownDay = index;
    const day = summary.days[index];
    // The change from the week before is the average's: it makes way, in
    // place, while the readout shows a day.
    change.style.visibility = day ? "hidden" : "";
    if (day) {
      readout.label.textContent = formatDay(day.date, "short");
      readout.value.textContent = STATS.formatDuration(day.time);
    } else if (summary.average !== null) {
      readout.label.textContent = "Daily average";
      readout.value.textContent = STATS.formatDuration(summary.average);
    } else {
      readout.label.textContent = "Today";
      readout.value.textContent = STATS.formatDuration(summary.today.time);
    }
  }

  function moveFocus(index) {
    const items = chart.querySelectorAll(".chart-day");
    focusDay = Math.max(0, Math.min(index, items.length - 1));
    items.forEach((item, other) => { item.tabIndex = other === focusDay ? 0 : -1; });
    items[focusDay].focus();
  }

  function createDay(day, index, { max, busiest }) {
    const today = index === summary.days.length - 1;
    const item = element("li", today ? "chart-day today" : "chart-day");
    item.tabIndex = index === focusDay ? 0 : -1;
    item.setAttribute("aria-label", `${formatDay(day.date)}: ${STATS.formatDuration(day.time)}, `
      + formatCounted(day.visits, "visit", "visits"));
    // Only today and the busiest day carry their values; the readout and
    // each day's label give the others.
    const labelled = (today || index === busiest) && day.time > 0;
    const value = element("span", "chart-value");
    if (labelled) {
      // A narrow chart leaves the minutes out, so that two values side by
      // side stay apart (popup.css).
      const [hours, minutes] = STATS.formatDuration(day.time, { compact: true }).split(" ");
      value.append(hours);
      if (minutes) value.append(element("span", "chart-minutes", ` ${minutes}`));
    }
    const track = element("span", "chart-track");
    const bar = element("span", "chart-bar");
    // A day with any time shows, however short it is.
    bar.style.height = max > 0 && day.time > 0 ? `${Math.max((day.time / max) * 100, 3)}%` : "0";
    track.append(bar);
    const weekday = day.date.toLocaleDateString(undefined, { weekday: "short" });
    item.append(value, track, element("span", "chart-label", weekday));
    for (const enter of ["pointerenter", "focus"]) item.addEventListener(enter, () => showDay(index));
    for (const leave of ["pointerleave", "blur"]) item.addEventListener(leave, () => showDay(-1));
    item.addEventListener("focus", () => { focusDay = index; });
    item.addEventListener("keydown", (event) => {
      const last = summary.days.length - 1;
      const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      moveFocus(next);
    });
    return item;
  }

  function renderChart() {
    const { days } = summary;
    const max = Math.max(...days.map(({ time }) => time));
    const busiest = max > 0 ? days.findIndex(({ time }) => time === max) : -1;
    const items = Array.from(chart.querySelectorAll(".chart-day"));
    const focused = items.indexOf(document.activeElement);
    chart.replaceChildren(...days.map((day, index) => createDay(day, index, { max, busiest })));
    if (focused !== -1) moveFocus(focused);
    showDay(shownDay);

    change.hidden = summary.change === null;
    if (change.hidden) return;
    const percent = Math.round(Math.abs(summary.change) * 100);
    change.textContent = percent === 0
      ? "About the same as the week before"
      : `${formatCount(percent)}% ${summary.change < 0 ? "less" : "more"} than the week before`;
  }

  // Ranked bars, longest first. A ranking that can grow long folds the
  // rest into one row.
  function renderRanking(list, entries, emptyMessage, { fold = false } = {}) {
    if (entries.length === 0) {
      list.replaceChildren(element("li", "empty-state", emptyMessage));
      return;
    }
    const shown = fold && entries.length > RANKED + 1 ? entries.slice(0, RANKED) : entries;
    const rest = entries.slice(shown.length);
    const rows = rest.length === 0 ? shown : [...shown, {
      label: `${rest.length} more`,
      count: rest.reduce((total, entry) => total + entry.count, 0),
    }];
    const max = Math.max(...rows.map(({ count }) => count));
    list.replaceChildren(...rows.map(({ label, detail, count }) => {
      const row = element("li", "rank-row");
      const name = element("span", "rank-name");
      name.append(element("span", "rank-label", label));
      if (detail) name.append(element("span", "rank-detail", detail));
      const meter = element("span", "rank-meter");
      const bar = element("span", "rank-bar");
      bar.style.width = `${Math.max((count / max) * 100, 2)}%`;
      meter.append(bar);
      row.append(name, meter, element("span", "rank-count", formatCount(count)));
      return row;
    }));
  }

  function describeHidden({ posts, comments }) {
    return [
      posts > 0 && formatCounted(posts, "post", "posts"),
      comments > 0 && formatCounted(comments, "comment", "comments"),
    ].filter(Boolean).join(", ");
  }

  function renderTotals() {
    const { totals } = summary;
    if (!summary.since) {
      since.textContent = "Nothing counted yet";
      return;
    }
    const date = new Date(summary.since).toLocaleDateString(undefined, { dateStyle: "medium" });
    since.textContent = `Since ${date}: ${STATS.formatDuration(totals.time)} on Reddit, `
      + `${formatCounted(totals.blocked, "page", "pages")} blocked, `
      + `${formatCount(totals.posts + totals.comments)} hidden`;
  }

  function render(isPaused) {
    paused.hidden = !isPaused;
    renderTiles();
    renderChart();
    renderRanking(blockedRanking, summary.blocked, "Nothing blocked in the last 7 days", { fold: true });
    renderRanking(
      hiddenRanking,
      summary.hidden.map((entry) => ({ ...entry, detail: describeHidden(entry) })),
      "Nothing hidden in the last 7 days",
    );
    renderTotals();
  }

  // Reads can finish out of order: only the latest is shown.
  async function load() {
    const id = ++loadId;
    try {
      const key = STATS.STORAGE_KEY;
      const { [key]: stored, pauseStatistics } = await chrome.storage.local.get([key, "pauseStatistics"]);
      if (id !== loadId) return;
      summary = STATS.summarize(stored, Date.now());
      render(pauseStatistics === true);
    } catch (error) {
      console.error("Could not load FrontFilter statistics:", error);
    }
  }

  function closeConfirm() {
    reset.confirm.hidden = true;
    reset.button.focus();
  }

  // The background keeps the statistics, so it also deletes them: a record
  // it is adding cannot then bring them back.
  async function resetStats() {
    reset.confirm.hidden = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: "resetStats" });
      if (!response?.success) throw new Error(response?.error || "no answer");
      showToast("Statistics deleted", "success");
    } catch (error) {
      showToast(`Could not delete statistics: ${error.message}`, "error");
    }
    reset.button.focus();
    await load();
  }

  reset.button.addEventListener("click", () => {
    reset.confirm.hidden = false;
    reset.question.focus();
  });
  reset.cancel.addEventListener("click", closeConfirm);
  reset.remove.addEventListener("click", resetStats);
  // Escape cancels rather than closing the popup.
  reset.confirm.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeConfirm();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.hasOwn(changes, STATS.STORAGE_KEY) || Object.hasOwn(changes, "pauseStatistics")) {
      void load();
    }
  });
  // Today may have become another day since the page opened.
  byId("tab-stats").addEventListener("click", () => void load());
  render(false);
  return { load };
};
