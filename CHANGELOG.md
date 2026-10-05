# Changelog

Notable changes to FrontFilter, newest first.

## 2.3.1 - 2026-10-02

### Changed

- The block page names the rule that blocks a page only when it is a
  pattern, such as `*news*`, and its buttons read **Go back**, **Open
  settings** and **Undo block**.
- In the settings, a subreddit, keyword or flair added twice merges into one
  row, and entries that cannot be used, such as a blocked subreddit with
  spaces or a flair over 100 characters, are explained instead of being
  cleared silently.
- Screen readers no longer announce the FrontFilter logo next to its name.
- FrontFilter does less work on long feeds: it reads a post again only when
  the post or the settings change, and changes to timestamps, counters and
  menus no longer make it go over the page.

### Fixed

- A post that links to a thread in a subreddit blocked in ALL mode is no
  longer hidden as if it were from that subreddit.
- A user profile typed as a subreddit rule, such as `u/name`, is reported as
  invalid instead of blocking or allowing the subreddit r/u, and posts from
  user profiles no longer count as posts from r/u.
- **+ Add current** reports that it found no subreddit on tabs outside
  Reddit, instead of doing nothing.
- In Chrome and Edge, a subreddit rule too complex for the browser to check
  before a page loads, such as a long HOME rule or a pattern with several
  `*` wildcards, no longer stops every other page block, such as Popular,
  from applying. That rule blocks its pages once they load.
- The settings page shows changes made elsewhere while it is open, such as
  with a **Block** button, **Undo block** or another settings window, and
  saving a list there no longer undoes them.

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
