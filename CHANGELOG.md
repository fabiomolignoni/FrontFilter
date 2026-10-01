# Changelog

Notable changes to FrontFilter, newest first.

## 2.3.0 - 2026-10-01

### Added

- FrontFilter is available for Microsoft Edge 121 or later, from Microsoft
  Edge Add-ons.

### Changed

- A group's main switch, such as **Hide navbar**, shows a mixed state while
  only some of its parts are hidden, instead of a summary. Turning it off
  turns its parts off too, comment replies included.
- Each subreddit has at most one block rule. When rules for the same
  subreddit differ, ALL wins over HOME, and a one-click **Block** turns a
  HOME rule into ALL; undo turns it back.

### Fixed

- Turning **Disable video autoplay** off starts videos already on screen,
  and later ones as they scroll into view.
- **Hide usernames** no longer hides the post author's avatar in subreddit
  feeds.

## 2.2.0 - 2026-10-01

### Added

- Hide ads and promoted posts.
- Hide votes, karma, awards, avatars and usernames, all at once or one by one.
- Hide suggested posts in the Home feed: posts from communities you have not
  joined.
- Hide posts by flair, with `*` wildcards.
- Keyword filters also hide the comments that contain a keyword, with their
  replies.
- Optional one-click **Block** buttons on feed posts and subreddit pages, with
  undo.

### Changed

- Grouped controls, such as the navbar and left sidebar sections, collapse
  under their main switch and summarize what they hide.
- Links point to the project's new repository, and the privacy policy is
  rewritten.

### Fixed

- Comments that link to a subreddit blocked in ALL mode are no longer hidden.
- Hidden parts of Reddit, such as the navbar or ads, no longer show briefly
  while a page loads.
