/**
 * The statistics recorder alone, for a Reddit page that was open when
 * FrontFilter was installed or updated in Chrome. Chrome gives such a page
 * no content script, so the background script adds this one
 * (background/main.js), after shared/core.js, shared/stats.js and
 * content/stats-recorder.js. It counts the time spent on the page; the
 * filters, and the counts of what they hide, wait for its next load.
 */
(() => {
  let settingsLoaded = false;
  let paused = false;
  const recorder = FrontFilter.createStatsRecorder({ isEnabled: () => settingsLoaded && !paused });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.hasOwn(changes, "pauseStatistics")) return;
    paused = changes.pauseStatistics.newValue === true;
    recorder.update();
  });

  chrome.storage.local.get("pauseStatistics").then(({ pauseStatistics }) => {
    settingsLoaded = true;
    paused = pauseStatistics === true;
    recorder.update();
  }, (error) => {
    console.error("Could not load FrontFilter settings:", error);
  });
})();
