/**
 * Records this page's statistics and sends them to the background script,
 * which keeps them (shared/stats.js): the time Reddit is used here, and
 * what FrontFilter blocked and hid on it.
 *
 * Time counts while the page is in front, in the focused window, and was
 * scrolled, clicked, touched or typed in recently: reading pauses input
 * for a while, but a page left open is not being read. Records are held
 * back and sent at most about once a minute, and when the page stops
 * counting, as when another tab or window is in front.
 */
FrontFilter.createStatsRecorder = function ({ isEnabled }) {
  // Time stops counting this long after the last input.
  const IDLE_AFTER = 3 * 60 * 1000;
  const TICK = 10 * 1000;
  // Time is sent once this much has added up; counts this long after the
  // first one.
  const SEND_TIME_AFTER = 60 * 1000;
  const SEND_COUNTS_AFTER = 5 * 1000;
  const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];
  let record = emptyRecord();
  let lastInput = Date.now();
  // When the time not yet added began to count, or 0 while it does not.
  let countingSince = 0;
  let tickTimer = null;
  let sendTimer = null;

  function emptyRecord() {
    return { time: 0, posts: {}, comments: {}, blocked: {} };
  }

  function isCounting(now) {
    return isEnabled()
      && document.visibilityState === "visible"
      && document.hasFocus()
      && now - lastInput < IDLE_AFTER;
  }

  // Adds the time counted until now, or until the page went idle, and
  // starts or stops counting.
  function update() {
    const now = Date.now();
    if (countingSince) {
      const end = Math.min(now, lastInput + IDLE_AFTER);
      // A computer that slept with the page in front adds no time.
      record.time += Math.min(Math.max(end - countingSince, 0), 2 * TICK);
    }
    const counting = isCounting(now);
    countingSince = counting ? now : 0;
    if (counting && !tickTimer) {
      tickTimer = setInterval(update, TICK);
    } else if (!counting && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (!counting || record.time >= SEND_TIME_AFTER) send();
  }

  function send() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (FrontFilter.stats.isEmptyRecord(record)) return;
    const message = { action: "recordStats", record };
    record = emptyRecord();
    try {
      // A page left open while the extension updates can no longer send.
      void chrome.runtime.sendMessage(message)?.catch?.(() => undefined);
    } catch {
      // The record is lost; counting goes on.
    }
  }

  function add(group, name) {
    if (!isEnabled()) return;
    record[group][name] = (record[group][name] || 0) + 1;
    sendTimer ??= setTimeout(send, SEND_COUNTS_AFTER);
  }

  function onInput() {
    lastInput = Date.now();
    if (!countingSince) update();
  }

  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pagehide", () => {
    update();
    send();
  });

  return {
    // Call when the settings change, as they may pause statistics.
    update,
    countPost: (reason) => add("posts", reason),
    countComment: (reason) => add("comments", reason),
    countBlocked: (target) => add("blocked", target),
    // Sends what is held back now, as before leaving the page.
    send,
  };
};
