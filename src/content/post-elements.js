/**
 * Shared selectors for extracting user-visible text from Reddit posts.
 * Keep markup compatibility in one place for both filtering implementations.
 */
FrontFilter.POST_SELECTORS = Object.freeze({
  title: [
    '[slot="title"]',
    '[data-testid="post-title"]',
    '[data-testid="post-title-text"]',
    '[data-adclicklocation="title"]',
    'a[id^="post-title"]',
    "a.title",
    'h1[id^="post-title"]',
    "h2",
    "h3",
  ].join(", "),
  body: [
    '[slot="text-body"]',
    '[data-post-click-location="text-body"]',
    '[data-testid="post-content"]',
    '[data-testid="post-body"]',
    '[data-click-id="text"]',
    "shreddit-post-text-body",
    ".usertext-body .md",
  ].join(", "),
});
